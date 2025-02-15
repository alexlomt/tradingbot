import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Stripe } from 'stripe';
import { RedisService } from '../cache/RedisService';
import { Subscription } from '../../database/schemas/Subscription.schema';
import { User } from '../../database/schemas/User.schema';
import { SUBSCRIPTION_TIERS } from '../../config/constants';
import { 
    SubscriptionTier, 
    SubscriptionStatus,
    PaymentStatus,
    SubscriptionEvent
} from '../../types/subscription.types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { differenceInDays } from 'date-fns';

@Injectable()
export class SubscriptionService implements OnModuleInit {
    private readonly logger = new Logger(SubscriptionService.name);
    private readonly stripe: Stripe;
    private readonly priceIds: Map<string, string> = new Map();

    constructor(
        @InjectModel(Subscription.name) private subscriptionModel: Model<Subscription>,
        @InjectModel(User.name) private userModel: Model<User>,
        private readonly configService: ConfigService,
        private readonly redisService: RedisService,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.stripe = new Stripe(this.configService.get('STRIPE_SECRET_KEY')!, {
            apiVersion: '2023-10-16'
        });
    }

    async onModuleInit() {
        await this.initializeStripePrices();
        this.startSubscriptionMonitoring();
    }

    private async initializeStripePrices() {
        const prices = await this.stripe.prices.list({ active: true });
        
        for (const price of prices.data) {
            if (price.metadata.tierId) {
                this.priceIds.set(price.metadata.tierId, price.id);
            }
        }
    }

    private startSubscriptionMonitoring() {
        setInterval(async () => {
            try {
                await this.checkExpiringSubscriptions();
                await this.processFailedPayments();
            } catch (error) {
                this.logger.error('Subscription monitoring failed', error);
            }
        }, 3600000); // Check every hour
    }

    async createSubscription(
        userId: string,
        tierId: string,
        paymentMethodId: string
    ): Promise<Subscription> {
        const user = await this.userModel.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        const tier = SUBSCRIPTION_TIERS[tierId.toUpperCase()];
        if (!tier) {
            throw new Error('Invalid subscription tier');
        }

        const priceId = this.priceIds.get(tierId);
        if (!priceId) {
            throw new Error('Price configuration not found');
        }

        try {
            // Create or update Stripe customer
            let stripeCustomerId = user.stripeCustomerId;
            if (!stripeCustomerId) {
                const customer = await this.stripe.customers.create({
                    email: user.email,
                    payment_method: paymentMethodId,
                    invoice_settings: {
                        default_payment_method: paymentMethodId
                    }
                });
                stripeCustomerId = customer.id;
                await this.userModel.updateOne(
                    { _id: userId },
                    { stripeCustomerId }
                );
            } else {
                await this.stripe.paymentMethods.attach(paymentMethodId, {
                    customer: stripeCustomerId
                });
                await this.stripe.customers.update(stripeCustomerId, {
                    invoice_settings: {
                        default_payment_method: paymentMethodId
                    }
                });
            }

            // Create Stripe subscription
            const stripeSubscription = await this.stripe.subscriptions.create({
                customer: stripeCustomerId,
                items: [{ price: priceId }],
                payment_behavior: 'default_incomplete',
                payment_settings: {
                    payment_method_types: ['card'],
                    save_default_payment_method: 'on_subscription'
                },
                expand: ['latest_invoice.payment_intent']
            });

            // Create local subscription record
            const subscription = new this.subscriptionModel({
                userId,
                tierId,
                stripeSubscriptionId: stripeSubscription.id,
                status: SubscriptionStatus.ACTIVE,
                startDate: new Date(),
                endDate: new Date(stripeSubscription.current_period_end * 1000),
                paymentStatus: PaymentStatus.PAID,
                features: tier.features,
                limits: tier.limits,
                trialEndsAt: tier.id === 'trial' ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null
            });

            await subscription.save();
            await this.cacheSubscriptionLimits(subscription);

            this.eventEmitter.emit(SubscriptionEvent.CREATED, {
                userId,
                tierId,
                subscription
            });

            return subscription;
        } catch (error) {
            this.logger.error('Failed to create subscription', error);
            throw new Error('Subscription creation failed');
        }
    }

