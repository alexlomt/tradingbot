import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketDataCache } from '../market/MarketDataCache';
import { OrderManagementService } from '../order/OrderManagementService';
import { PositionTrackingService } from '../position/PositionTrackingService';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { WebSocketService } from '../websocket/WebSocketService';
import { Decimal } from 'decimal.js';
import { OrderSide, OrderType } from '../../types/market.types';
import * as talib from 'talib-binding';
import { BehaviorSubject, Observable } from 'rxjs';

interface StrategyConfig {
    enabled: boolean;
    name: string;
    market: string;
    timeframe: string;
    entrySize: Decimal;
    maxPositions: number;
    stopLoss: Decimal;
    takeProfit: Decimal;
    indicators: {
        rsi: {
            period: number;
            overbought: number;
            oversold: number;
        };
        ema: {
            shortPeriod: number;
            longPeriod: number;
        };
        volatility: {
            period: number;
            threshold: number;
        };
    };
}

interface StrategySignal {
    market: string;
    side: OrderSide;
    strength: number;
    price: Decimal;
    timestamp: Date;
    indicators: {
        rsi: number;
        emaCross: number;
        volatility: number;
    };
}

@Injectable()
export class TradingStrategy implements OnModuleInit {
    private readonly strategies: Map<string, StrategyConfig> = new Map();
    private readonly signalUpdates = new BehaviorSubject<StrategySignal[]>([]);
    private readonly UPDATE_INTERVAL = 1000; // 1 second
    private candleData: Map<string, any[]> = new Map();
    private lastSignals: Map<string, StrategySignal> = new Map();

    constructor(
        private readonly configService: ConfigService,
        private readonly marketDataCache: MarketDataCache,
        private readonly orderManagement: OrderManagementService,
        private readonly positionTracking: PositionTrackingService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService,
        private readonly webSocketService: WebSocketService
    ) {}

    async onModuleInit() {
        await this.loadStrategies();
        await this.initializeDataFeeds();
        this.startStrategyUpdates();
    }

    private async loadStrategies() {
        const strategyConfigs = this.configService.get<StrategyConfig[]>('TRADING_STRATEGIES');
        
        for (const config of strategyConfigs) {
            if (config.enabled) {
                this.strategies.set(config.market, config);
                await this.auditService.logSystemEvent({
                    event: 'STRATEGY_LOADED',
                    details: {
                        market: config.market,
                        strategy: config.name
                    },
                    severity: 'INFO'
                });
            }
        }
    }

    private async initializeDataFeeds() {
        for (const [market, config] of this.strategies) {
            // Initialize candle data storage
            this.candleData.set(market, []);

            // Subscribe to market data
            await this.webSocketService.subscribe(`candles:${market}:${config.timeframe}`, 
                async (candle) => {
                    await this.handleCandleUpdate(market, candle);
                }
            );
        }
    }

    private async handleCandleUpdate(market: string, candle: any) {
        const data = this.candleData.get(market) || [];
        data.push(candle);

        // Keep only necessary historical data
        const maxPeriod = Math.max(
            this.strategies.get(market).indicators.ema.longPeriod,
            this.strategies.get(market).indicators.rsi.period,
            this.strategies.get(market).indicators.volatility.period
        );

        if (data.length > maxPeriod * 2) {
            data.shift();
        }

        this.candleData.set(market, data);
        await this.generateSignals(market);
    }

    private startStrategyUpdates() {
        setInterval(async () => {
            try {
                for (const [market, config] of this.strategies) {
                    if (await this.shouldUpdateStrategy(market)) {
                        await this.executeStrategy(market);
                    }
                }
            } catch (error) {
                await this.handleError('strategyUpdate', error);
            }
        }, this.UPDATE_INTERVAL);
    }

    private async shouldUpdateStrategy(market: string): Promise<boolean> {
        const config = this.strategies.get(market);
        if (!config.enabled) return false;

        const positions = await this.positionTracking.getPositions();
        const currentPosition = positions.get(market);

        // Check if we already have maximum positions
        if (currentPosition && positions.size >= config.maxPositions) {
            return false;
        }

        // Check if we have enough data
        const data = this.candleData.get(market);
        return data && data.length >= Math.max(
            config.indicators.ema.longPeriod,
            config.indicators.rsi.period,
            config.indicators.volatility.period
        );
    }

