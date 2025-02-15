import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({
    timestamps: true,
    collection: 'subscription_transactions'
})
export class SubscriptionTransaction extends Document {
    @Prop({ required: true, index: true })
    userId: string;

    @Prop({ required: true, index: true })
    subscriptionId: string;

    @Prop({ required: true })
    amount: number;

    @Prop({ required: true })
    currency: string;

    @Prop({ required: true })
    status: 'pending' | 'succeeded' | 'failed';

    @Prop({ required: true })
    paymentMethod: 'stripe' | 'crypto';

    @Prop({ required: true })
    type: 'subscription' | 'one_time' | 'refund';

    @Prop()
    stripePaymentIntentId?: string;

    @Prop()
    stripePriceId?: string;

    @Prop()
    cryptoTransactionHash?: string;

    @Prop()
    cryptoAddress?: string;

    @Prop()
    failureReason?: string;

    @Prop()
    refundReason?: string;

    @Prop({ type: Map, of: String })
    metadata: Map<string, string>;
}

export const SubscriptionTransactionSchema = SchemaFactory.createForClass(SubscriptionTransaction);

// Indexes for efficient querying
SubscriptionTransactionSchema.index({ userId: 1, createdAt: -1 });
SubscriptionTransactionSchema.index({ subscriptionId: 1, status: 1 });
SubscriptionTransactionSchema.index({ stripePaymentIntentId: 1 }, { sparse: true });
SubscriptionTransactionSchema.index({ cryptoTransactionHash: 1 }, { sparse: true });
