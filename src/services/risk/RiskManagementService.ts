import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PositionTrackingService } from '../position/PositionTrackingService';
import { MarketDataCache } from '../market/MarketDataCache';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { WalletService } from '../wallet/WalletService';
import { OrderRequest } from '../../types/order.types';
import { Position } from '../../entities/Position.entity';
import { MarketRiskLimits, RiskMetrics, RiskLevel } from '../../types/risk.types';
import { Decimal } from 'decimal.js';
import { BehaviorSubject, Observable } from 'rxjs';

interface RiskConfig {
    maxPositionSize: Decimal;
    maxLeverage: Decimal;
    maxDrawdown: Decimal;
    maxDailyLoss: Decimal;
    maxOpenPositions: number;
    marginCallLevel: Decimal;
    liquidationLevel: Decimal;
    volatilityMultiplier: Decimal;
}

@Injectable()
export class RiskManagementService implements OnModuleInit {
    private riskConfig: RiskConfig;
    private marketLimits: Map<string, MarketRiskLimits> = new Map();
    private riskMetrics: BehaviorSubject<RiskMetrics>;
    private readonly UPDATE_INTERVAL = 5000; // 5 seconds
    private dailyPnL: Map<string, Decimal> = new Map();
    private readonly MAX_RETRIES = 3;

    constructor(
        private readonly configService: ConfigService,
        private readonly positionTracking: PositionTrackingService,
        private readonly marketDataCache: MarketDataCache,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService,
        private readonly walletService: WalletService
    ) {
        this.initializeRiskConfig();
    }

    async onModuleInit() {
        await this.initializeMarketLimits();
        await this.startRiskMonitoring();
        await this.subscribeToPnLUpdates();
    }

    private initializeRiskConfig() {
        this.riskConfig = {
            maxPositionSize: new Decimal(this.configService.get('RISK_MAX_POSITION_SIZE')),
            maxLeverage: new Decimal(this.configService.get('RISK_MAX_LEVERAGE')),
            maxDrawdown: new Decimal(this.configService.get('RISK_MAX_DRAWDOWN')),
            maxDailyLoss: new Decimal(this.configService.get('RISK_MAX_DAILY_LOSS')),
            maxOpenPositions: this.configService.get('RISK_MAX_OPEN_POSITIONS'),
            marginCallLevel: new Decimal(this.configService.get('RISK_MARGIN_CALL_LEVEL')),
            liquidationLevel: new Decimal(this.configService.get('RISK_LIQUIDATION_LEVEL')),
            volatilityMultiplier: new Decimal(this.configService.get('RISK_VOLATILITY_MULTIPLIER'))
        };
    }

    private async initializeMarketLimits() {
        const markets = await this.marketDataCache.getMarkets();
        
        for (const market of markets) {
            const volatility = await this.calculateVolatility(market.id);
            const limits = this.calculateMarketLimits(market, volatility);
            this.marketLimits.set(market.id, limits);
        }
    }

    private async startRiskMonitoring() {
        setInterval(async () => {
            try {
                const metrics = await this.calculateRiskMetrics();
                this.riskMetrics.next(metrics);
                await this.checkRiskLevels(metrics);
            } catch (error) {
                await this.handleError('riskMonitoring', error);
            }
        }, this.UPDATE_INTERVAL);
    }

    private async subscribeToPnLUpdates() {
        this.positionTracking.getRiskUpdates().subscribe(async (updates) => {
            for (const [market, risk] of updates.entries()) {
                const currentPnL = this.dailyPnL.get(market) || new Decimal(0);
                this.dailyPnL.set(market, currentPnL.plus(risk.unrealizedPnL));
                
                if (this.dailyPnL.get(market).abs().gt(this.riskConfig.maxDailyLoss)) {
                    await this.handleDailyLossExceeded(market);
                }
            }
        });
    }

    async validateOrderRisk(order: OrderRequest): Promise<boolean> {
        const limits = this.marketLimits.get(order.market);
        if (!limits) {
            throw new Error(`No risk limits found for market ${order.market}`);
        }

        const positions = await this.positionTracking.getPositions();
        const currentPosition = positions.get(order.market);
        const totalPositions = Array.from(positions.values()).filter(p => !p.size.isZero()).length;

        // Check position count limit
        if (totalPositions >= this.riskConfig.maxOpenPositions && !currentPosition) {
            throw new Error('Maximum number of open positions reached');
        }

        // Check position size limit
        const newSize = currentPosition ? 
            currentPosition.size.plus(order.size) :
            order.size;

        if (newSize.abs().gt(limits.maxPositionSize)) {
            throw new Error('Order would exceed maximum position size');
        }

        // Check leverage limit
        const leverage = this.calculateLeverage(order, currentPosition);
        if (leverage.gt(this.riskConfig.maxLeverage)) {
            throw new Error('Order would exceed maximum leverage');
        }

        // Check volatility-adjusted limits
        const volatility = await this.calculateVolatility(order.market);
        const adjustedSize = order.size.mul(volatility.mul(this.riskConfig.volatilityMultiplier));
        
        if (adjustedSize.gt(limits.maxPositionSize)) {
            throw new Error('Order size too large for current market volatility');
        }

        return true;
    }