    private async generateSignals(market: string): Promise<void> {
        const config = this.strategies.get(market);
        const data = this.candleData.get(market);
        
        if (!data || data.length < config.indicators.ema.longPeriod) {
            return;
        }

        const closes = data.map(d => d.close);
        const highs = data.map(d => d.high);
        const lows = data.map(d => d.low);

        // Calculate RSI
        const rsi = talib.RSI(closes, config.indicators.rsi.period);
        
        // Calculate EMAs
        const shortEma = talib.EMA(closes, config.indicators.ema.shortPeriod);
        const longEma = talib.EMA(closes, config.indicators.ema.longPeriod);
        
        // Calculate Volatility (ATR)
        const atr = talib.ATR(highs, lows, closes, config.indicators.volatility.period);

        const currentPrice = new Decimal(closes[closes.length - 1]);
        const signal: StrategySignal = {
            market,
            side: this.determineSignalSide(
                rsi[rsi.length - 1],
                shortEma[shortEma.length - 1],
                longEma[longEma.length - 1],
                config
            ),
            strength: this.calculateSignalStrength(
                rsi[rsi.length - 1],
                shortEma[shortEma.length - 1],
                longEma[longEma.length - 1],
                atr[atr.length - 1],
                config
            ),
            price: currentPrice,
            timestamp: new Date(),
            indicators: {
                rsi: rsi[rsi.length - 1],
                emaCross: shortEma[shortEma.length - 1] - longEma[longEma.length - 1],
                volatility: atr[atr.length - 1]
            }
        };

        this.lastSignals.set(market, signal);
        this.signalUpdates.next(Array.from(this.lastSignals.values()));

        await this.metricsService.recordStrategySignal(signal);
    }

    private determineSignalSide(
        rsi: number,
        shortEma: number,
        longEma: number,
        config: StrategyConfig
    ): OrderSide {
        // RSI conditions
        const isOverbought = rsi > config.indicators.rsi.overbought;
        const isOversold = rsi < config.indicators.rsi.oversold;

        // EMA cross conditions
        const isGoldenCross = shortEma > longEma;
        const isDeathCross = shortEma < longEma;

        if (isOversold && isGoldenCross) {
            return OrderSide.BUY;
        } else if (isOverbought && isDeathCross) {
            return OrderSide.SELL;
        }

        return null;
    }

    private calculateSignalStrength(
        rsi: number,
        shortEma: number,
        longEma: number,
        volatility: number,
        config: StrategyConfig
    ): number {
        let strength = 0;

        // RSI contribution
        const rsiDelta = Math.abs(50 - rsi) / 50;
        strength += rsiDelta * 0.4;

        // EMA cross contribution
        const emaDelta = Math.abs(shortEma - longEma) / longEma;
        strength += emaDelta * 0.4;

        // Volatility contribution
        const volRatio = volatility / config.indicators.volatility.threshold;
        strength += Math.min(volRatio, 1) * 0.2;

        return Math.min(strength, 1);
    }

    private async executeStrategy(market: string) {
        const config = this.strategies.get(market);
        const signal = this.lastSignals.get(market);

        if (!signal || !signal.side) {
            return;
        }

        const positions = await this.positionTracking.getPositions();
        const currentPosition = positions.get(market);

        try {
            if (this.shouldTakePosition(signal, currentPosition, config)) {
                await this.openPosition(signal, config);
            } else if (this.shouldClosePosition(signal, currentPosition, config)) {
                await this.closePosition(market, currentPosition);
            }
        } catch (error) {
            await this.handleError('executeStrategy', error);
        }
    }

    private shouldTakePosition(
        signal: StrategySignal,
        currentPosition: any,
        config: StrategyConfig
    ): boolean {
        return signal.strength > 0.7 && 
               (!currentPosition || currentPosition.size.isZero()) &&
               signal.indicators.volatility < config.indicators.volatility.threshold;
    }

    private shouldClosePosition(
        signal: StrategySignal,
        currentPosition: any,
        config: StrategyConfig
    ): boolean {
        if (!currentPosition || currentPosition.size.isZero()) {
            return false;
        }

        const unrealizedPnL = currentPosition.unrealizedPnL;
        const stopLossPrice = currentPosition.avgEntryPrice.mul(
            currentPosition.size.isPositive() ? 
                new Decimal(1).minus(config.stopLoss) :
                new Decimal(1).plus(config.stopLoss)
        );

        const takeProfitPrice = currentPosition.avgEntryPrice.mul(
            currentPosition.size.isPositive() ?
                new Decimal(1).plus(config.takeProfit) :
                new Decimal(1).minus(config.takeProfit)
        );

        return signal.price.lessThan(stopLossPrice) ||
               signal.price.greaterThan(takeProfitPrice) ||
               (signal.side && signal.side !== (currentPosition.size.isPositive() ? OrderSide.BUY : OrderSide.SELL));
    }

    private async openPosition(signal: StrategySignal, config: StrategyConfig) {
        await this.orderManagement.createOrder({
            market: signal.market,
            side: signal.side,
            size: config.entrySize,
            type: OrderType.MARKET,
            price: signal.price
        });

        await this.auditService.logSystemEvent({
            event: 'STRATEGY_POSITION_OPENED',
            details: {
                market: signal.market,
                side: signal.side,
                price: signal.price.toString(),
                size: config.entrySize.toString(),
                strength: signal.strength
            },
            severity: 'INFO'
        });
    }

    private async closePosition(market: string, position: any) {
        await this.positionTracking.closePosition(market);

        await this.auditService.logSystemEvent({
            event: 'STRATEGY_POSITION_CLOSED',
            details: {
                market,
                size: position.size.toString(),
                pnl: position.unrealizedPnL.toString()
            },
            severity: 'INFO'
        });
    }

    getSignalUpdates(): Observable<StrategySignal[]> {
        return this.signalUpdates.asObservable();
    }

    private async handleError(
        operation: string,
        error: Error
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'STRATEGY_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('strategy');
    }
}
