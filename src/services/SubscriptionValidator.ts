import {
    UserSubscription,
    SubscriptionPlan,
    TradingPermissions,
    TradingPair,
    SubscriptionEvent,
} from '../types/trading.types';
import { Cache } from '../utils/Cache';
import { logger } from '../utils/logger';
import { ErrorReporter } from '../utils/errorReporting';
import { EventEmitter } from 'events';
import { Database } from '../database';

export class SubscriptionValidator extends EventEmitter {
    private readonly subscriptionCache: Cache<string, UserSubscription>;
    private readonly planCache: Cache<string, SubscriptionPlan>;

    constructor(
        private readonly db: Database,
        private readonly cacheDuration: number = 300000 // 5 minutes
    ) {
        super();
        this.subscriptionCache = new Cache<string, UserSubscription>(cacheDuration);
        this.planCache = new Cache<string, SubscriptionPlan>(cacheDuration);
    }

    async validateTrading(
        userId: string,
        pair?: TradingPair | null
    ): Promise<TradingPermissions> {
        try {
            const subscription = await this.getActiveSubscription(userId);
            
            if (!subscription || !subscription.active) {
                return this.getDefaultPermissions();
            }

            const plan = await this.getSubscriptionPlan(subscription.planId);
            if (!plan) {
                throw new Error(`Subscription plan ${subscription.planId} not found`);
            }

            const permissions = await this.calculatePermissions(subscription, plan, pair);
            
            if (!permissions.canTrade) {
                this.emit('subscription:trading-rejected', {
                    userId,
                    subscription,
                    pair: pair?.lpAddress.toString(),
                    timestamp: new Date()
                });
            }

            return permissions;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'SubscriptionValidator.validateTrading',
                userId,
                pair: pair?.lpAddress.toString()
            });
            return this.getDefaultPermissions();
        }
    }

    async getActiveSubscription(userId: string): Promise<UserSubscription | null> {
        const cached = this.subscriptionCache.get(userId);
        if (cached) return cached;

        try {
            const subscription = await this.db.subscriptions.findOne({
                userId,
                active: true,
                endDate: { $gt: new Date() }
            });

            if (subscription) {
                this.subscriptionCache.set(userId, subscription);
                return subscription;
            }

            return null;
        } catch (error) {
            logger.error(`Error fetching subscription for user ${userId}:`, error);
            return null;
        }
    }

    async checkFeatureAccess(
        userId: string,
        feature: string
    ): Promise<boolean> {
        const subscription = await this.getActiveSubscription(userId);
        if (!subscription) return false;

        const plan = await this.getSubscriptionPlan(subscription.planId);
        if (!plan) return false;

        return plan.features.includes(feature);
    }

    private async getSubscriptionPlan(planId: string): Promise<SubscriptionPlan | null> {
        const cached = this.planCache.get(planId);
        if (cached) return cached;

        try {
            const plan = await this.db.subscriptionPlans.findOne({ id: planId });
            if (plan) {
                this.planCache.set(planId, plan);
                return plan;
            }

            return null;
        } catch (error) {
            logger.error(`Error fetching subscription plan ${planId}:`, error);
            return null;
        }
    }

    private async calculatePermissions(
        subscription: UserSubscription,
        plan: SubscriptionPlan,
        pair?: TradingPair | null
    ): Promise<TradingPermissions> {
        const now = new Date();
        const isValid = subscription.active && subscription.endDate > now;

        if (!isValid) {
            await this.handleExpiredSubscription(subscription);
            return this.getDefaultPermissions();
        }

        return {
            canTrade: this.canTradeWithPlan(plan, pair),
            maxPositions: plan.maxPositions,
            allowedPairs: plan.allowedPairs,
            priorityExecution: plan.priority,
            subscriptionValid: true,
            remainingDailyTrades: this.calculateRemainingTrades(subscription, plan),
            customStrategiesAllowed: plan.customStrategySupport
        };
    }

    private canTradeWithPlan(plan: SubscriptionPlan, pair?: TradingPair | null): boolean {
        if (!pair) return true;

        return plan.allowedPairs.includes('*') || 
               plan.allowedPairs.includes(pair.baseToken.symbol);
    }

    private calculateRemainingTrades(
        subscription: UserSubscription,
        plan: SubscriptionPlan
    ): number {
        const { tradingStats } = subscription;
        const today = new Date().toISOString().split('T')[0];
        
        if (tradingStats.lastTradingDay.toISOString().split('T')[0] !== today) {
            return plan.maxDailyTrades;
        }

        return Math.max(0, plan.maxDailyTrades - tradingStats.dailyTradeCount);
    }

    private async handleExpiredSubscription(subscription: UserSubscription): Promise<void> {
        try {
            await this.db.subscriptions.updateOne(
                { userId: subscription.userId },
                { $set: { active: false } }
            );

            this.subscriptionCache.delete(subscription.userId);

            this.emit('subscription:expired', {
                type: 'subscription-expired',
                userId: subscription.userId,
                planId: subscription.planId,
                timestamp: new Date(),
                details: subscription
            } as SubscriptionEvent);
        } catch (error) {
            logger.error('Error handling expired subscription:', error);
        }
    }

    private getDefaultPermissions(): TradingPermissions {
        return {
            canTrade: false,
            maxPositions: 0,
            allowedPairs: [],
            priorityExecution: false,
            subscriptionValid: false,
            remainingDailyTrades: 0,
            customStrategiesAllowed: false
        };
    }

    public clearCache(): void {
        this.subscriptionCache.clear();
        this.planCache.clear();
    }
}
