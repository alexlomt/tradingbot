// src/models/license.model.ts
import mongoose, { Document, Schema } from 'mongoose';

export interface ILicense extends Document {
    userId: mongoose.Types.ObjectId;
    type: 'basic' | 'pro' | 'enterprise';
    status: 'active' | 'inactive' | 'cancelled';
    stripeSubscriptionId: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const licenseSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    type: {
        type: String,
        enum: ['basic', 'pro', 'enterprise'],
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'cancelled'],
        default: 'inactive'
    },
    stripeSubscriptionId: {
        type: String,
        required: true,
        unique: true
    },
    currentPeriodEnd: {
        type: Date,
        required: true
    },
    cancelAtPeriodEnd: {
        type: Boolean,
        default: false
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

export const License = mongoose.model<ILicense>('License', licenseSchema);