    private async calculateRiskMetrics(): Promise<RiskMetrics> {
        const positions = await this.positionTracking.getPositions();
        const collateral = await this.walletService.getCollateralBalance();
        
        let totalExposure = new Decimal(0);
        let maxLeverage = new Decimal(0);
        let unrealizedPnL = new Decimal(0);
        let realizedPnL = new Decimal(0);

        for (const [market, position] of positions.entries()) {
            const price = await this.marketDataCache.getLastPrice(market);
            const exposure = position.size.mul(price);
            totalExposure = totalExposure.plus(exposure.abs());
            
            const leverage = exposure.div(collateral);
            maxLeverage = Decimal.max(maxLeverage, leverage.abs());
            
            unrealizedPnL = unrealizedPnL.plus(position.unrealizedPnL);
            realizedPnL = realizedPnL.plus(position.realizedPnL);
        }

        return {
            timestamp: new Date(),
            totalExposure,
            maxLeverage,
            unrealizedPnL,
            realizedPnL,
            marginUtilization: totalExposure.div(collateral),
            riskLevel: this.determineRiskLevel(totalExposure, collateral)
        };
    }

    private async calculateVolatility(market: string): Promise<Decimal> {
        const prices = await this.marketDataCache.getPriceHistory(market, 24); // 24 hours
        if (prices.length < 2) {
            return new Decimal(1);
        }

        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push(
                new Decimal(prices[i])
                    .div(prices[i - 1])
                    .ln()
            );
        }

        const mean = returns.reduce((a, b) => a.plus(b), new Decimal(0))
            .div(returns.length);

        const variance = returns
            .reduce((sum, ret) => sum.plus(ret.minus(mean).pow(2)), new Decimal(0))
            .div(returns.length);

        return variance.sqrt().mul(Math.sqrt(252 * 24)); // Annualized volatility
    }

    private calculateMarketLimits(market: any, volatility: Decimal): MarketRiskLimits {
        const baseLimit = this.riskConfig.maxPositionSize;
        const adjustedLimit = baseLimit.div(volatility.mul(this.riskConfig.volatilityMultiplier));

        return {
            maxPositionSize: adjustedLimit,
            maxLeverage: this.riskConfig.maxLeverage,
            maxNotionalValue: adjustedLimit.mul(market.lastPrice)
        };
    }

    private determineRiskLevel(exposure: Decimal, collateral: Decimal): RiskLevel {
        const utilization = exposure.div(collateral);

        if (utilization.gte(this.riskConfig.liquidationLevel)) {
            return RiskLevel.CRITICAL;
        } else if (utilization.gte(this.riskConfig.marginCallLevel)) {
            return RiskLevel.HIGH;
        } else if (utilization.gte(this.riskConfig.marginCallLevel.mul(0.8))) {
            return RiskLevel.MEDIUM;
        } else {
            return RiskLevel.LOW;
        }
    }

    private calculateLeverage(order: OrderRequest, currentPosition?: Position): Decimal {
        const collateral = this.walletService.getCollateralBalance();
        const newExposure = (currentPosition?.size || new Decimal(0))
            .plus(order.size)
            .mul(order.price);
        
        return newExposure.abs().div(collateral);
    }

    private async handleDailyLossExceeded(market: string) {
        await this.auditService.logSystemEvent({
            event: 'DAILY_LOSS_LIMIT_EXCEEDED',
            details: {
                market,
                loss: this.dailyPnL.get(market).toString()
            },
            severity: 'CRITICAL'
        });

        // Close position if auto-close is enabled
        if (this.configService.get('RISK_AUTO_CLOSE_ON_LOSS_LIMIT')) {
            await this.positionTracking.closePosition(market);
        }
    }

    private async checkRiskLevels(metrics: RiskMetrics) {
        if (metrics.riskLevel >= RiskLevel.HIGH) {
            await this.auditService.logSystemEvent({
                event: 'HIGH_RISK_LEVEL_DETECTED',
                details: {
                    level: RiskLevel[metrics.riskLevel],
                    marginUtilization: metrics.marginUtilization.toString(),
                    totalExposure: metrics.totalExposure.toString()
                },
                severity: 'WARNING'
            });

            if (metrics.riskLevel === RiskLevel.CRITICAL) {
                await this.handleCriticalRiskLevel();
            }
        }
    }

    private async handleCriticalRiskLevel() {
        if (this.configService.get('RISK_AUTO_DELEVERAGING')) {
            const positions = await this.positionTracking.getPositions();
            
            // Close positions from largest to smallest until risk is reduced
            const sortedPositions = Array.from(positions.entries())
                .sort((a, b) => b[1].size.abs().comparedTo(a[1].size.abs()));

            for (const [market] of sortedPositions) {
                await this.positionTracking.closePosition(market);
                
                const newMetrics = await this.calculateRiskMetrics();
                if (newMetrics.riskLevel < RiskLevel.CRITICAL) {
                    break;
                }
            }
        }
    }

    private async handleError(
        operation: string,
        error: Error
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'RISK_MANAGEMENT_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('risk_management');
    }

    getRiskMetrics(): Observable<RiskMetrics> {
        return this.riskMetrics.asObservable();
    }
}
