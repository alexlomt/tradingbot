import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PositionManager } from './PositionManager';
import { MetricsService } from '../metrics/MetricsService';
import { NotificationService } from '../notification/NotificationService';
import { CircuitBreakerService } from '../circuit-breaker/CircuitBreakerService';
import { MarketDataService } from '../market/MarketDataService';
import { SPLTokenService } from '../../tokens/SPLTokenService';
import {
    RiskParameters,
    RiskMetrics,
    PositionRisk,
    RiskLimits,
    MarketRisk,
    OrderRisk,
    RiskAlert,
    RiskLevel
} from './types';
import { OrderSide, OrderType } from '../../types/trading.types';
import { MarketMakingStrategy } from '../trading/types/marketMaking.types';
import BigNumber from 'bignumber.js';

@Injectable()
export class RiskManagementService implements OnModuleInit {
    private readonly logger = new Logger(RiskManagementService.name);
    private readonly riskLimits: Map<string, RiskLimits> = new Map();
    private readonly marketRisks: Map<string, MarketRisk> = new Map();
    private readonly updateInterval: number;
    private readonly maxDrawdown: number;
    private readonly maxLeverage: number;
    private readonly maxConcentration: number;

    constructor(
        private readonly configService: ConfigService,
        private readonly positionManager: PositionManager,
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly marketDataService: MarketDataService,
        private readonly splTokenService: SPLTokenService,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.updateInterval = this.configService.get('RISK_UPDATE_INTERVAL_MS', 5000);
        this.maxDrawdown = this.configService.get('MAX_DRAWDOWN_PERCENT', 5);
        this.maxLeverage = this.configService.get('MAX_LEVERAGE', 3);
        this.maxConcentration = this.configService.get('MAX_POSITION_CONCENTRATION', 20);
    }

    async onModuleInit() {
        await this.loadRiskParameters();
        this.startRiskMonitoring();
        this.subscribeToMarketEvents();
    }

    async validateOrder(order: OrderRisk): Promise<boolean> {
        return this.circuitBreaker.executeFunction(
            'validate_order',
            async () => {
                const marketRisk = await this.getMarketRisk(order.marketId);
                const positionRisk = await this.positionManager.getPositionRisk(
                    order.marketId
                );

                // Size checks
                if (!this.validateOrderSize(order, marketRisk)) {
                    throw new Error('Order size exceeds risk limits');
                }

                // Position concentration
                if (!this.validateConcentration(order, positionRisk)) {
                    throw new Error('Position concentration exceeds limits');
                }

                // Available balance
                if (!await this.validateBalance(order)) {
                    throw new Error('Insufficient balance for order');
                }

                // Market volatility
                if (!this.validateVolatility(order, marketRisk)) {
                    throw new Error('Market volatility exceeds risk tolerance');
                }

                await this.recordOrderValidation(order, true);
                return true;
            }
        );
    }

    async validateStrategy(strategy: MarketMakingStrategy): Promise<boolean> {
        const marketRisk = await this.getMarketRisk(strategy.marketId);
        
        // Validate spread parameters
        if (!this.validateSpreadRisk(strategy, marketRisk)) {
            throw new Error('Strategy spread parameters exceed risk limits');
        }

        // Validate inventory limits
        if (!this.validateInventoryRisk(strategy)) {
            throw new Error('Strategy inventory parameters exceed risk limits');
        }

        // Validate order frequency
        if (!this.validateOrderFrequency(strategy, marketRisk)) {
            throw new Error('Strategy order frequency exceeds limits');
        }

        await this.recordStrategyValidation(strategy, true);
        return true;
    }

    async updateRiskLimits(
        marketId: string,
        limits: RiskLimits
    ): Promise<void> {
        await this.validateRiskLimits(limits);
        this.riskLimits.set(marketId, limits);
        await this.notifyRiskUpdate(marketId, limits);
    }

    private async loadRiskParameters(): Promise<void> {
        const parameters = this.configService.get<RiskParameters>('RISK_PARAMETERS');
        
        for (const [marketId, params] of Object.entries(parameters)) {
            this.riskLimits.set(marketId, {
                maxOrderSize: new BigNumber(params.maxOrderSize),
                maxPositionSize: new BigNumber(params.maxPositionSize),
                maxDrawdown: params.maxDrawdown || this.maxDrawdown,
                maxLeverage: params.maxLeverage || this.maxLeverage,
                volatilityThreshold: params.volatilityThreshold,
                minOrderInterval: params.minOrderInterval,
                maxDailyVolume: new BigNumber(params.maxDailyVolume)
            });
        }
    }

    private startRiskMonitoring(): void {
        setInterval(async () => {
            try {
                await this.updateMarketRisks();
                await this.checkRiskLevels();
            } catch (error) {
                this.logger.error('Risk monitoring error:', error);
                await this.handleMonitoringError(error);
            }
        }, this.updateInterval);
    }

    private async updateMarketRisks(): Promise<void> {
        for (const [marketId, limits] of this.riskLimits) {
            const marketRisk = await this.calculateMarketRisk(marketId, limits);
            this.marketRisks.set(marketId, marketRisk);
            await this.recordRiskMetrics(marketId, marketRisk);
        }
    }

