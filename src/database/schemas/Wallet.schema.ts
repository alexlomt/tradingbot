import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { Transform } from 'class-transformer';

export type WalletDocument = Wallet & Document;

@Schema({
    timestamps: true,
    collection: 'wallets',
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
})
export class Wallet {
    @Prop({ required: true, index: true })
    userId: string;

    @Prop({ required: true, index: true })
    publicKey: string;

    @Prop({ required: true })
    encryptedPrivateKey: string;

    @Prop({ required: true, enum: ['created', 'imported'] })
    origin: string;

    @Prop({ required: true, default: true })
    isActive: boolean;

    @Prop({ required: true, default: Date.now })
    lastUsed: Date;

    @Prop({ type: [String], default: [] })
    authorizedIps: string[];

    @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
    metadata: {
        name?: string;
        tags?: string[];
        createdFrom?: string;
    };

    @Prop({ required: true, default: 0 })
    tradingVolume: number;

    @Prop({ required: true, default: 0 })
    dailyTradeCount: number;

    @Prop({ required: true })
    lastDailyReset: Date;
}

export const WalletSchema = SchemaFactory.createForClass(Wallet);

// Indexes
WalletSchema.index({ userId: 1, publicKey: 1 }, { unique: true });
WalletSchema.index({ userId: 1, isActive: 1 });
WalletSchema.index({ lastDailyReset: 1 });

// Middleware
WalletSchema.pre('save', function(next) {
    if (this.isNew) {
        this.lastDailyReset = new Date();
    }
    next();
});
