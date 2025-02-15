import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/RedisService';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { Decimal } from 'decimal.js';
import { OrderSide, OrderType, Trade } from '../../types/market.types';
import { BehaviorSubject, Observable } from 'rxjs';

interface PerformanceMetrics {
    totalPnL: Decimal;
    realizedPnL: Decimal;
    unrealizedPnL: Decimal;
    winRate: Decimal;
    profitFactor: Decimal;
    sharpeRatio: Decimal;
    maxDrawdown: Decimal;
    averageWin: Decimal;
    averageLoss: Decimal;
    largestWin: Decimal;
    largestLoss: Decimal;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
}

interface RiskMetrics {
    currentExposure: Decimal;
    leverageUtilization: Decimal;
    marginUtilization: Decimal;
    positionConcentration: Record<string, Decimal>;
    valueAtRisk: Decimal;
    stressTestLoss: Decimal;
}

@Injectable()
export class TradingMetrics implements OnModuleInit {
    private readonly METRICS_UPDATE_INTERVAL = 5000; // 5 seconds
    private readonly RISK_METRICS_UPDATE_INTERVAL = 60000; // 1 minute
    private readonly PERFORMANCE_KEY_PREFIX = 'trading:performance';
    private readonly RISK_KEY_PREFIX = 'trading:risk';

    private performanceMetrics$ = new BehaviorSubject<PerformanceMetrics>(null);
    private riskMetrics$ = new BehaviorSubject<RiskMetrics>(null);

    constructor(
        private readonly configService: ConfigService,
        private readonly redisService: RedisService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService
    ) {}

    async onModuleInit() {
        await this.initializeMetrics();
        this.startMetricsUpdates();
    }

    private async initializeMetrics() {
        try {
            const [performance, risk] = await Promise.all([
                this.loadPerformanceMetrics(),
                this.loadRiskMetrics()
            ]);

            this.performanceMetrics$.next(performance);
            this.riskMetrics$.next(risk);

            await this.auditService.logSystemEvent({
                event: 'TRADING_METRICS_INITIALIZED',
                details: { timestamp: new Date().toISOString() },
                severity: 'INFO'
            });
        } catch (error) {
            await this.handleError('initializeMetrics', error);
        }
    }

    private startMetricsUpdates() {
        setInterval(async () => {
            try {
                const performance = await this.calculatePerformanceMetrics();
                this.performanceMetrics$.next(performance);
                await this.persistPerformanceMetrics(performance);
            } catch (error) {
                await this.handleError('updatePerformanceMetrics', error);
            }
        }, this.METRICS_UPDATE_INTERVAL);

        setInterval(async () => {
            try {
                const risk = await this.calculateRiskMetrics();
                this.riskMetrics$.next(risk);
                await this.persistRiskMetrics(risk);
            } catch (error) {
                await this.handleError('updateRiskMetrics', error);
            }
        }, this.RISK_METRICS_UPDATE_INTERVAL);
    }

    async recordTrade(trade: Trade): Promise<void> {
        try {
            const performanceKey = `${this.PERFORMANCE_KEY_PREFIX}:trades`;
            await this.redisService.lpush(performanceKey, JSON.stringify(trade));

            // Update running statistics
            await this.updateRunningStatistics(trade);
            
            // Record metrics
            await this.metricsService.recordTrade({
                pair: trade.market,
                side: trade.side,
                volume: trade.size.toNumber(),
                value: trade.price.mul(trade.size).toNumber(),
                latency: Date.now() - trade.timestamp
            });
        } catch (error) {
            await this.handleError('recordTrade', error);
        }
    }

    getPerformanceMetrics(): Observable<PerformanceMetrics> {
        return this.performanceMetrics$.asObservable();
    }

    getRiskMetrics(): Observable<RiskMetrics> {
        return this.riskMetrics$.asObservable();
    }

