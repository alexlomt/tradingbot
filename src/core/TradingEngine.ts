import {
    Connection,
    Keypair,
    PublicKey,
    TransactionInstruction,
    VersionedTransaction,
    ComputeBudgetProgram
} from '@solana/web3.js';
import {
    Liquidity,
    Token,
    TokenAmount,
    ZERO,
    Percent,
    Currency,
    LiquidityPoolKeysV4,
    Market,
    MAINNET_PROGRAM_ID
} from '@raydium-io/raydium-sdk';
import {
    TradingStrategyConfig,
    TradingPair,
    TradeExecutionContext,
    MarketState,
    UserSubscription,
    TradeEvent,
    RiskManagementConfig,
    TransactionConfig,
    TransactionResult,
    PoolState,
    TradeMetrics
} from '../../types/trading.types';
import { TransactionManager } from './TransactionManager';
import { PoolAnalyzer } from './PoolAnalyzer';
import { PerformanceMonitor } from '../../utils/performance';
import { ErrorReporter } from '../../utils/errorReporting';
import { logger } from '../../utils/logger';
import { Mutex } from 'async-mutex';
import { TokenValidator } from '../../utils/TokenValidator';
import { SubscriptionValidator } from '../subscription/SubscriptionValidator';
import { MarketDataService } from '../market/MarketDataService';
import { RiskManager } from '../risk/RiskManager';
import { TokenPairService } from '../token/TokenPairService';
import { ExecutionStrategyService } from '../execution/ExecutionStrategyService';
import { PoolFilterService } from '../pool/PoolFilterService';
import { MarketEventService } from '../market/MarketEventService';
import { SnipeListService } from '../snipe/SnipeListService';
import { PoolCache } from '../cache/PoolCache';
import { MarketCache } from '../cache/MarketCache';
import BN from 'bn.js';
import { EventEmitter } from 'events';
import { 
    TOKEN_PROGRAM_ID, 
    AccountLayout, 
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    getAccount,
    getAssociatedTokenAddress
} from '@solana/spl-token';

export class TradingEngine extends EventEmitter {
    private readonly mutex: Mutex;
    private readonly activePositions: Map<string, TradeExecutionContext>;
    private readonly positionMonitors: Map<string, NodeJS.Timer>;
    private readonly dailyStats: Map<string, {
        trades: number;
        volume: BN;
        pnl: BN;
        lastReset: Date;
    }>;
    private readonly executionTimes: Map<string, number>;
    private readonly poolCache: PoolCache;
    private readonly marketCache: MarketCache;
    private isRunning: boolean = false;
    private sellExecutionCount: number = 0;

    constructor(
        private readonly connection: Connection,
        private readonly wallet: Keypair,
        private readonly txManager: TransactionManager,
        private readonly poolAnalyzer: PoolAnalyzer,
        private readonly config: TradingStrategyConfig,
        private readonly subscriptionValidator: SubscriptionValidator,
        private readonly marketDataService: MarketDataService,
        private readonly riskManager: RiskManager,
        private readonly tokenValidator: TokenValidator,
        private readonly tokenPairService: TokenPairService,
        private readonly executionService: ExecutionStrategyService,
        private readonly poolFilterService: PoolFilterService,
        private readonly marketEventService: MarketEventService,
        private readonly snipeListService: SnipeListService
    ) {
        super();
        this.mutex = new Mutex();
        this.activePositions = new Map();
        this.positionMonitors = new Map();
        this.dailyStats = new Map();
        this.executionTimes = new Map();
        this.poolCache = new PoolCache();
        this.marketCache = new MarketCache(connection);
        this.initializeEventListeners();
    }

