import {
    Connection,
    Keypair,
    PublicKey,
    TransactionInstruction,
    VersionedTransaction
} from '@solana/web3.js';
import {
    Liquidity,
    Token,
    TokenAmount,
    ZERO,
    Percent,
    Currency,
    LiquidityPoolKeysV4
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
    TransactionResult
} from '../types/trading.types';
import { TransactionManager } from './TransactionManager';
import { PoolAnalyzer } from './PoolAnalyzer';
import { PerformanceMonitor } from '../utils/performance';
import { ErrorReporter } from '../utils/errorReporting';
import { logger } from '../utils/logger';
import { Mutex } from 'async-mutex';
import { TokenValidator } from '../utils/TokenValidator';
import { SubscriptionValidator } from '../services/SubscriptionValidator';
import { MarketDataService } from '../services/MarketDataService';
import { RiskManager } from '../services/RiskManager';
import { TokenPairService } from '../services/TokenPairService';
import { ExecutionStrategyService } from '../services/ExecutionStrategyService';
import { PoolFilterService } from '../services/PoolFilterService';
import { MarketEventService } from '../services/MarketEventService';
import { SnipeListService } from '../services/SnipeListService';
import BN from 'bn.js';
import { EventEmitter } from 'events';
import { TOKEN_PROGRAM_ID, AccountLayout, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';

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
        this.initializeEventListeners();
    }

    private initializeEventListeners(): void {
        this.on('trade:executed', this.handleTradeExecution.bind(this));
        this.on('position:update', this.handlePositionUpdate.bind(this));
        this.on('risk:alert', this.handleRiskAlert.bind(this));
        this.txManager.addTradeEventHandler(this.handleTradeEvent.bind(this));

        this.marketEventService.on('market:update', async (event) => {
            try {
                await this.handleMarketUpdate(event);
            } catch (error) {
                logger.error('Error handling market update:', error);
            }
        });

        this.marketEventService.on('pool:new', async (event) => {
            try {
                await this.handleNewPool(event);
            } catch (error) {
                logger.error('Error handling new pool:', error);
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
            this.isRunning = true;

            await this.marketEventService.start({
                walletPublicKey: this.wallet.publicKey,
                quoteToken: this.tokenPairService.USDC,
                autoSell: true,
                cacheNewMarkets: true,
                startTimestamp: Math.floor(Date.now() / 1000)
            });

            await this.startTradingLoop();
            logger.info('Trading engine started successfully');
        } catch (error) {
            this.isRunning = false;
            logger.error('Failed to start trading engine:', error);
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
            const permissions = await this.subscriptionValidator.validateTrading(userId, pair);
            if (!permissions.canTrade) {
                logger.warn(`User ${userId} does not have permission to trade ${pair.baseToken.symbol}`);
                return false;
            }

            if (this.config.useSnipeList && 
                !this.snipeListService.isTokenInSnipeList(pair.baseToken.mint)) {
                logger.debug('Token not in snipe list');
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
                slippage: new Percent(this.config.slippageTolerance),
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
            const transaction = await this.txManager.createTransaction(instructions);

            const result = await this.executionService.executeTransaction(
                transaction,
                this.wallet,
                executionContext.txConfig
            );

            if (result.success) {
                await this.handleSuccessfulBuy(executionContext, result);
                return true;
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

            const transaction = await this.txManager.createTransaction(instructions);

            const result = await this.executionService.executeTransaction(
                transaction,
                this.wallet,
                executionContext.txConfig
            );

            if (result.success) {
                await this.handleSuccessfulSell(executionContext, result);
                return true;
            }

            return false;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'TradingEngine.executeSell',
                userId,
                pair: lpAddress.toString()
            });
            return false;
        } finally {
            release();
        }
    }

    private async validateTradePrerequisites(
        pair: TradingPair,
        userId: string
    ): Promise<boolean> {
        const [poolValid, tokenValid] = await Promise.all([
            this.poolAnalyzer.validatePool(pair.lpAddress),
            this.tokenValidator.validateToken(pair.baseToken, userId)
        ]);

        if (!poolValid || !tokenValid) {
            logger.warn('Pool or token validation failed');
            return false;
        }

        const marketState = await this.marketDataService.getMarketState(pair.lpAddress);
        if (!marketState.isActive) {
            logger.warn('Market is not active');
            return false;
        }

        return true;
    }

    private buildTransactionConfig(subscription?: UserSubscription): TransactionConfig {
        return {
            computeUnitLimit: 200_000,
            computeUnitPrice: 1000,
            retryCount: this.config.maxRetries,
            confirmationStrategy: 'confirmed',
            priorityFee: subscription?.features.priority ? 2000 : 1000,
            warpEnabled: subscription?.features.priority || false,
            jitoEnabled: subscription?.features.priority || false
        };
    }

    private async buildBuyInstructions(
        context: TradeExecutionContext
    ): Promise<TransactionInstruction[]> {
        const { pair, amount, slippage } = context;
        const mintAta = await this.tokenPairService.getTokenBalance(
            pair.baseToken,
            this.wallet.publicKey
        );

        const ataIx = createAssociatedTokenAccountIdempotentInstruction(
            this.wallet.publicKey,
            mintAta.token.publicKey,
            this.wallet.publicKey,
            pair.baseToken.mint
        );

        const swapIx = await Liquidity.makeSwapInstructions({
            connection: this.connection,
            poolKeys: await this.poolAnalyzer.getPoolKeys(pair.lpAddress),
            userKeys: {
                tokenAccounts: await this.getTokenAccounts(pair),
                owner: this.wallet.publicKey
            },
            amountIn: amount,
            amountOutMinimum: amount.multiply(new BN(1).sub(slippage.numerator)),
            fixedSide: 'in'
        });

        return [ataIx, ...swapIx];
    }

    private async buildSellInstructions(
        context: TradeExecutionContext
    ): Promise<TransactionInstruction[]> {
        const { pair, amount, slippage } = context;
        
        return Liquidity.makeSwapInstructions({
            connection: this.connection,
            poolKeys: await this.poolAnalyzer.getPoolKeys(pair.lpAddress),
            userKeys: {
                tokenAccounts: await this.getTokenAccounts(pair),
                owner: this.wallet.publicKey
            },
            amountIn: amount,
            amountOutMinimum: amount.multiply(new BN(1).sub(slippage.numerator)),
            fixedSide: 'out'
        });
    }

    private async handleSuccessfulBuy(
        context: TradeExecutionContext,
        result: TransactionResult
    ): Promise<void> {
        const { pair, userSubscription, positionId } = context;
        
        this.activePositions.set(positionId, context);
        this.executionTimes.set(positionId, Date.now());
        await this.startPositionMonitoring(positionId);
        
        this.updateDailyStats(userSubscription.userId, {
            trades: 1,
            volume: pair.quoteAmount.raw,
            pnl: ZERO
        });

        this.emit('trade:executed', {
            type: 'buy',
            context,
            result
        });
    }

    private async handleSuccessfulSell(
        context: TradeExecutionContext,
        result: TransactionResult
    ): Promise<void> {
        const { pair, userSubscription, positionId } = context;
        
        this.activePositions.delete(positionId);
        this.executionTimes.delete(positionId);
        this.stopPositionMonitoring(positionId);
        
        const pnl = await this.calculatePnL(context);
        this.updateDailyStats(userSubscription.userId, {
            trades: 1,
            volume: pair.quoteAmount.raw,
            pnl
        });

        this.emit('trade:executed', {
            type: 'sell',
            context,
            result,
            pnl
        });
    }

    private async handleMarketUpdate(event: any): Promise<void> {
        const lpAddress = event.address.toString();
        const position = Array.from(this.activePositions.values())
            .find(p => p.pair.lpAddress.toString() === lpAddress);

        if (!position) return;

        const marketState = await this.marketDataService.getMarketState(event.address);
        if (!marketState) return;

        const pnlPercent = this.calculateProfitLossPercent(position, marketState);

        if (await this.shouldClosePosition(position, marketState, pnlPercent)) {
            await this.executeSell(
                position.pair.lpAddress,
                position.userSubscription.userId,
                { metadata: { reason: 'market_update' } }
            );
        }
    }

    private async handleNewPool(event: any): Promise<void> {
        if (!this.isRunning || !this.config.subscriptionRequired) return;

        try {
            const poolState = event.state;
            const isValidPool = await this.poolFilterService.validatePool(
                event.address,
                poolState
            );

            if (!isValidPool) return;
            if (this.config.useSnipeList && 
                    !this.snipeListService.isTokenInSnipeList(poolState.baseMint)) {
                    logger.debug(`Skipping pool ${poolState.baseMint.toString()} - not in snipe list`);
                    return;
                }

                const poolKeys = await this.poolAnalyzer.getPoolKeys(event.address);
                const marketState = await this.marketDataService.getMarketState(poolState.marketId);

                if (!marketState || !marketState.isActive) {
                    logger.debug(`Skipping pool ${event.address.toString()} - market inactive`);
                    return;
                }

                // Validate pool metrics
                const liquidityUsd = new BN(poolState.quoteReserve).mul(marketState.price);
                if (liquidityUsd.lt(this.config.minLiquidityUsd)) {
                    logger.debug(`Skipping pool ${event.address.toString()} - insufficient liquidity`);
                    return;
                }

                const baseToken = await this.tokenPairService.getTokenByMint(poolState.baseMint);
                const quoteToken = this.tokenPairService.USDC;

                const pair: TradingPair = {
                    lpAddress: event.address,
                    baseToken,
                    quoteToken,
                    baseAmount: new TokenAmount(
                        baseToken, 
                        poolState.baseReserve
                    ),
                    quoteAmount: new TokenAmount(
                        quoteToken,
                        this.config.quoteAmount
                    )
                };

                // Validate token security
                const tokenSecurityResult = await this.tokenValidator.validateTokenSecurity({
                    mint: baseToken.mint,
                    poolKeys,
                    marketState,
                    poolState
                });

                if (!tokenSecurityResult.isSecure) {
                    logger.debug(`Skipping pool ${event.address.toString()} - security check failed: ${tokenSecurityResult.reason}`);
                    return;
                }

                // Check for rate limiting
                const lastExecutionTime = this.executionTimes.get(event.address.toString());
                if (lastExecutionTime && 
                    Date.now() - lastExecutionTime < this.config.minTimeBetweenTrades) {
                    logger.debug(`Skipping pool ${event.address.toString()} - rate limited`);
                    return;
                }

                // Pre-validate trade
                const preValidateContext: TradeExecutionContext = {
                    pair,
                    side: 'buy',
                    amount: pair.quoteAmount,
                    slippage: new Percent(this.config.slippageTolerance),
                    timestamp: new Date(),
                    userSubscription: await this.subscriptionValidator.getActiveSubscription(
                        this.wallet.publicKey.toString()
                    ),
                    txConfig: this.buildTransactionConfig(),
                    positionId: `${this.wallet.publicKey.toString()}-${event.address.toString()}-${Date.now()}`
                };

                if (!await this.riskManager.validateTrade(preValidateContext)) {
                    logger.debug(`Skipping pool ${event.address.toString()} - risk validation failed`);
                    return;
                }

                if (this.config.autoBuyDelay > 0) {
                    logger.debug(`Waiting ${this.config.autoBuyDelay}ms before buying ${baseToken.symbol}`);
                    await new Promise(resolve => setTimeout(resolve, this.config.autoBuyDelay));
                }

                // Recheck market conditions after delay
                const updatedMarketState = await this.marketDataService.getMarketState(poolState.marketId);
                if (!this.validateMarketConditions(updatedMarketState, marketState)) {
                    logger.debug(`Skipping pool ${event.address.toString()} - market conditions changed`);
                    return;
                }

                // Execute buy with retries
                let success = false;
                for (let i = 0; i < this.config.maxRetries && !success; i++) {
                    try {
                        success = await this.executeBuy(
                            pair,
                            this.wallet.publicKey.toString(),
                            {
                                metadata: {
                                    source: 'auto_buy',
                                    poolState: poolState,
                                    marketState: updatedMarketState,
                                    attempt: i + 1
                                }
                            }
                        );

                        if (success) {
                            logger.info(`Successfully bought ${baseToken.symbol} on attempt ${i + 1}`);
                            this.executionTimes.set(event.address.toString(), Date.now());
                            
                            // Emit pool discovery event
                            this.emit('pool:traded', {
                                address: event.address,
                                baseToken: baseToken,
                                quoteToken: quoteToken,
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

                if (!success) {
                    logger.warn(`Failed to buy ${baseToken.symbol} after ${this.config.maxRetries} attempts`);
                }
            } catch (error) {
                logger.error('Error processing new pool:', error);
                ErrorReporter.reportError(error, {
                    context: 'TradingEngine.handleNewPool',
                    poolAddress: event.address.toString(),
                    timestamp: new Date().toISOString()
                });
            }
        }

        private validateMarketConditions(
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

        private async startPositionMonitoring(positionId: string): Promise<void> {
            const position = this.activePositions.get(positionId);
            if (!position) return;

            const monitor = setInterval(async () => {
                try {
                    const marketState = await this.marketDataService.getMarketState(
                        position.pair.lpAddress
                    );

                    if (!marketState) {
                        logger.warn(`Failed to get market state for position ${positionId}`);
                        return;
                    }

                    await this.checkPositionStatus(positionId, marketState);
                } catch (error) {
                    logger.error(`Position monitoring error for ${positionId}:`, error);
                    ErrorReporter.reportError(error, {
                        context: 'TradingEngine.positionMonitoring',
                        positionId,
                        timestamp: new Date().toISOString()
                    });
                }
            }, this.config.priceCheckInterval);

            this.positionMonitors.set(positionId, monitor);
        }

        private async checkPositionStatus(
            positionId: string,
            marketState: MarketState
        ): Promise<void> {
            const position = this.activePositions.get(positionId);
            if (!position) return;

            const pnlPercent = this.calculateProfitLossPercent(position, marketState);
            const holdingTime = Date.now() - position.timestamp.getTime();

            const shouldClose = 
                pnlPercent.greaterThan(this.config.takeProfit) ||
                pnlPercent.lessThan(this.config.stopLoss.mul(new BN(-1))) ||
                holdingTime >= this.config.maxHoldingTime ||
                await this.riskManager.shouldClosePosition(position, {
                    marketState,
                    pnlPercent,
                    holdingTime
                });

            if (shouldClose) {
                try {
                    await this.executeSell(
                        position.pair.lpAddress,
                        position.userSubscription.userId,
                        {
                            metadata: {
                                reason: this.getCloseReason(pnlPercent, holdingTime),
                                pnlPercent: pnlPercent.toString(),
                                holdingTime
                            }
                        }
                    );
                } catch (error) {
                    logger.error(`Failed to close position ${positionId}:`, error);
                    ErrorReporter.reportError(error, {
                        context: 'TradingEngine.checkPositionStatus',
                        positionId,
                        pnlPercent: pnlPercent.toString(),
                        holdingTime
                    });
                }
            }

            this.emit('position:update', {
                positionId,
                marketState,
                pnlPercent,
                holdingTime
            });
        }

        private getCloseReason(pnlPercent: Percent, holdingTime: number): string {
            if (pnlPercent.greaterThan(this.config.takeProfit)) {
                return 'take_profit';
            }
            if (pnlPercent.lessThan(this.config.stopLoss.mul(new BN(-1)))) {
                return 'stop_loss';
            }
            if (holdingTime >= this.config.maxHoldingTime) {
                return 'max_holding_time';
            }
            return 'risk_management';
        }
