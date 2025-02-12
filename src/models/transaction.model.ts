// src/models/transaction.model.ts
import mongoose, { Document, Schema } from 'mongoose';

export interface ITransaction extends Document {
    botId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    type: 'buy' | 'sell';
    tokenMint: string;
    amount: number;
    price: number;
    signature: string;
    status: 'completed' | 'failed';
    error?: string;
    createdAt: Date;
}

const transactionSchema = new Schema({
    botId: {
        type: Schema.Types.ObjectId,
        ref: 'Bot',
        required: true
    },
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    type: {
        type: String,
        enum: ['buy', 'sell'],
        required: true
    },
    tokenMint: {
        type: String,
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    price: {
        type: Number,
        required: true
    },
    signature: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['completed', 'failed'],
        required: true
    },
    error: String,
    createdAt: { type: Date, default: Date.now }
});

transactionSchema.index({ botId: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, createdAt: -1 });

export const Transaction = mongoose.model<ITransaction>('Transaction', transactionSchema);
