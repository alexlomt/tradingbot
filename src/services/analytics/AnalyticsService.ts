import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Trade } from '../../entities/Trade.entity';
import { Position } from '../../entities/Position.entity';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { Decimal } from 'decimal.js';
import { BehaviorSubject, Observable } from 'rxjs';

interface AnalyticsMetrics {
    totalPnL: Decimal;
    dailyPnL: Decimal;
    winRate: Decimal;
    averageWin: Decimal;
    averageLoss: Decimal;
    largestWin: Decimal;
    largestLoss: Decimal;
    profitFactor: Decimal;
    sharpeRatio: Decimal;
    trades: {
        total: number;
        winning: number;
        losing: number;
    };
}

interface MarketMetrics {
    volume24h: Decimal;
    trades24h: number;
    volatility24h: Decimal;
    liquidity: Decimal;
}

@Injectable()
export class AnalyticsService implements OnModuleInit {
    private readonly metricsUpdates = new BehaviorSubject<AnalyticsMetrics | null>(null);
    private readonly marketMetrics = new Map<string, MarketMetrics>();
    private readonly UPDATE_INTERVAL = 60000; // 1 minute

    constructor(
        @InjectRepository(Trade)
        private readonly tradeRepository: Repository<Trade>,
        @InjectRepository(Position)
        private readonly positionRepository: Repository<Position>,
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService
    ) {}

    async onModuleInit() {
        await this.initializeAnalytics();
        this.startPeriodicUpdates();
    }

    private async initializeAnalytics() {
        try {
            const metrics = await this.calculateMetrics();
            this.metricsUpdates.next(metrics);
        } catch (error) {
            await this.handleError('initializeAnalytics', error);
        }
    }

    private startPeriodicUpdates() {
        setInterval(async () => {
            try {
                const metrics = await this.calculateMetrics();
                this.metricsUpdates.next(metrics);
            } catch (error) {
                await this.handleError('periodicUpdate', error);
            }
        }, this.UPDATE_INTERVAL);
    }

    private async calculateMetrics(): Promise<AnalyticsMetrics> {
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        const [trades, positions] = await Promise.all([
            this.tradeRepository.find({
                where: { timestamp: Between(dayAgo, new Date()) }
            }),
            this.positionRepository.find()
        ]);

        const winningTrades = trades.filter(t => t.realizedPnL.gt(0));
        const losingTrades = trades.filter(t => t.realizedPnL.lt(0));

        const totalPnL = trades.reduce(
            (sum, trade) => sum.plus(trade.realizedPnL),
            new Decimal(0)
        );

        const unrealizedPnL = positions.reduce(
            (sum, pos) => sum.plus(pos.unrealizedPnL),
            new Decimal(0)
        );

        const winRate = new Decimal(winningTrades.length).div(trades.length);

        const averageWin = winningTrades.length > 0 ?
            winningTrades.reduce(
                (sum, trade) => sum.plus(trade.realizedPnL),
                new Decimal(0)
            ).div(winningTrades.length) :
            new Decimal(0);

        const averageLoss = losingTrades.length > 0 ?
            losingTrades.reduce(
                (sum, trade) => sum.plus(trade.realizedPnL.abs()),
                new Decimal(0)
            ).div(losingTrades.length) :
            new Decimal(0);

        const profitFactor = averageLoss.isZero() ? 
            new Decimal(0) : 
            averageWin.div(averageLoss);

        const returns = this.calculateDailyReturns(trades);
        const sharpeRatio = this.calculateSharpeRatio(returns);

        return {
            totalPnL,
            dailyPnL: totalPnL.plus(unrealizedPnL),
            winRate,
            averageWin,
            averageLoss,
            largestWin: winningTrades.reduce(
                (max, trade) => Decimal.max(max, trade.realizedPnL),
                new Decimal(0)
            ),
            largestLoss: losingTrades.reduce(
                (max, trade) => Decimal.max(max, trade.realizedPnL.abs()),
                new Decimal(0)
            ),
            profitFactor,
            sharpeRatio,
            trades: {
                total: trades.length,
                winning: winningTrades.length,
                losing: losingTrades.length
            }
        };
    }

    private calculateDailyReturns(trades: Trade[]): Decimal[] {
        const dailyPnL = new Map<string, Decimal>();
        
        for (const trade of trades) {
            const date = trade.timestamp.toISOString().split('T')[0];
            const current = dailyPnL.get(date) || new Decimal(0);
            dailyPnL.set(date, current.plus(trade.realizedPnL));
        }

        return Array.from(dailyPnL.values());
    }

    private calculateSharpeRatio(returns: Decimal[]): Decimal {
        if (returns.length < 2) return new Decimal(0);

        const meanReturn = returns.reduce(
            (sum, ret) => sum.plus(ret),
            new Decimal(0)
        ).div(returns.length);

        const variance = returns.reduce(
            (sum, ret) => sum.plus(ret.minus(meanReturn).pow(2)),
            new Decimal(0)
        ).div(returns.length - 1);

        const stdDev = variance.sqrt();
        return stdDev.isZero() ? 
            new Decimal(0) : 
            meanReturn.div(stdDev).mul(Math.sqrt(252)); // Annualized
    }

    async getMarketMetrics(market: string): Promise<MarketMetrics | null> {
        return this.marketMetrics.get(market) || null;
    }

    getAnalyticsUpdates(): Observable<AnalyticsMetrics | null> {
        return this.metricsUpdates.asObservable();
    }

    private async handleError(
        operation: string,
        error: Error
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'ANALYTICS_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('analytics');
    }
}
