import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

@Schema({
    timestamps: true,
    collection: 'subscription_tiers'
})
export class SubscriptionTier extends Document {
    @Prop({ required: true, unique: true })
    id: string;

    @Prop({ required: true })
    name: string;

    @Prop({ required: true })
    description: string;

    @Prop({ required: true })
    price: number;

    @Prop()
    currency: string;

    @Prop({ required: true })
    billingPeriod: 'monthly' | 'yearly';

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
    limits: {
        maxTradeAmount: number;
        maxDailyTrades: number;
        maxOpenOrders: number;
        maxActiveStrategies: number;
    };

    @Prop({ type: [String] })
    availableMarkets: string[];

    @Prop({ type: Boolean, default: true })
    isActive: boolean;

    @Prop({ type: Number, default: 0 })
    displayOrder: number;

    @Prop({ type: MongooseSchema.Types.Mixed })
    metadata: {
        stripePriceId?: string;
        promoEligible?: boolean;
        customFields?: Record<string, any>;
    };
}

export const SubscriptionTierSchema = SchemaFactory.createForClass(SubscriptionTier);
