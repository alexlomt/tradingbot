import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TradingService } from '../TradingService';
import { MarketDataService } from '../MarketDataService';
import { RiskManagementService } from '../RiskManagementService';
import { NotificationService } from '../../notification/NotificationService';
import { MetricsService } from '../../metrics/MetricsService';
import { CircuitBreakerService } from '../../circuit-breaker/CircuitBreakerService';
import { RedisService } from '../../cache/RedisService';
import Big from 'big.js';
import {
    Strategy,
    StrategyType,
    StrategyState,
    TradeSignal,
    StrategyParams,
    BacktestResult
} from '../../../types/strategy.types';
import { OrderSide, OrderType } from '../../../types/trading.types';

@Injectable()
export class TradingStrategyService implements OnModuleInit {
    private readonly logger = new Logger(TradingStrategyService.name);
    private readonly activeStrategies: Map<string, Strategy> = new Map();
    private readonly signalBuffer: Map<string, TradeSignal[]> = new Map();
    private readonly maxSignalBufferSize: number;
    private readonly backtestPeriod: number;

    constructor(
        private readonly configService: ConfigService,
        private readonly tradingService: TradingService,
        private readonly marketDataService: MarketDataService,
        private readonly riskManagementService: RiskManagementService,
        private readonly notificationService: NotificationService,
        private readonly metricsService: MetricsService,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly redisService: RedisService,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.maxSignalBufferSize = this.configService.get('MAX_SIGNAL_BUFFER_SIZE', 1000);
        this.backtestPeriod = this.configService.get('BACKTEST_PERIOD_DAYS', 30);
    }

    async onModuleInit() {
        await this.loadPersistedStrategies();
        this.startStrategyMonitoring();
    }

