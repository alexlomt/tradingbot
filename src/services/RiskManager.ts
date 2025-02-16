import {
    TradeExecutionContext,
    RiskManagementConfig,
    MarketState,
    UserSubscription
} from '../types/trading.types';
import { MarketDataService } from './MarketDataService';
import { SubscriptionValidator } from './SubscriptionValidator';
import { Cache } from '../utils/Cache';
import { logger } from '../utils/logger';
import { ErrorReporter } from '../utils/errorReporting';
import { BN } from 'bn.js';
import { Percent, ZERO } from '@raydium-io/raydium-sdk';
import { EventEmitter } from 'events';

export class RiskManager extends EventEmitter {
    private readonly riskCache: Cache<string, {
        dailyLoss: BN;
        dailyVolume: BN;
        lastReset: Date;
        consecutiveLosses: number;
    }>;

    constructor(
        private readonly config: RiskManagementConfig,
        private readonly marketDataService: MarketDataService,
        private readonly subscriptionValidator: SubscriptionValidator,
        private readonly cacheDuration: number = 86400000 // 24 hours
    ) {
        super();
        this.riskCache = new Cache<string, any>(cacheDuration);
    }

    async validateTrade(context: TradeExecutionContext): Promise<boolean> {
        try {
            const userId = context.userSubscription.userId;
            const riskMetrics = await this.calculateRiskMetrics(context);

            const checks = await Promise.all([
                this.checkPositionSize(context),
                this.checkDailyLoss(userId, riskMetrics.potentialLoss),
                this.checkDailyVolume(userId, context.pair.quoteAmount.raw),
                this.checkMarketVolatility(context),
                this.checkLeverageLimit(context),
                this.checkUserRiskLimit(context.userSubscription)
            ]);

            const isValid = checks.every(check => check);

            if (!isValid) {
                this.emit('risk:validation-failed', {
                    context,
                    riskMetrics,
                    timestamp: new Date()
                });
            }

            return isValid;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'RiskManager.validateTrade',
                trade: {
                    user: context.userSubscription.userId,
                    pair: context.pair.lpAddress.toString()
                }
            });
            return false;
        }
    }

    async shouldClosePosition(
        position: TradeExecutionContext,
        update: { marketState: MarketState; pnlPercent: Percent }
    ): Promise<boolean> {
        try {
            const riskMetrics = await this.calculateRiskMetrics(position);
            
            if (riskMetrics.unrealizedLoss.gt(this.config.maxDailyLoss)) {
                this.emit('risk:max-loss-exceeded', {
                    position,
                    metrics: riskMetrics,
                    timestamp: new Date()
                });
                return true;
            }

            if (update.marketState.volatility24h?.gt(this.config.emergencyCloseThreshold)) {
                this.emit('risk:high-volatility', {
                    position,
                    volatility: update.marketState.volatility24h,
                    timestamp: new Date()
                });
                return true;
            }

            return false;
        } catch (error) {
            logger.error('Error in position risk check:', error);
            return true; // Close position on error for safety
        }
    }

    private async calculateRiskMetrics(context: TradeExecutionContext): Promise<{
        potentialLoss: BN;
        unrealizedLoss: BN;
        leverageRatio: number;
        marketVolatility: Percent;
    }> {
        const marketState = await this.marketDataService.getMarketState(
            context.pair.lpAddress
        );

        const potentialLoss = context.pair.quoteAmount.raw
            .mul(this.config.maxDailyLoss.numerator)
            .div(new BN(100));

        const unrealizedLoss = context.side === 'buy'
            ? context.pair.quoteAmount.raw.sub(marketState.price)
            : marketState.price.sub(context.pair.quoteAmount.raw);

        return {
            potentialLoss,
            unrealizedLoss,
            leverageRatio: this.calculateLeverageRatio(context),
            marketVolatility: marketState.volatility24h || new Percent(ZERO, new BN(100))
        };
    }

    private async checkPositionSize(context: TradeExecutionContext): Promise<boolean> {
        return context.pair.quoteAmount.raw.lte(this.config.maxPositionSize.raw);
    }

    private async checkDailyLoss(userId: string, potentialLoss: BN): Promise<boolean> {
        const riskData = this.getRiskData(userId);
        return riskData.dailyLoss.add(potentialLoss).lte(this.config.maxDailyLoss);
    }

    private async checkDailyVolume(userId: string, amount: BN): Promise<boolean> {
        const riskData = this.getRiskData(userId);
        return riskData.dailyVolume.add(amount).lte(this.config.dailyVolumeLimit);
    }

    private async checkMarketVolatility(context: TradeExecutionContext): Promise<boolean> {
        const marketState = await this.marketDataService.getMarketState(
            context.pair.lpAddress
        );

        if (!marketState.volatility24h) return true;
        return marketState.volatility24h.lessThan(this.config.emergencyCloseThreshold);
    }

    private calculateLeverageRatio(context: TradeExecutionContext): number {
        // Implement leverage calculation based on position size and collateral
        return 1.0; // Default to 1x if no leverage is used
    }

    private async checkLeverageLimit(context: TradeExecutionContext): Promise<boolean> {
        const leverageRatio = this.calculateLeverageRatio(context);
        return leverageRatio <= this.config.maxLeverage;
    }

    private async checkUserRiskLimit(subscription: UserSubscription): Promise<boolean> {
        const permissions = await this.subscriptionValidator.validateTrading(
            subscription.userId,
            null
        );
        return permissions.canTrade;
    }

    private getRiskData(userId: string) {
        let data = this.riskCache.get(userId);
        
        if (!data || this.shouldResetDailyRisk(data.lastReset)) {
            data = {
                dailyLoss: ZERO,
                dailyVolume: ZERO,
                lastReset: new Date(),
                consecutiveLosses: 0
            };
            this.riskCache.set(userId, data);
        }
        
        return data;
    }

    private shouldResetDailyRisk(lastReset: Date): boolean {
        const now = new Date();
        return now.getUTCDate() !== lastReset.getUTCDate();
    }

    public updateRiskMetrics(
        userId: string,
        update: {
            loss?: BN;
            volume?: BN;
            isLoss?: boolean;
        }
    ): void {
        const data = this.getRiskData(userId);
        
        if (update.loss) {
            data.dailyLoss = data.dailyLoss.add(update.loss);
        }
        
        if (update.volume) {
            data.dailyVolume = data.dailyVolume.add(update.volume);
        }
        
        if (update.isLoss !== undefined) {
            data.consecutiveLosses = update.isLoss 
                ? data.consecutiveLosses + 1 
                : 0;
        }

        this.riskCache.set(userId, data);
    }
}
