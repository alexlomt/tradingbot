import {
    Connection,
    Keypair,
    PublicKey,
    TransactionInstruction,
} from '@solana/web3.js';
import {
    Liquidity,
    Token,
    TokenAmount,
    ZERO,
    Percent,
    Currency
} from '@raydium-io/raydium-sdk';
import {
    TradingStrategyConfig,
    TradingPair,
    TradeExecutionContext,
    MarketState,
    UserSubscription,
    TradeEvent,
    RiskManagementConfig
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
import BN from 'bn.js';
import { EventEmitter } from 'events';

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
    private isRunning: boolean = false;

    constructor(
        private readonly connection: Connection,
        private readonly wallet: Keypair,
        private readonly txManager: TransactionManager,
        private readonly poolAnalyzer: PoolAnalyzer,
        private readonly config: TradingStrategyConfig,
        private readonly subscriptionValidator: SubscriptionValidator,
        private readonly marketDataService: MarketDataService,
        private readonly riskManager: RiskManager,
        private readonly tokenValidator: TokenValidator
    ) {
        super();
        this.mutex = new Mutex();
        this.activePositions = new Map();
        this.positionMonitors = new Map();
        this.dailyStats = new Map();
        this.initializeEventListeners();
    }

    private initializeEventListeners(): void {
        this.on('trade:executed', this.handleTradeExecution.bind(this));
        this.on('position:update', this.handlePositionUpdate.bind(this));
        this.on('risk:alert', this.handleRiskAlert.bind(this));
        this.txManager.addTradeEventHandler(this.handleTradeEvent.bind(this));
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('Trading engine is already running');
            return;
        }

        try {
            await this.validateSystemState();
            this.isRunning = true;
            await this.startTradingLoop();
            logger.info('Trading engine started successfully');
        } catch (error) {
            logger.error('Failed to start trading engine:', error);
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        for (const [address, monitor] of this.positionMonitors) {
            clearInterval(monitor);
            this.positionMonitors.delete(address);
        }
        logger.info('Trading engine stopped');
    }

    async executeBuy(
        pair: TradingPair,
        userId: string,
        context?: Partial<TradeExecutionContext>
    ): Promise<boolean> {
        const release = await this.mutex.acquire();

        try {
            // Validate subscription and trading permissions
            const permissions = await this.subscriptionValidator.validateTrading(userId, pair);
            if (!permissions.canTrade) {
                logger.warn(`User ${userId} does not have permission to trade ${pair.baseToken.symbol}`);
                return false;
            }

            // Check daily trading limits
            const dailyStats = this.getDailyStats(userId);
            if (dailyStats.trades >= permissions.remainingDailyTrades) {
                logger.warn(`Daily trade limit reached for user ${userId}`);
                return false;
            }

            // Validate token and pool
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

            // Risk check
            if (!await this.riskManager.validateTrade(executionContext)) {
                logger.warn('Trade rejected by risk management');
                return false;
            }

            const instructions = await this.buildBuyInstructions(executionContext);
            const result = await this.txManager.executeTransaction(
                instructions,
                executionContext.txConfig,
                subscription
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

            const instructions = await this.buildSellInstructions(executionContext);
            const result = await this.txManager.executeTransaction(
                instructions,
                executionContext.txConfig,
                subscription
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
        
        return Liquidity.makeSwapInstructions({
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

    private async startPositionMonitoring(positionId: string): Promise<void> {
        const position = this.activePositions.get(positionId);
        if (!position) return;

        const monitor = setInterval(async () => {
            try {
                const marketState = await this.marketDataService.getMarketState(
                    position.pair.lpAddress
                );

                await this.checkPositionStatus(positionId, marketState);
            } catch (error) {
                logger.error('Position monitoring error:', error);
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

    private async checkPositionStatus(
        positionId: string,
        marketState: MarketState
    ): Promise<void> {
        const position = this.activePositions.get(positionId);
        if (!position) return;

        const pnlPercent = this.calculateProfitLossPercent(position, marketState);
        
        if (pnlPercent.greaterThan(this.config.takeProfit)) {
            await this.executeSell(
                position.pair.lpAddress,
                position.userSubscription.userId,
                { metadata: { reason: 'take_profit' } }
            );
        } else if (pnlPercent.lessThan(this.config.stopLoss)) {
            await this.executeSell(
                position.pair.lpAddress,
                position.userSubscription.userId,
                { metadata: { reason: 'stop_loss' } }
            );
        }

        this.emit('position:update', {
            positionId,
            marketState,
            pnlPercent
        });
    }

    private calculateProfitLossPercent(
        position: TradeExecutionContext,
        marketState: MarketState
    ): Percent {
        const entryPrice = position.pair.quoteAmount.raw;
        const currentPrice = marketState.price;
        
        return new Percent(
            currentPrice.sub(entryPrice).mul(new BN(100)),
            entryPrice
        );
    }

    private async calculatePnL(
        position: TradeExecutionContext
    ): Promise<BN> {
        const marketState = await this.marketDataService.getMarketState(
            position.pair.lpAddress
        );
        
        return marketState.price.sub(position.pair.quoteAmount.raw);
    }

    private getDailyStats(userId: string) {
        let stats = this.dailyStats.get(userId);
        
        if (!stats || this.shouldResetDailyStats(stats.lastReset)) {
            stats = {
                trades: 0,
                volume: ZERO,
                pnl: ZERO,
                lastReset: new Date()
            };
            this.dailyStats.set(userId, stats);
        }
        
        return stats;
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

    private shouldResetDailyStats(lastReset: Date): boolean {
        const now = new Date();
        return now.getUTCDate() !== lastReset.getUTCDate();
    }

    private async validateSystemState(): Promise<void> {
        const [connection, wallet] = await Promise.all([
            this.connection.getVersion(),
            this.connection.getAccountInfo(this.wallet.publicKey)
        ]);

        if (!connection || !wallet) {
            throw new Error('System state validation failed');
        }
    }

    private async handleTradeEvent(event: TradeEvent): Promise<void> {
        this.emit('trade:event', event);
    }

    private async handleRiskAlert(alert: any): Promise<void> {
        if (this.config.emergencyCloseAll) {
            await this.closeAllPositions();
        }
    }

    private async closeAllPositions(): Promise<void> {
        const positions = Array.from(this.activePositions.entries());
        
        for (const [positionId, position] of positions) {
            try {
                await this.executeSell(
                    position.pair.lpAddress,
                    position.userSubscription.userId,
                    { metadata: { reason: 'emergency_close' } }
                );
            } catch (error) {
                logger.error(`Failed to close position ${positionId}:`, error);
            }
        }
    }

    private async getTokenAccounts(pair: TradingPair): Promise<{ [key: string]: PublicKey }> {
        const accounts = await this.connection.getTokenAccountsByOwner(
            this.wallet.publicKey,
            { programId: TOKEN_PROGRAM_ID }
        );

        const tokenAccounts: { [key: string]: PublicKey } = {};
        accounts.value.forEach(({ pubkey, account }) => {
            const accountInfo = AccountLayout.decode(account.data);
            if (accountInfo.mint.equals(pair.baseToken.mint)) {
                tokenAccounts[pair.baseToken.symbol] = pubkey;
            } else if (accountInfo.mint.equals(pair.quoteToken.mint)) {
                tokenAccounts[pair.quoteToken.symbol] = pubkey;
            }
        });

        return tokenAccounts;
    }

    public async getPositionStatus(positionId: string): Promise<{
        position: TradeExecutionContext;
        marketState: MarketState;
        pnlPercent: Percent;
        unrealizedPnl: BN;
    } | null> {
        const position = this.activePositions.get(positionId);
        if (!position) return null;

        const marketState = await this.marketDataService.getMarketState(
            position.pair.lpAddress
        );

        const pnlPercent = this.calculateProfitLossPercent(position, marketState);
        const unrealizedPnl = marketState.price.sub(position.pair.quoteAmount.raw);

        return {
            position,
            marketState,
            pnlPercent,
            unrealizedPnl
        };
    }

    public async getUserPositions(userId: string): Promise<Array<{
        positionId: string;
        position: TradeExecutionContext;
        status: {
            marketState: MarketState;
            pnlPercent: Percent;
            unrealizedPnl: BN;
        };
    }>> {
        const userPositions = Array.from(this.activePositions.entries())
            .filter(([_, position]) => position.userSubscription.userId === userId);

        const positionStatuses = await Promise.all(
            userPositions.map(async ([positionId, position]) => {
                const status = await this.getPositionStatus(positionId);
                return {
                    positionId,
                    position,
                    status: {
                        marketState: status.marketState,
                        pnlPercent: status.pnlPercent,
                        unrealizedPnl: status.unrealizedPnl
                    }
                };
            })
        );

        return positionStatuses;
    }

    public async getUserStats(userId: string): Promise<{
        dailyStats: {
            trades: number;
            volume: BN;
            pnl: BN;
        };
        activePositionsCount: number;
        totalPositionsValue: BN;
    }> {
        const stats = this.getDailyStats(userId);
        const positions = await this.getUserPositions(userId);

        const totalPositionsValue = positions.reduce(
            (total, { position }) => total.add(position.pair.quoteAmount.raw),
            ZERO
        );

        return {
            dailyStats: {
                trades: stats.trades,
                volume: stats.volume,
                pnl: stats.pnl
            },
            activePositionsCount: positions.length,
            totalPositionsValue
        };
    }

    public getSystemStatus(): {
        isRunning: boolean;
        totalActivePositions: number;
        totalUsers: number;
        systemUptime: number;
    } {
        const uniqueUsers = new Set(
            Array.from(this.activePositions.values())
                .map(position => position.userSubscription.userId)
        );

        return {
            isRunning: this.isRunning,
            totalActivePositions: this.activePositions.size,
            totalUsers: uniqueUsers.size,
            systemUptime: process.uptime()
        };
    }

    private async handlePositionUpdate(update: {
        positionId: string;
        marketState: MarketState;
        pnlPercent: Percent;
    }): Promise<void> {
        const position = this.activePositions.get(update.positionId);
        if (!position) return;

        if (await this.riskManager.shouldClosePosition(position, update)) {
            await this.executeSell(
                position.pair.lpAddress,
                position.userSubscription.userId,
                { metadata: { reason: 'risk_management' } }
            );
        }

        this.emit('position:status', {
            ...update,
            position
        });
    }
}