    async updateSubscription(
        userId: string,
        newTierId: string
    ): Promise<Subscription> {
        const subscription = await this.subscriptionModel.findOne({
            userId,
            status: SubscriptionStatus.ACTIVE
        });

        if (!subscription) {
            throw new Error('No active subscription found');
        }

        const priceId = this.priceIds.get(newTierId);
        if (!priceId) {
            throw new Error('Invalid subscription tier');
        }

        try {
            await this.stripe.subscriptions.update(subscription.stripeSubscriptionId, {
                items: [{
                    id: subscription.stripeSubscriptionId,
                    price: priceId
                }],
                proration_behavior: 'always_invoice'
            });

            const tier = SUBSCRIPTION_TIERS[newTierId.toUpperCase()];
            subscription.tierId = newTierId;
            subscription.features = tier.features;
            subscription.limits = tier.limits;
            
            await subscription.save();
            await this.cacheSubscriptionLimits(subscription);

            this.eventEmitter.emit(SubscriptionEvent.UPDATED, {
                userId,
                tierId: newTierId,
                subscription
            });

            return subscription;
        } catch (error) {
            this.logger.error('Failed to update subscription', error);
            throw new Error('Subscription update failed');
        }
    }

    async cancelSubscription(userId: string): Promise<void> {
        const subscription = await this.subscriptionModel.findOne({
            userId,
            status: SubscriptionStatus.ACTIVE
        });

        if (!subscription) {
            throw new Error('No active subscription found');
        }

        try {
            await this.stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
            
            subscription.status = SubscriptionStatus.CANCELLED;
            subscription.cancelledAt = new Date();
            await subscription.save();

            await this.redisService.del(`subscription:${userId}:limits`);

            this.eventEmitter.emit(SubscriptionEvent.CANCELLED, {
                userId,
                subscription
            });
        } catch (error) {
            this.logger.error('Failed to cancel subscription', error);
            throw new Error('Subscription cancellation failed');
        }
    }

    async handleStripeWebhook(event: Stripe.Event): Promise<void> {
        switch (event.type) {
            case 'invoice.payment_succeeded':
                await this.handlePaymentSuccess(event.data.object as Stripe.Invoice);
                break;
            case 'invoice.payment_failed':
                await this.handlePaymentFailure(event.data.object as Stripe.Invoice);
                break;
            case 'customer.subscription.deleted':
                await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
                break;
        }
    }

    private async handlePaymentSuccess(invoice: Stripe.Invoice): Promise<void> {
        const subscription = await this.subscriptionModel.findOne({
            stripeSubscriptionId: invoice.subscription
        });

        if (subscription) {
            subscription.paymentStatus = PaymentStatus.PAID;
            subscription.lastPaymentDate = new Date();
            subscription.endDate = new Date(invoice.period_end * 1000);
            await subscription.save();
        }
    }

    private async handlePaymentFailure(invoice: Stripe.Invoice): Promise<void> {
        const subscription = await this.subscriptionModel.findOne({
            stripeSubscriptionId: invoice.subscription
        });

        if (subscription) {
            subscription.paymentStatus = PaymentStatus.FAILED;
            await subscription.save();

            this.eventEmitter.emit(SubscriptionEvent.PAYMENT_FAILED, {
                userId: subscription.userId,
                subscription
            });
        }
    }

    private async handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription): Promise<void> {
        const subscription = await this.subscriptionModel.findOne({
            stripeSubscriptionId: stripeSubscription.id
        });

        if (subscription) {
            subscription.status = SubscriptionStatus.CANCELLED;
            subscription.cancelledAt = new Date();
            await subscription.save();

            await this.redisService.del(`subscription:${subscription.userId}:limits`);
        }
    }

    private async checkExpiringSubscriptions(): Promise<void> {
        const threeDaysFromNow = new Date();
        threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

        const expiringSubscriptions = await this.subscriptionModel.find({
            status: SubscriptionStatus.ACTIVE,
            endDate: { $lte: threeDaysFromNow }
        });

        for (const subscription of expiringSubscriptions) {
            this.eventEmitter.emit(SubscriptionEvent.EXPIRING_SOON, {
                userId: subscription.userId,
                subscription,
                daysLeft: differenceInDays(subscription.endDate, new Date())
            });
        }
    }

    private async processFailedPayments(): Promise<void> {
        const failedSubscriptions = await this.subscriptionModel.find({
            status: SubscriptionStatus.ACTIVE,
            paymentStatus: PaymentStatus.FAILED
        });

        for (const subscription of failedSubscriptions) {
            try {
                const invoice = await this.stripe.invoices.retrieve(
                    subscription.lastFailedInvoiceId!
                );
                await this.stripe.invoices.pay(invoice.id);
            } catch (error) {
                this.logger.error(
                    `Failed to process payment for subscription ${subscription.id}`,
                    error
                );
            }
        }
    }

    private async cacheSubscriptionLimits(subscription: Subscription): Promise<void> {
        await this.redisService.set(
            `subscription:${subscription.userId}:limits`,
            JSON.stringify(subscription.limits),
            86400 // 24 hours
        );
    }
}
