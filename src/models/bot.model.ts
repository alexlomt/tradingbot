// src/models/bot.model.ts
import mongoose, { Document, Schema } from 'mongoose';
import { BotConfig } from '../types/bot';

export interface IBot extends Document {
    userId: mongoose.Types.ObjectId;
    name: string;
    status: 'stopped' | 'running' | 'error';
    config: BotConfig;
    metrics: {
        totalTrades: number;
        successfulTrades: number;
        failedTrades: number;
        totalVolume: number;
        profitLoss: number;
        lastUpdated: Date;
    };
    lastError?: string;
    createdAt: Date;
    updatedAt: Date;
}

const botSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    name: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['stopped', 'running', 'error'],
        default: 'stopped'
    },
    config: {
        walletPrivateKey: {
            type: String,
            required: true,
            select: false // Don't return in queries by default
        },
        rpcEndpoint: String,
        rpcWebsocketEndpoint: String,
        commitmentLevel: String,
        quoteMint: String,
        quoteAmount: String,
        buySlippage: Number,
        sellSlippage: Number,
        takeProfit: Number,
        stopLoss: Number,
        autoSell: Boolean,
        transactionExecutor: String,
        customFee: String,
        minPoolSize: Number,
        maxPoolSize: Number,
        checkIfMutable: Boolean,
        checkIfSocials: Boolean,
        checkIfMintIsRenounced: Boolean,
        checkIfFreezable: Boolean,
        checkIfBurned: Boolean
    },
    metrics: {
        totalTrades: { type: Number, default: 0 },
        successfulTrades: { type: Number, default: 0 },
        failedTrades: { type: Number, default: 0 },
        totalVolume: { type: Number, default: 0 },
        profitLoss: { type: Number, default: 0 },
        lastUpdated: { type: Date, default: Date.now }
    },
    lastError: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

botSchema.index({ userId: 1 });

export const Bot = mongoose.model<IBot>('Bot', botSchema);