    async createStrategy(params: StrategyParams): Promise<Strategy> {
        const strategy: Strategy = {
            id: `strategy-${Date.now()}`,
            type: params.type,
            pair: params.pair,
            userId: params.userId,
            params: this.validateStrategyParams(params),
            state: StrategyState.INITIALIZING,
            metrics: {
                totalTrades: 0,
                successfulTrades: 0,
                failedTrades: 0,
                totalProfit: 0,
                winRate: 0,
                averageReturnPerTrade: 0
            },
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await this.validateStrategy(strategy);
        const backtestResult = await this.backtestStrategy(strategy);
        
        if (!this.isBacktestSuccessful(backtestResult)) {
            throw new Error('Strategy backtest failed to meet performance criteria');
        }

        strategy.state = StrategyState.ACTIVE;
        await this.persistStrategy(strategy);
        this.activeStrategies.set(strategy.id, strategy);
        this.initializeSignalBuffer(strategy.id);

        await this.notificationService.sendSystemAlert({
            component: 'TradingStrategy',
            type: 'STRATEGY_CREATED',
            strategyId: strategy.id,
            backtestResult
        });

        return strategy;
    }

    async executeStrategy(strategyId: string): Promise<void> {
        const strategy = this.activeStrategies.get(strategyId);
        if (!strategy || strategy.state !== StrategyState.ACTIVE) {
            throw new Error('Strategy not found or inactive');
        }

        try {
            const signal = await this.generateTradeSignal(strategy);
            if (signal) {
                await this.validateSignal(signal, strategy);
                await this.executeTradeSignal(signal, strategy);
                await this.updateStrategyMetrics(strategy, signal);
            }
        } catch (error) {
            await this.handleStrategyError(strategy, error);
        }
    }

    async updateStrategy(
        strategyId: string,
        updates: Partial<StrategyParams>
    ): Promise<Strategy> {
        const strategy = this.activeStrategies.get(strategyId);
        if (!strategy) {
            throw new Error('Strategy not found');
        }

        const updatedStrategy = {
            ...strategy,
            params: {
                ...strategy.params,
                ...this.validateStrategyParams(updates)
            },
            updatedAt: new Date()
        };

        await this.validateStrategy(updatedStrategy);
        await this.persistStrategy(updatedStrategy);
        this.activeStrategies.set(strategyId, updatedStrategy);

        return updatedStrategy;
    }

    async stopStrategy(strategyId: string): Promise<void> {
        const strategy = this.activeStrategies.get(strategyId);
        if (!strategy) {
            throw new Error('Strategy not found');
        }

        strategy.state = StrategyState.STOPPED;
        await this.persistStrategy(strategy);
        this.activeStrategies.delete(strategyId);
        this.signalBuffer.delete(strategyId);

        await this.notificationService.sendSystemAlert({
            component: 'TradingStrategy',
            type: 'STRATEGY_STOPPED',
            strategyId
        });
    }

    private async generateTradeSignal(strategy: Strategy): Promise<TradeSignal | null> {
        return this.circuitBreaker.executeFunction(
            `signal_generation_${strategy.id}`,
            async () => {
                const marketData = await this.marketDataService.getMarketData(strategy.pair);
                const signal = await this.executeStrategyLogic(strategy, marketData);
                
                if (signal) {
                    this.addToSignalBuffer(strategy.id, signal);
                }

                return signal;
            }
        );
    }

    private async executeStrategyLogic(
        strategy: Strategy,
        marketData: any
    ): Promise<TradeSignal | null> {
        switch (strategy.type) {
            case StrategyType.MEAN_REVERSION:
                return this.executeMeanReversionStrategy(strategy, marketData);
            case StrategyType.TREND_FOLLOWING:
                return this.executeTrendFollowingStrategy(strategy, marketData);
            case StrategyType.GRID_TRADING:
                return this.executeGridTradingStrategy(strategy, marketData);
            case StrategyType.ARBITRAGE:
                return this.executeArbitrageStrategy(strategy, marketData);
            default:
                throw new Error(`Unsupported strategy type: ${strategy.type}`);
        }
    }

    private async executeMeanReversionStrategy(
        strategy: Strategy,
        marketData: any
    ): Promise<TradeSignal | null> {
        const { period, deviations } = strategy.params;
        const prices = marketData.prices.slice(-period);
        
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const stdDev = Math.sqrt(
            prices.reduce((sq, price) => sq + Math.pow(price - mean, 2), 0) / prices.length
        );

        const currentPrice = prices[prices.length - 1];
        const upperBand = mean + (stdDev * deviations);
        const lowerBand = mean - (stdDev * deviations);

        if (currentPrice > upperBand) {
            return {
                strategyId: strategy.id,
                type: OrderType.LIMIT,
                side: OrderSide.SELL,
                price: currentPrice,
                timestamp: new Date(),
                confidence: this.calculateSignalConfidence(currentPrice, mean, stdDev)
            };
        } else if (currentPrice < lowerBand) {
            return {
                strategyId: strategy.id,
                type: OrderType.LIMIT,
                side: OrderSide.BUY,
                price: currentPrice,
                timestamp: new Date(),
                confidence: this.calculateSignalConfidence(currentPrice, mean, stdDev)
            };
        }

        return null;
    }

    private async executeTrendFollowingStrategy(
        strategy: Strategy,
        marketData: any
    ): Promise<TradeSignal | null> {
        const { shortPeriod, longPeriod } = strategy.params;
        const prices = marketData.prices;

        const shortEMA = this.calculateEMA(prices, shortPeriod);
        const longEMA = this.calculateEMA(prices, longPeriod);

        const previousShortEMA = this.calculateEMA(prices.slice(0, -1), shortPeriod);
        const previousLongEMA = this.calculateEMA(prices.slice(0, -1), longPeriod);

        if (shortEMA > longEMA && previousShortEMA <= previousLongEMA) {
            return {
                strategyId: strategy.id,
                type: OrderType.MARKET,
                side: OrderSide.BUY,
                price: prices[prices.length - 1],
                timestamp: new Date(),
                confidence: this.calculateCrossoverConfidence(shortEMA, longEMA)
            };
        } else if (shortEMA < longEMA && previousShortEMA >= previousLongEMA) {
            return {
                strategyId: strategy.id,
                type: OrderType.MARKET,
                side: OrderSide.SELL,
                price: prices[prices.length - 1],
                timestamp: new Date(),
                confidence: this.calculateCrossoverConfidence(shortEMA, longEMA)
            };
        }

        return null;
    }

    private calculateEMA(prices: number[], period: number): number {
        const multiplier = 2 / (period + 1);
        let ema = prices[0];

        for (let i = 1; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    private async executeTradeSignal(
        signal: TradeSignal,
        strategy: Strategy
    ): Promise<void> {
        if (!await this.riskManagementService.validateTrade(signal, strategy)) {
            throw new Error('Trade signal rejected by risk management');
        }

        const tradeParams = {
            userId: strategy.userId,
            pair: strategy.pair,
            type: signal.type,
            side: signal.side,
            price: signal.price,
            amount: await this.calculateTradeAmount(strategy, signal),
            metadata: {
                strategyId: strategy.id,
                confidence: signal.confidence
            }
        };

        await this.tradingService.executeTrade(tradeParams);
    }

    private async calculateTradeAmount(
        strategy: Strategy,
        signal: TradeSignal
    ): Promise<number> {
        const balance = await this.tradingService.getBalance(strategy.userId);
        const riskPercentage = strategy.params.riskPercentage || 0.02;
        const availableAmount = new Big(balance).times(riskPercentage);

        return this.riskManagementService.calculatePositionSize(
            availableAmount.toNumber(),
            signal.price,
            strategy.params.stopLoss
        );
    }

    private async updateStrategyMetrics(
        strategy: Strategy,
        signal: TradeSignal
    ): Promise<void> {
        const metrics = strategy.metrics;
        metrics.totalTrades++;

        if (signal.success) {
            metrics.successfulTrades++;
            metrics.totalProfit += signal.profit || 0;
        } else {
            metrics.failedTrades++;
        }

        metrics.winRate = metrics.successfulTrades / metrics.totalTrades;
        metrics.averageReturnPerTrade = metrics.totalProfit / metrics.totalTrades;

        await this.persistStrategy(strategy);
        await this.metricsService.recordStrategyMetrics(strategy.id, metrics);
    }

    private async handleStrategyError(
        strategy: Strategy,
        error: Error
    ): Promise<void> {
        this.logger.error(`Strategy ${strategy.id} error:`, error);

        await this.metricsService.recordStrategyError({
            strategyId: strategy.id,
            error: error.message,
            timestamp: new Date()
        });

        if (this.shouldPauseStrategy(strategy)) {
            strategy.state = StrategyState.PAUSED;
            await this.persistStrategy(strategy);

            await this.notificationService.sendSystemAlert({
                component: 'TradingStrategy',
                type: 'STRATEGY_PAUSED',
                strategyId: strategy.id,
                error: error.message
            });
        }
    }

    private shouldPauseStrategy(strategy: Strategy): boolean {
        const recentErrors = this.getRecentErrors(strategy.id);
        return recentErrors.length >= 3;
    }

    private async persistStrategy(strategy: Strategy): Promise<void> {
        await this.redisService.set(
            `strategy:${strategy.id}`,
            JSON.stringify(strategy),
            'EX',
            86400 * 30
        );
    }

    private async loadPersistedStrategies(): Promise<void> {
        const keys = await this.redisService.keys('strategy:*');
        for (const key of keys) {
            const strategyData = await this.redisService.get(key);
            if (strategyData) {
                const strategy = JSON.parse(strategyData);
                if (strategy.state === StrategyState.ACTIVE) {
                    this.activeStrategies.set(strategy.id, strategy);
                    this.initializeSignalBuffer(strategy.id);
                }
            }
        }
    }

    private initializeSignalBuffer(strategyId: string): void {
        this.signalBuffer.set(strategyId, []);
    }

    private addToSignalBuffer(strategyId: string, signal: TradeSignal): void {
        const buffer = this.signalBuffer.get(strategyId) || [];
        buffer.push(signal);

        if (buffer.length > this.maxSignalBufferSize) {
            buffer.shift();
        }

        this.signalBuffer.set(strategyId, buffer);
    }

    private getRecentErrors(strategyId: string): Error[] {
        return this.signalBuffer.get(strategyId)
            ?.filter(signal => signal.error)
            .map(signal => signal.error!) || [];
    }

    private startStrategyMonitoring(): void {
        setInterval(() => {
            this.activeStrategies.forEach(async (strategy) => {
                try {
                    await this.executeStrategy(strategy.id);
                } catch (error) {
                    await this.handleStrategyError(strategy, error);
                }
            });
        }, this.configService.get('STRATEGY_INTERVAL_MS', 60000));
    }
}
