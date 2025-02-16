import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Market } from '@project-serum/serum';
import { TradingStrategy } from '../trading/TradingStrategy';
import { MarketDataCache } from '../market/MarketDataCache';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { Trade } from '../../entities/Trade.entity';
import { Position } from '../../entities/Position.entity';
import { BacktestResult } from '../../entities/BacktestResult.entity';
import { OrderSide, OrderType } from '../../types/market.types';
import { Decimal } from 'decimal.js';
import * as talib from 'talib-binding';
import * as fs from 'fs/promises';
import * as Papa from 'papaparse';

interface BacktestConfig {
    startDate: Date;
    endDate: Date;
    initialBalance: Decimal;
    markets: string[];
    fees: {
        maker: Decimal;
        taker: Decimal;
    };
    slippage: Decimal;
    strategy: {
        name: string;
        params: Record<string, any>;
    };
}

interface BacktestState {
    balance: Decimal;
    positions: Map<string, Position>;
    trades: Trade[];
    equity: { timestamp: Date; value: Decimal }[];
}

@Injectable()
export class BacktestingService {
    private readonly resultsDir = 'backtestResults';

    constructor(
        @InjectRepository(BacktestResult)
        private readonly backtestResultRepository: Repository<BacktestResult>,
        private readonly configService: ConfigService,
        private readonly tradingStrategy: TradingStrategy,
        private readonly marketDataCache: MarketDataCache,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService
    ) {
        this.initializeResultsDirectory();
    }

    private async initializeResultsDirectory() {
        try {
            await fs.mkdir(this.resultsDir, { recursive: true });
        } catch (error) {
            await this.handleError('initializeResultsDirectory', error);
        }
    }

    async runBacktest(config: BacktestConfig): Promise<BacktestResult> {
        try {
            const startTime = Date.now();
            const state = await this.initializeBacktestState(config);
            const marketData = await this.loadMarketData(config);
            
            // Run simulation
            const result = await this.simulateTrading(config, state, marketData);
            
            // Calculate metrics
            const metrics = this.calculatePerformanceMetrics(state, config);
            
            // Generate report
            const report = await this.generateBacktestReport(config, state, metrics);
            
            // Save results
            const backtestResult = new BacktestResult();
            backtestResult.config = config;
            backtestResult.metrics = metrics;
            backtestResult.trades = state.trades;
            backtestResult.report = report;
            backtestResult.duration = Date.now() - startTime;

            await this.backtestResultRepository.save(backtestResult);
            await this.exportResults(backtestResult);

            return backtestResult;
        } catch (error) {
            await this.handleError('runBacktest', error);
            throw error;
        }
    }

    private async initializeBacktestState(config: BacktestConfig): Promise<BacktestState> {
        return {
            balance: config.initialBalance,
            positions: new Map(),
            trades: [],
            equity: [{
                timestamp: config.startDate,
                value: config.initialBalance
            }]
        };
    }

    private async loadMarketData(config: BacktestConfig): Promise<Map<string, any[]>> {
        const marketData = new Map();
        
        for (const market of config.markets) {
            const candles = await this.marketDataCache.getHistoricalCandles(
                market,
                config.startDate,
                config.endDate,
                '1m'
            );

            marketData.set(market, this.preprocessMarketData(candles));
        }

        return marketData;
    }

    private preprocessMarketData(candles: any[]): any[] {
        return candles.map(candle => ({
            ...candle,
            indicators: this.calculateIndicators(candles)
        }));
    }

    private calculateIndicators(candles: any[]): any {
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);