    private async calculatePerformanceMetrics(): Promise<PerformanceMetrics> {
        const trades = await this.getRecentTrades();
        const positions = await this.getCurrentPositions();

        const realizedPnL = this.calculateRealizedPnL(trades);
        const unrealizedPnL = this.calculateUnrealizedPnL(positions);
        const totalPnL = realizedPnL.add(unrealizedPnL);

        const winningTrades = trades.filter(t => this.isWinningTrade(t));
        const losingTrades = trades.filter(t => !this.isWinningTrade(t));

        return {
            totalPnL,
            realizedPnL,
            unrealizedPnL,
            winRate: new Decimal(winningTrades.length).div(trades.length || 1),
            profitFactor: this.calculateProfitFactor(winningTrades, losingTrades),
            sharpeRatio: await this.calculateSharpeRatio(trades),
            maxDrawdown: await this.calculateMaxDrawdown(trades),
            averageWin: this.calculateAverageReturn(winningTrades),
            averageLoss: this.calculateAverageReturn(losingTrades),
            largestWin: this.findLargestReturn(winningTrades, true),
            largestLoss: this.findLargestReturn(losingTrades, false),
            totalTrades: trades.length,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length
        };
    }

    private async calculateRiskMetrics(): Promise<RiskMetrics> {
        const positions = await this.getCurrentPositions();
        const marketData = await this.getMarketData();

        return {
            currentExposure: this.calculateTotalExposure(positions),
            leverageUtilization: this.calculateLeverageUtilization(positions),
            marginUtilization: this.calculateMarginUtilization(positions),
            positionConcentration: this.calculatePositionConcentration(positions),
            valueAtRisk: await this.calculateValueAtRisk(positions, marketData),
            stressTestLoss: await this.calculateStressTestLoss(positions, marketData)
        };
    }

    private async persistPerformanceMetrics(metrics: PerformanceMetrics): Promise<void> {
        const key = `${this.PERFORMANCE_KEY_PREFIX}:${new Date().toISOString().split('T')[0]}`;
        await this.redisService.hset(key, metrics);
    }

    private async persistRiskMetrics(metrics: RiskMetrics): Promise<void> {
        const key = `${this.RISK_KEY_PREFIX}:${new Date().toISOString().split('T')[0]}`;
        await this.redisService.hset(key, metrics);
    }

    private async handleError(operation: string, error: any): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'TRADING_METRICS_ERROR',
            details: {
                operation,
                error: error.message,
                timestamp: new Date().toISOString()
            },
            severity: 'ERROR'
        });
        await this.metricsService.incrementError('trading_metrics');
    }

    private isWinningTrade(trade: Trade): boolean {
        return trade.side === OrderSide.BUY ? 
            trade.price.lessThan(trade.price) : 
            trade.price.greaterThan(trade.price);
    }

    private calculateProfitFactor(winningTrades: Trade[], losingTrades: Trade[]): Decimal {
        const totalWins = winningTrades.reduce((sum, trade) => 
            sum.add(this.calculateTradeReturn(trade)), new Decimal(0));
        const totalLosses = losingTrades.reduce((sum, trade) => 
            sum.add(this.calculateTradeReturn(trade)), new Decimal(0));
        
        return totalLosses.isZero() ? new Decimal(0) : totalWins.div(totalLosses.abs());
    }

    private calculateTradeReturn(trade: Trade): Decimal {
        // Implementation depends on your trade structure
        return new Decimal(0);
    }

    private async calculateSharpeRatio(trades: Trade[]): Promise<Decimal> {
        // Implementation of Sharpe ratio calculation
        return new Decimal(0);
    }

    private async calculateMaxDrawdown(trades: Trade[]): Promise<Decimal> {
        // Implementation of maximum drawdown calculation
        return new Decimal(0);
    }

    private calculateAverageReturn(trades: Trade[]): Decimal {
        if (!trades.length) return new Decimal(0);
        const totalReturn = trades.reduce((sum, trade) => 
            sum.add(this.calculateTradeReturn(trade)), new Decimal(0));
        return totalReturn.div(trades.length);
    }

    private findLargestReturn(trades: Trade[], isWin: boolean): Decimal {
        if (!trades.length) return new Decimal(0);
        return trades.reduce((max, trade) => {
            const return_ = this.calculateTradeReturn(trade);
            return isWin ? Decimal.max(max, return_) : Decimal.min(max, return_);
        }, isWin ? new Decimal('-Infinity') : new Decimal('Infinity'));
    }

    // Additional helper methods would be implemented here
}
