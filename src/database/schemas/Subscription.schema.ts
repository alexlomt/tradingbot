import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { SubscriptionTier, TradingLimits } from '../../types/subscription.types';

@Schema({
    timestamps: true,
    collection: 'subscriptions',
    autoIndex: true
})
export class Subscription extends Document {
    @Prop({ required: true, index: true })
    userId: string;

    @Prop({ required: true, index: true })
    tierId: string;

    @Prop({ required: true, index: true })
    stripeSubscriptionId: string;

    @Prop({ required: true, index: true })
    status: string;

    @Prop({ required: true })
    startDate: Date;

    @Prop({ required: true, index: true })
    endDate: Date;

    @Prop({ required: true })
    paymentStatus: string;

    @Prop()
    lastPaymentDate: Date;

    @Prop()
    nextPaymentDate: Date;

    @Prop()
    cancelledAt?: Date;

    @Prop()
    trialEndsAt?: Date;

    @Prop({ type: MongooseSchema.Types.Mixed, required: true })
    features: {
        maxTradingPairs: number;
        maxDCAStrategies: number;
        maxAlerts: number;
        advancedCharting: boolean;
        prioritySupport: boolean;
        mevProtection: boolean;
        customWebhooks: boolean;
    };

    @Prop({ type: MongooseSchema.Types.Mixed, required: true })
    limits: TradingLimits;

    @Prop({ type: MongooseSchema.Types.Mixed })
    usage: {
        tradingVolume: number;
        tradingPairsCount: number;
        dcaStrategiesCount: number;
        alertsCount: number;
        lastUpdated: Date;
    };

    @Prop({ type: [String], index: true })
    activeTradingPairs: string[];

    @Prop({ type: MongooseSchema.Types.Mixed })
    paymentHistory: Array<{
        date: Date;
        amount: number;
        status: string;
        transactionId: string;
    }>;

    @Prop({ type: MongooseSchema.Types.Mixed })
    metadata: {
        platform: string;
        referralCode?: string;
        promoCode?: string;
        customFields?: Record<string, any>;
    };
}

export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);

// Indexes for efficient querying
SubscriptionSchema.index({ userId: 1, status: 1 });
SubscriptionSchema.index({ endDate: 1, status: 1 });
SubscriptionSchema.index({ stripeSubscriptionId: 1 }, { unique: true });
SubscriptionSchema.index({ 'usage.lastUpdated': 1 });

// TTL index for cleaning up expired trials
SubscriptionSchema.index({ trialEndsAt: 1 }, { expireAfterSeconds: 0 });