        return {
            rsi: talib.RSI(closes, 14),
            macd: talib.MACD(closes, 12, 26, 9),
            bollinger: talib.BBANDS(closes, 20, 2, 2),
            atr: talib.ATR(highs, lows, closes, 14),
            obv: talib.OBV(closes, volumes)
        };
    }

    private async simulateTrading(
        config: BacktestConfig,
        state: BacktestState,
        marketData: Map<string, any[]>
    ): Promise<void> {
        for (const [market, data] of marketData.entries()) {
            for (let i = 0; i < data.length; i++) {
                const candle = data[i];
                const signal = await this.tradingStrategy.generateSignal(
                    market,
                    candle,
                    config.strategy.params
                );

                if (signal) {
                    await this.executeBacktestTrade(
                        market,
                        signal,
                        candle,
                        state,
                        config
                    );
                }

                // Update equity curve
                const equity = this.calculateCurrentEquity(state, marketData, i);
                state.equity.push({
                    timestamp: new Date(candle.timestamp),
                    value: equity
                });
            }
        }
    }

    private async executeBacktestTrade(
        market: string,
        signal: any,
        candle: any,
        state: BacktestState,
        config: BacktestConfig
    ): Promise<void> {
        const position = state.positions.get(market);
        const price = new Decimal(candle.close);
        
        // Apply slippage
        const executionPrice = signal.side === OrderSide.BUY ?
            price.mul(new Decimal(1).plus(config.slippage)) :
            price.mul(new Decimal(1).minus(config.slippage));

        // Calculate trade size
        const size = this.calculateTradeSize(
            state.balance,
            executionPrice,
            config.strategy.params.riskPerTrade
        );

        // Execute trade
        const trade = new Trade();
        trade.market = market;
        trade.side = signal.side;
        trade.price = executionPrice;
        trade.size = size;
        trade.timestamp = new Date(candle.timestamp);
        trade.fees = this.calculateFees(executionPrice, size, config.fees);

        // Update state
        this.updateBacktestState(state, trade, position);
        state.trades.push(trade);
    }

    private calculateTradeSize(
        balance: Decimal,
        price: Decimal,
        riskPerTrade: Decimal
    ): Decimal {
        const riskAmount = balance.mul(riskPerTrade);
        return riskAmount.div(price);
    }

    private calculateFees(
        price: Decimal,
        size: Decimal,
        fees: { maker: Decimal; taker: Decimal }
    ): Decimal {
        const notional = price.mul(size);
        return notional.mul(fees.taker);
    }

    private updateBacktestState(
        state: BacktestState,
        trade: Trade,
        position?: Position
    ): void {
        // Update balance
        const tradeCost = trade.price.mul(trade.size);
        state.balance = state.balance.minus(tradeCost).minus(trade.fees);

        // Update position
        if (!position) {
            position = new Position();
            position.market = trade.market;
            position.size = new Decimal(0);
            position.avgEntryPrice = new Decimal(0);
            state.positions.set(trade.market, position);
        }

        if (trade.side === OrderSide.BUY) {
            position.size = position.size.plus(trade.size);
        } else {
            position.size = position.size.minus(trade.size);
        }

        position.avgEntryPrice = position.size.isZero() ?
            new Decimal(0) :
            position.avgEntryPrice.plus(trade.price).div(2);
    }

    private calculateCurrentEquity(
        state: BacktestState,
        marketData: Map<string, any[]>,
        currentIndex: number
    ): Decimal {
        let equity = state.balance;

        for (const [market, position] of state.positions.entries()) {
            if (!position.size.isZero()) {
                const currentPrice = new Decimal(marketData.get(market)[currentIndex].close);
                equity = equity.plus(position.size.mul(currentPrice));
            }
        }

        return equity;
    }

    private calculatePerformanceMetrics(
        state: BacktestState,
        config: BacktestConfig
    ): any {
        const returns = this.calculateReturns(state.equity);
        const trades = state.trades;
        const winningTrades = trades.filter(t => this.isWinningTrade(t));

        return {
            totalReturn: this.calculateTotalReturn(state.equity),
            sharpeRatio: this.calculateSharpeRatio(returns),
            maxDrawdown: this.calculateMaxDrawdown(state.equity),
            winRate: winningTrades.length / trades.length,
            profitFactor: this.calculateProfitFactor(trades),
            averageWin: this.calculateAverageTradeReturn(winningTrades),
            averageLoss: this.calculateAverageTradeReturn(trades.filter(t => !this.isWinningTrade(t))),
            totalTrades: trades.length,
            tradesPerDay: trades.length / this.calculateTradingDays(config)
        };
    }

    private async generateBacktestReport(
        config: BacktestConfig,
        state: BacktestState,
        metrics: any
    ): Promise<string> {
        const report = {
            config,
            metrics,
            equity: state.equity,
            trades: state.trades.map(t => ({
                market: t.market,
                side: t.side,
                price: t.price.toString(),
                size: t.size.toString(),
                timestamp: t.timestamp,
                fees: t.fees.toString()
            }))
        };

        return JSON.stringify(report, null, 2);
    }

    private async exportResults(result: BacktestResult): Promise<void> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${this.resultsDir}/backtest_${result.id}_${timestamp}`;

        // Export JSON report
        await fs.writeFile(
            `${filename}.json`,
            JSON.stringify(result.report, null, 2)
        );

        // Export CSV trades
        const csvData = Papa.unparse(result.trades.map(t => ({
            market: t.market,
            side: t.side,
            price: t.price.toString(),
            size: t.size.toString(),
            timestamp: t.timestamp,
            fees: t.fees.toString()
        })));

        await fs.writeFile(`${filename}_trades.csv`, csvData);
    }

    private async handleError(
        operation: string,
        error: Error
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'BACKTEST_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('backtest');
    }
}