    private async calculateMarketRisk(
        marketId: string,
        limits: RiskLimits
    ): Promise<MarketRisk> {
        const [volatility, volume, price] = await Promise.all([
            this.marketDataService.getVolatility(marketId),
            this.marketDataService.get24HourVolume(marketId),
            this.marketDataService.getCurrentPrice(marketId)
        ]);

        const positionRisk = await this.positionManager.getPositionRisk(marketId);
        const volumeRisk = volume.dividedBy(limits.maxDailyVolume);
        const volatilityRisk = volatility.dividedBy(limits.volatilityThreshold);

        return {
            marketId,
            timestamp: new Date(),
            volatility,
            volume,
            price,
            volumeRisk: volumeRisk.toNumber(),
            volatilityRisk: volatilityRisk.toNumber(),
            positionRisk,
            riskLevel: this.calculateRiskLevel({
                volumeRisk: volumeRisk.toNumber(),
                volatilityRisk: volatilityRisk.toNumber(),
                positionRisk
            })
        };
    }

    private calculateRiskLevel(risks: {
        volumeRisk: number,
        volatilityRisk: number,
        positionRisk: PositionRisk
    }): RiskLevel {
        const maxRisk = Math.max(
            risks.volumeRisk,
            risks.volatilityRisk,
            risks.positionRisk.leverage
        );

        if (maxRisk >= 0.9) return RiskLevel.CRITICAL;
        if (maxRisk >= 0.7) return RiskLevel.HIGH;
        if (maxRisk >= 0.5) return RiskLevel.MEDIUM;
        return RiskLevel.LOW;
    }

    private async checkRiskLevels(): Promise<void> {
        for (const [marketId, risk] of this.marketRisks) {
            if (risk.riskLevel >= RiskLevel.HIGH) {
                await this.handleHighRisk(marketId, risk);
            }
        }
    }

    private async handleHighRisk(
        marketId: string,
        risk: MarketRisk
    ): Promise<void> {
        const alert: RiskAlert = {
            marketId,
            riskLevel: risk.riskLevel,
            timestamp: new Date(),
            metrics: {
                volatility: risk.volatility.toString(),
                volume: risk.volume.toString(),
                price: risk.price.toString()
            },
            message: `High risk detected for market ${marketId}`
        };

        await this.notificationService.sendRiskAlert(alert);
        this.eventEmitter.emit('risk.high', alert);
    }

    private validateOrderSize(
        order: OrderRisk,
        marketRisk: MarketRisk
    ): boolean {
        const limits = this.riskLimits.get(order.marketId);
        if (!limits) return false;

        const orderValue = new BigNumber(order.quantity)
            .multipliedBy(marketRisk.price);

        return orderValue.lte(limits.maxOrderSize);
    }

    private validateConcentration(
        order: OrderRisk,
        positionRisk: PositionRisk
    ): boolean {
        const newPositionSize = positionRisk.size.plus(order.quantity);
        const concentration = newPositionSize
            .multipliedBy(100)
            .dividedBy(positionRisk.totalPortfolioValue);

        return concentration.lte(this.maxConcentration);
    }

    private async validateBalance(order: OrderRisk): Promise<boolean> {
        const balance = await this.splTokenService.getTokenBalance(
            order.tokenMint,
            order.owner
        );

        const requiredAmount = order.side === OrderSide.BUY
            ? order.quantity.multipliedBy(order.price)
            : order.quantity;

        return balance.amount.gte(requiredAmount);
    }

    private validateVolatility(
        order: OrderRisk,
        marketRisk: MarketRisk
    ): boolean {
        const limits = this.riskLimits.get(order.marketId);
        if (!limits) return false;

        return marketRisk.volatility.lte(limits.volatilityThreshold);
    }

    private validateSpreadRisk(
        strategy: MarketMakingStrategy,
        marketRisk: MarketRisk
    ): boolean {
        const maxSpread = new BigNumber(strategy.spreadConfig.baseSpread)
            .multipliedBy(1 + strategy.spreadConfig.inventorySkewImpact);

        return maxSpread.lte(marketRisk.volatility.multipliedBy(2));
    }

    private validateInventoryRisk(
        strategy: MarketMakingStrategy
    ): boolean {
        const range = new BigNumber(strategy.inventoryConfig.maxInventory)
            .minus(strategy.inventoryConfig.minInventory);

        const totalValue = range.multipliedBy(strategy.baseQuantity);
        return totalValue.lte(this.maxPositionValue);
    }

    private validateOrderFrequency(
        strategy: MarketMakingStrategy,
        marketRisk: MarketRisk
    ): boolean {
        const limits = this.riskLimits.get(strategy.marketId);
        if (!limits) return false;

        return strategy.updateInterval >= limits.minOrderInterval;
    }

    private async recordRiskMetrics(
        marketId: string,
        risk: MarketRisk
    ): Promise<void> {
        const metrics: RiskMetrics = {
            marketId,
            timestamp: risk.timestamp,
            volatility: risk.volatility.toString(),
            volume: risk.volume.toString(),
            price: risk.price.toString(),
            riskLevel: risk.riskLevel,
            positionRisk: risk.positionRisk
        };

        await this.metricsService.recordRiskMetrics(metrics);
    }

    private async handleMonitoringError(error: Error): Promise<void> {
        await this.notificationService.sendSystemAlert({
            component: 'RiskManagement',
            type: 'MONITORING_ERROR',
            error: error.message
        });
    }
}