    private initializeEventListeners(): void {
        this.on('trade:executed', this.handleTradeExecution.bind(this));
        this.on('position:update', this.handlePositionUpdate.bind(this));
        this.on('risk:alert', this.handleRiskAlert.bind(this));
        this.on('pool:traded', this.handlePoolTraded.bind(this));
        this.txManager.addTradeEventHandler(this.handleTradeEvent.bind(this));

        this.marketEventService.on('market:update', async (event) => {
            try {
                await this.handleMarketUpdate(event);
            } catch (error) {
                logger.error('Error handling market update:', error);
                ErrorReporter.reportError(error, {
                    context: 'TradingEngine.handleMarketUpdate',
                    event: JSON.stringify(event)
                });
            }
        });

        this.marketEventService.on('pool:new', async (event) => {
            try {
                await this.handleNewPool(event);
            } catch (error) {
                logger.error('Error handling new pool:', error);
                ErrorReporter.reportError(error, {
                    context: 'TradingEngine.handleNewPool',
                    event: JSON.stringify(event)
                });
            }
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('Trading engine is already running');
            return;
        }

        try {
            await this.validateSystemState();
            
            if (this.config.preLoadExistingMarkets) {
                await this.preloadMarkets();
            }

            this.isRunning = true;

            await this.marketEventService.start({
                walletPublicKey: this.wallet.publicKey,
                quoteToken: this.tokenPairService.USDC,
                autoSell: this.config.autoSell,
                cacheNewMarkets: this.config.cacheNewMarkets,
                startTimestamp: Math.floor(Date.now() / 1000)
            });

            await this.startTradingLoop();
            logger.info('Trading engine started successfully');
        } catch (error) {
            this.isRunning = false;
            logger.error('Failed to start trading engine:', error);
            ErrorReporter.reportError(error, {
                context: 'TradingEngine.start'
            });
            throw error;
        }
    }

    private async preloadMarkets(): Promise<void> {
        try {
            logger.info('Preloading existing markets...');
            const markets = await this.marketDataService.getAllMarkets();
            
            for (const market of markets) {
                await this.marketCache.add(market.address, market);
                const poolState = await this.poolAnalyzer.getPoolState(market.address);
                if (poolState) {
                    await this.poolCache.add(market.address.toString(), poolState);
                }
            }
            
            logger.info(`Preloaded ${markets.length} markets`);
        } catch (error) {
            logger.error('Error preloading markets:', error);
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        this.marketEventService.stop();
        
        for (const [address, monitor] of this.positionMonitors) {
            clearInterval(monitor);
            this.positionMonitors.delete(address);
        }
        
        await this.closeAllPositions();
        this.removeAllListeners();
        logger.info('Trading engine stopped');
    }

        async executeBuy(
        pair: TradingPair,
        userId: string,
        context?: Partial<TradeExecutionContext>
    ): Promise<boolean> {
        const release = await this.mutex.acquire();

        try {
            if (this.config.oneTokenAtTime && this.activePositions.size > 0) {
                logger.debug('Skipping buy - one token at time mode active');
                return false;
            }

            const permissions = await this.subscriptionValidator.validateTrading(userId, pair);
            if (!permissions.canTrade) {
                logger.warn(`User ${userId} does not have permission to trade ${pair.baseToken.symbol}`);
                return false;
            }

            if (this.config.useSnipeList && 
                !this.snipeListService.isTokenInSnipeList(pair.baseToken.mint)) {
                logger.debug(`Token ${pair.baseToken.symbol} not in snipe list`);
                return false;
            }

            const dailyStats = this.getDailyStats(userId);
            if (dailyStats.trades >= permissions.remainingDailyTrades) {
                logger.warn(`Daily trade limit reached for user ${userId}`);
                return false;
            }

            if (!(await this.validateTradePrerequisites(pair, userId))) {
                return false;
            }

            const subscription = await this.subscriptionValidator.getActiveSubscription(userId);
            const executionContext: TradeExecutionContext = {
                pair,
                side: 'buy',
                amount: pair.quoteAmount,
                slippage: new Percent(this.config.buySlippage),
                timestamp: new Date(),
                userSubscription: subscription,
                txConfig: this.buildTransactionConfig(subscription),
                positionId: `${userId}-${pair.lpAddress.toString()}-${Date.now()}`,
                ...context
            };

            if (!await this.riskManager.validateTrade(executionContext)) {
                logger.warn('Trade rejected by risk management');
                return false;
            }

            const poolKeys = await this.poolAnalyzer.getPoolKeys(pair.lpAddress);
            if (!await this.poolFilterService.validatePool(pair.lpAddress, poolKeys)) {
                logger.warn('Pool validation failed');
                return false;
            }

            const instructions = await this.buildBuyInstructions(executionContext);
            
            // Add compute budget instruction if needed
            if (!this.config.useCustomFee) {
                instructions.unshift(
                    ComputeBudgetProgram.setComputeUnitLimit({
                        units: this.config.computeUnitLimit
                    }),
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: this.config.computeUnitPrice
                    })
                );
            }

            const transaction = await this.txManager.createTransaction(instructions);

            // Execute with retries
            let result: TransactionResult | null = null;
            for (let attempt = 1; attempt <= this.config.maxBuyRetries; attempt++) {
                try {
                    result = await this.executionService.executeTransaction(
                        transaction,
                        this.wallet,
                        {
                            ...executionContext.txConfig,
                            attempt
                        }
                    );

                    if (result.success) {
                        await this.handleSuccessfulBuy(executionContext, result);
                        return true;
                    }

                    logger.debug(`Buy attempt ${attempt} failed: ${result.error}`);
                    await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                } catch (error) {
                    logger.error(`Buy attempt ${attempt} error:`, error);
                    if (attempt === this.config.maxBuyRetries) {
                        ErrorReporter.reportError(error, {
                            context: 'TradingEngine.executeBuy',
                            attempt,
                            pair: pair.lpAddress.toString()
                        });
                    }
                }
            }

            return false;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'TradingEngine.executeBuy',
                userId,
                pair: pair.lpAddress.toString()
            });
            return false;
        } finally {
            release();
        }
    }

    async executeSell(
        lpAddress: PublicKey,
        userId: string,
        context?: Partial<TradeExecutionContext>
    ): Promise<boolean> {
        const position = this.activePositions.get(`${userId}-${lpAddress.toString()}`);
        if (!position) {
            logger.warn('No active position found for:', lpAddress.toString());
            return false;
        }

        const release = await this.mutex.acquire();

        try {
            const subscription = await this.subscriptionValidator.getActiveSubscription(userId);
            const executionContext: TradeExecutionContext = {
                ...position,
                side: 'sell',
                timestamp: new Date(),
                userSubscription: subscription,
                slippage: new Percent(this.config.sellSlippage),
                ...context
            };

            const baseBalance = await this.tokenPairService.getTokenBalance(
                position.pair.baseToken,
                this.wallet.publicKey
            );

            if (baseBalance.raw.eq(ZERO)) {
                logger.debug('No balance to sell');
                return false;
            }

            const instructions = await this.buildSellInstructions({
                ...executionContext,
                pair: {
                    ...position.pair,
                    baseAmount: baseBalance
                }
            });

            // Add compute budget instruction if needed
            if (!this.config.useCustomFee) {
                instructions.unshift(
                    ComputeBudgetProgram.setComputeUnitLimit({
                        units: this.config.computeUnitLimit
                    }),
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: this.config.computeUnitPrice
                    })
                );
            }

            const transaction = await this.txManager.createTransaction(instructions);

            // Execute with retries
            let result: TransactionResult | null = null;
            for (let attempt = 1; attempt <= this.config.maxSellRetries; attempt++) {
                try {
                    result = await this.executionService.executeTransaction(
                        transaction,
                        this.wallet,
                        {
                            ...executionContext.txConfig,
                            attempt
                        }
                    );

                    if (result.success) {
                        await this.handleSuccessfulSell(executionContext, result);
                        return true;
                    }

                    logger.debug(`Sell attempt ${attempt} failed: ${result.error}`);
                    await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                } catch (error) {
                    logger.error(`Sell attempt ${attempt} error:`, error);
                    if (attempt === this.config.maxSellRetries) {
                        ErrorReporter.reportError(error, {
                            context: 'TradingEngine.executeSell',
                            attempt,
                            position: executionContext.positionId
                        });
                    }
                }
            }

            return false;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'TradingEngine.executeSell',
                userId,
                position: position.positionId
            });
            return false;
        } finally {
            release();
        }
    }

        private async buildBuyInstructions(
        context: TradeExecutionContext
    ): Promise<TransactionInstruction[]> {
        const { pair, amount, slippage } = context;
        const mintAta = await this.tokenPairService.getOrCreateATA(
            pair.baseToken,
            this.wallet.publicKey
        );

        const instructions: TransactionInstruction[] = [];

        // Create ATA if needed
        const ataIx = createAssociatedTokenAccountIdempotentInstruction(
            this.wallet.publicKey,
            mintAta.address,
            this.wallet.publicKey,
            pair.baseToken.mint
        );
        instructions.push(ataIx);

        // Build swap instructions
        const poolKeys = await this.poolAnalyzer.getPoolKeys(pair.lpAddress);
        const userKeys = {
            tokenAccounts: await this.getTokenAccounts(pair),
            owner: this.wallet.publicKey
        };

        const swapIx = await Liquidity.makeSwapInstructions({
            connection: this.connection,
            poolKeys,
            userKeys,
            amountIn: amount,
            amountOutMinimum: amount.multiply(new BN(1).sub(slippage.numerator)),
            fixedSide: 'in'
        });

        return [...instructions, ...swapIx];
    }

    private async buildSellInstructions(
        context: TradeExecutionContext
    ): Promise<TransactionInstruction[]> {
        const { pair, amount, slippage } = context;
        const poolKeys = await this.poolAnalyzer.getPoolKeys(pair.lpAddress);
        
        return Liquidity.makeSwapInstructions({
            connection: this.connection,
            poolKeys,
            userKeys: {
                tokenAccounts: await this.getTokenAccounts(pair),
                owner: this.wallet.publicKey
            },
            amountIn: amount,
            amountOutMinimum: amount.multiply(new BN(1).sub(slippage.numerator)),
            fixedSide: 'out'
        });
    }

    private async handleNewPool(event: any): Promise<void> {
        try {
            const poolState = event.state;
            const isValidPool = await this.poolFilterService.validatePool(
                event.address,
                poolState
            );

            if (!isValidPool) return;

            if (this.config.useSnipeList && 
                !this.snipeListService.isTokenInSnipeList(poolState.baseMint)) {
                logger.debug(`Pool ${poolState.baseMint.toString()} not in snipe list`);
                return;
            }

            const poolKeys = await this.poolAnalyzer.getPoolKeys(event.address);
            const marketState = await this.marketDataService.getMarketState(poolState.marketId);

            if (!marketState || !marketState.isActive) {
                logger.debug(`Market inactive for pool ${event.address.toString()}`);
                return;
            }

            // Validate pool metrics
            const liquidityUsd = new BN(poolState.quoteReserve).mul(marketState.price);
            if (liquidityUsd.lt(this.config.minLiquidityUsd)) {
                logger.debug(`Insufficient liquidity for pool ${event.address.toString()}`);
                return;
            }

            const baseToken = await this.tokenPairService.getTokenByMint(poolState.baseMint);
            const quoteToken = this.tokenPairService.USDC;

            // Skip if already tracking this pool
            if (this.poolCache.has(event.address.toString())) {
                return;
            }

            const pair: TradingPair = {
                lpAddress: event.address,
                baseToken,
                quoteToken,
                baseAmount: new TokenAmount(baseToken, poolState.baseReserve),
                quoteAmount: new TokenAmount(quoteToken, this.config.quoteAmount)
            };

            // Security validation
            const tokenSecurityResult = await this.tokenValidator.validateTokenSecurity({
                mint: baseToken.mint,
                poolKeys,
                marketState,
                poolState
            });

            if (!tokenSecurityResult.isSecure) {
                logger.debug(`Security check failed for ${event.address.toString()}: ${tokenSecurityResult.reason}`);
                return;
            }

            // Rate limiting check
            const lastExecutionTime = this.executionTimes.get(event.address.toString());
            if (lastExecutionTime && 
                Date.now() - lastExecutionTime < this.config.minTimeBetweenTrades) {
                return;
            }

            // Add to cache
            await this.poolCache.add(event.address.toString(), poolState);
            await this.marketCache.add(event.address, marketState);

            if (this.config.autoBuyDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, this.config.autoBuyDelay));
            }

            // Revalidate market conditions
            const updatedMarketState = await this.marketDataService.getMarketState(poolState.marketId);
            if (!this.validateMarketConditions(updatedMarketState, marketState)) {
                logger.debug(`Market conditions changed for ${event.address.toString()}`);
                return;
            }

            // Execute buy with retry mechanism
            let success = false;
            for (let i = 0; i < this.config.maxBuyRetries && !success; i++) {
                try {
                    success = await this.executeBuy(
                        pair,
                        this.wallet.publicKey.toString(),
                        {
                            metadata: {
                                source: 'auto_buy',
                                poolState,
                                marketState: updatedMarketState,
                                attempt: i + 1
                            }
                        }
                    );

                    if (success) {
                        this.executionTimes.set(event.address.toString(), Date.now());
                        this.emit('pool:traded', {
                            address: event.address,
                            baseToken,
                            quoteToken,
                            timestamp: Date.now(),
                            type: 'buy',
                            price: marketState.price,
                            liquidity: liquidityUsd
                        });
                        break;
                    }
                } catch (error) {
                    logger.error(`Buy attempt ${i + 1} failed for ${baseToken.symbol}:`, error);
                    await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                }
            }
        } catch (error) {
            logger.error('Error processing new pool:', error);
            ErrorReporter.reportError(error, {
                context: 'TradingEngine.handleNewPool',
                poolAddress: event.address.toString()
            });
        }
    }

        private async handleSuccessfulBuy(
        context: TradeExecutionContext,
        result: TransactionResult
    ): Promise<void> {
        const { pair, userSubscription, positionId } = context;
        logger.info(`Successfully bought ${pair.baseToken.symbol} at ${new Date().toISOString()}`);

        // Update position tracking
        this.activePositions.set(positionId, context);
        await this.startPositionMonitoring(positionId);

        // Update metrics
        const pnl = await this.calculatePnL(context);
        this.updateDailyStats(userSubscription.userId, {
            trades: 1,
            volume: context.pair.quoteAmount.raw,
            pnl
        });

        // Emit events
        this.emit('trade:executed', {
            type: 'trade:executed',
            context,
            result,
            timestamp: new Date()
        });

        // Cache transaction data
        await this.txManager.cacheTransaction(result.signature!, {
            type: 'buy',
            positionId,
            pair: pair.lpAddress.toString(),
            amount: context.pair.quoteAmount.toFixed(),
            price: result.price?.toString(),
            timestamp: Date.now()
        });
    }

    private async handleSuccessfulSell(
        context: TradeExecutionContext,
        result: TransactionResult
    ): Promise<void> {
        const { pair, userSubscription, positionId } = context;
        logger.info(`Successfully sold ${pair.baseToken.symbol} at ${new Date().toISOString()}`);

        // Clean up position tracking
        this.activePositions.delete(positionId);
        this.stopPositionMonitoring(positionId);

        // Calculate final PnL
        const pnl = await this.calculatePnL(context);
        this.updateDailyStats(userSubscription.userId, {
            trades: 1,
            volume: context.pair.baseAmount.raw,
            pnl
        });

        // Emit events
        this.emit('position:closed', {
            type: 'position:closed',
            context,
            result,
            pnl: pnl.toString(),
            timestamp: new Date()
        });

        // Cache transaction data
        await this.txManager.cacheTransaction(result.signature!, {
            type: 'sell',
            positionId,
            pair: pair.lpAddress.toString(),
            amount: context.pair.baseAmount.toFixed(),
            price: result.price?.toString(),
            pnl: pnl.toString(),
            timestamp: Date.now()
        });

        this.sellExecutionCount++;
    }

    private async validateTradePrerequisites(
        pair: TradingPair,
        userId: string
    ): Promise<boolean> {
        // Check user balance
        const quoteBalance = await this.tokenPairService.getTokenBalance(
            pair.quoteToken,
            this.wallet.publicKey
        );

        if (quoteBalance.lessThan(pair.quoteAmount)) {
            logger.warn(`Insufficient ${pair.quoteToken.symbol} balance for trade`);
            return false;
        }

        // Check daily limits
        const stats = this.getDailyStats(userId);
        if (stats.volume.add(pair.quoteAmount.raw).gt(this.config.riskManagement.dailyVolumeLimit)) {
            logger.warn('Daily volume limit reached');
            return false;
        }

        // Validate market conditions
        const marketState = await this.marketDataService.getMarketState(pair.lpAddress);
        if (!marketState || !marketState.isActive) {
            logger.warn('Market is not active');
            return false;
        }

        // Check position size limits
        if (pair.quoteAmount.raw.gt(this.config.riskManagement.maxPositionSize)) {
            logger.warn('Position size exceeds limit');
            return false;
        }

        return true;
    }

    private async handleMarketUpdate(event: any): Promise<void> {
        const { address, data } = event;
        const position = Array.from(this.activePositions.values())
            .find(p => p.pair.lpAddress.equals(address));

        if (!position) return;

        try {
            const marketState = await this.marketDataService.getMarketState(address);
            if (!marketState) return;

            const pnlPercent = this.calculateProfitLossPercent(position, marketState);
            
            if (await this.shouldClosePosition(position, marketState, pnlPercent)) {
                await this.executeSell(
                    position.pair.lpAddress,
                    position.userSubscription.userId,
                    { metadata: { reason: 'market_update' } }
                );
            }

            // Update position metrics
            this.emit('position:update', {
                positionId: position.positionId,
                marketState,
                pnlPercent,
                timestamp: new Date()
            });
        } catch (error) {
            logger.error('Error handling market update:', error);
            ErrorReporter.reportError(error, {
                context: 'TradingEngine.handleMarketUpdate',
                address: address.toString()
            });
        }
    }

    private buildTransactionConfig(subscription: UserSubscription): TransactionConfig {
        return {
            warpEnabled: this.config.useWarpTransactions && subscription.features.warpEnabled,
            jitoEnabled: this.config.useJitoTransactions && subscription.features.jitoEnabled,
            priorityFee: this.config.useCustomFee ? new BN(this.config.customFee) : undefined,
            computeUnitLimit: this.config.computeUnitLimit,
            computeUnitPrice: this.config.computeUnitPrice,
            skipPreflight: this.config.skipPreflight,
            maxRetries: this.config.maxRetries,
            maxTimeout: this.config.maxTimeout
        };
    }

    private async validateMarketConditions(
        current: MarketState,
        previous: MarketState
    ): boolean {
        if (!current || !current.isActive) return false;

        const priceChange = current.price
            .sub(previous.price)
            .mul(new BN(100))
            .div(previous.price);

        const volumeChange = current.volume24h
            .sub(previous.volume24h)
            .mul(new BN(100))
            .div(previous.volume24h);

        return (
            priceChange.abs().lt(this.config.maxPriceChange) &&
            volumeChange.abs().lt(this.config.maxVolumeChange) &&
            current.liquidity.gte(this.config.minLiquidityUsd)
        );
    }

    private async handlePoolTraded(event: any): Promise<void> {
        // Update pool cache
        await this.poolCache.update(event.address.toString(), {
            lastTraded: Date.now(),
            price: event.price,
            liquidity: event.liquidity
        });

        // Emit metrics
        this.emit('metrics:update', {
            type: 'pool:traded',
            data: {
                address: event.address.toString(),
                price: event.price.toString(),
                liquidity: event.liquidity.toString(),
                timestamp: Date.now()
            }
        });
    }

        private async calculatePnL(context: TradeExecutionContext): Promise<BN> {
        const { pair, side } = context;
        const currentMarketState = await this.marketDataService.getMarketState(pair.lpAddress);
        
        if (!currentMarketState || !currentMarketState.price) {
            return new BN(0);
        }

        const entryPrice = side === 'buy' ? 
            currentMarketState.price : 
            this.getEntryPrice(context.positionId);

        if (!entryPrice) return new BN(0);

        const amount = side === 'buy' ? pair.quoteAmount.raw : pair.baseAmount.raw;
        const priceDiff = currentMarketState.price.sub(entryPrice);
        
        return amount.mul(priceDiff).div(entryPrice);
    }

    private calculateProfitLossPercent(
        position: TradeExecutionContext,
        marketState: MarketState
    ): Percent {
        const entryPrice = this.getEntryPrice(position.positionId);
        if (!entryPrice || !marketState.price) {
            return new Percent(ZERO, new BN(100));
        }

        const priceDiff = marketState.price.sub(entryPrice);
        return new Percent(
            priceDiff.mul(new BN(100)),
            entryPrice
        );
    }

    private async shouldClosePosition(
        position: TradeExecutionContext,
        marketState: MarketState,
        pnlPercent: Percent
    ): Promise<boolean> {
        const holdingTime = Date.now() - position.timestamp.getTime();

        // Check take profit
        if (pnlPercent.greaterThan(new Percent(new BN(this.config.takeProfit), new BN(100)))) {
            logger.info(`Take profit triggered for ${position.positionId}`);
            return true;
        }

        // Check stop loss
        if (pnlPercent.lessThan(new Percent(new BN(-this.config.stopLoss), new BN(100)))) {
            logger.info(`Stop loss triggered for ${position.positionId}`);
            return true;
        }

        // Check max holding time
        if (holdingTime >= this.config.maxHoldingTime) {
            logger.info(`Max holding time reached for ${position.positionId}`);
            return true;
        }

        // Check risk management conditions
        const riskCheck = await this.riskManager.shouldClosePosition(position, {
            marketState,
            pnlPercent,
            holdingTime
        });

        if (riskCheck) {
            logger.info(`Risk management triggered position close for ${position.positionId}`);
            return true;
        }

        // Check emergency conditions
        if (this.config.emergencyCloseAll) {
            logger.warn(`Emergency close triggered for ${position.positionId}`);
            return true;
        }

        return false;
    }

    private async startPositionMonitoring(positionId: string): Promise<void> {
        if (this.positionMonitors.has(positionId)) {
            return;
        }

        const monitor = setInterval(async () => {
            try {
                const position = this.activePositions.get(positionId);
                if (!position) {
                    this.stopPositionMonitoring(positionId);
                    return;
                }

                const marketState = await this.marketDataService.getMarketState(
                    position.pair.lpAddress
                );

                if (!marketState) {
                    logger.warn(`Failed to get market state for position ${positionId}`);
                    return;
                }

                const pnlPercent = this.calculateProfitLossPercent(position, marketState);
                
                if (await this.shouldClosePosition(position, marketState, pnlPercent)) {
                    await this.executeSell(
                        position.pair.lpAddress,
                        position.userSubscription.userId,
                        {
                            metadata: {
                                reason: this.getCloseReason(pnlPercent, position.timestamp)
                            }
                        }
                    );
                }
            } catch (error) {
                logger.error(`Position monitoring error for ${positionId}:`, error);
                ErrorReporter.reportError(error, {
                    context: 'TradingEngine.positionMonitoring',
                    positionId
                });
            }
        }, this.config.priceCheckInterval);

        this.positionMonitors.set(positionId, monitor);
    }

    private stopPositionMonitoring(positionId: string): void {
        const monitor = this.positionMonitors.get(positionId);
        if (monitor) {
            clearInterval(monitor);
            this.positionMonitors.delete(positionId);
        }
    }

    private async closeAllPositions(): Promise<void> {
        const positions = Array.from(this.activePositions.values());
        
        for (const position of positions) {
            try {
                await this.executeSell(
                    position.pair.lpAddress,
                    position.userSubscription.userId,
                    {
                        metadata: {
                            reason: 'emergency_close'
                        }
                    }
                );
            } catch (error) {
                logger.error(`Failed to close position ${position.positionId}:`, error);
            }
        }
    }

    private getDailyStats(userId: string) {
        let stats = this.dailyStats.get(userId);
        const now = new Date();
        
        if (!stats || this.shouldResetDailyStats(stats.lastReset)) {
            stats = {
                trades: 0,
                volume: new BN(0),
                pnl: new BN(0),
                lastReset: now
            };
            this.dailyStats.set(userId, stats);
        }
        
        return stats;
    }

    private shouldResetDailyStats(lastReset: Date): boolean {
        const now = new Date();
        return now.getUTCDate() !== lastReset.getUTCDate() ||
               now.getUTCMonth() !== lastReset.getUTCMonth() ||
               now.getUTCFullYear() !== lastReset.getUTCFullYear();
    }

    private updateDailyStats(
        userId: string,
        update: {
            trades: number;
            volume: BN;
            pnl: BN;
        }
    ): void {
        const stats = this.getDailyStats(userId);
        stats.trades += update.trades;
        stats.volume = stats.volume.add(update.volume);
        stats.pnl = stats.pnl.add(update.pnl);
    }

    private getEntryPrice(positionId: string): BN | null {
        const position = this.activePositions.get(positionId);
        if (!position) return null;

        const metadata = position.metadata as any;
        return metadata?.entryPrice || null;
    }

    private getCloseReason(pnlPercent: Percent, openTime: Date): string {
        const holdingTime = Date.now() - openTime.getTime();
        
        if (pnlPercent.greaterThan(new Percent(new BN(this.config.takeProfit), new BN(100)))) {
            return 'take_profit';
        }
        if (pnlPercent.lessThan(new Percent(new BN(-this.config.stopLoss), new BN(100)))) {
            return 'stop_loss';
        }
        if (holdingTime >= this.config.maxHoldingTime) {
            return 'max_holding_time';
        }
        if (this.config.emergencyCloseAll) {
            return 'emergency_close';
        }
        return 'risk_management';
    }

    private async getTokenAccounts(pair: TradingPair): Promise<{ [mint: string]: PublicKey }> {
        const [baseAta, quoteAta] = await Promise.all([
            this.tokenPairService.getOrCreateATA(pair.baseToken, this.wallet.publicKey),
            this.tokenPairService.getOrCreateATA(pair.quoteToken, this.wallet.publicKey)
        ]);

        return {
            [pair.baseToken.mint.toString()]: baseAta.address,
            [pair.quoteToken.mint.toString()]: quoteAta.address
        };
    }
}
