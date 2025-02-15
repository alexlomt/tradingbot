import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Subscription } from '../schemas/Subscription.schema';
import { SubscriptionTier } from '../schemas/SubscriptionTier.schema';
import { SubscriptionTransaction } from '../schemas/SubscriptionTransaction.schema';

@Injectable()
export class SubscriptionRepository {
    constructor(
        @InjectModel(Subscription.name)
        private subscriptionModel: Model<Subscription>,
        @InjectModel(SubscriptionTier.name)
        private subscriptionTierModel: Model<SubscriptionTier>,
        @InjectModel(SubscriptionTransaction.name)
        private subscriptionTransactionModel: Model<SubscriptionTransaction>
    ) {}

    async createSubscription(data: Partial<Subscription>): Promise<Subscription> {
        const subscription = new this.subscriptionModel(data);
        return await subscription.save();
    }

    async getActiveSubscription(userId: string): Promise<Subscription | null> {
        return await this.subscriptionModel.findOne({
            userId,
            status: 'active',
            endDate: { $gt: new Date() }
        }).exec();
    }

    async updateSubscriptionUsage(
        subscriptionId: string,
        usage: Partial<Subscription['usage']>
    ): Promise<void> {
        await this.subscriptionModel.updateOne(
            { _id: subscriptionId },
            { 
                $set: { 
                    'usage': usage,
                    'usage.lastUpdated': new Date()
                }
            }
        );
    }

    async createTransaction(
        data: Partial<SubscriptionTransaction>
    ): Promise<SubscriptionTransaction> {
        const transaction = new this.subscriptionTransactionModel(data);
        return await transaction.save();
    }

    async getTierById(tierId: string): Promise<SubscriptionTier | null> {
        return await this.subscriptionTierModel.findOne({
            id: tierId,
            isActive: true
        }).exec();
    }

    async getActiveSubscriptions(): Promise<Subscription[]> {
        return await this.subscriptionModel.find({
            status: 'active',
            endDate: { $gt: new Date() }
        }).exec();
    }

    async getExpiringSubscriptions(days: number): Promise<Subscription[]> {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + days);

        return await this.subscriptionModel.find({
            status: 'active',
            endDate: {
                $gte: new Date(),
                $lte: expiryDate
            }
        }).exec();
    }
}
