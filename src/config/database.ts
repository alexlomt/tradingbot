// src/config/database.ts
import mongoose from 'mongoose';
import { logger } from './logger';

export async function connectDB(): Promise<void> {
    try {
        const uri = process.env.MONGODB_URI;
        if (!uri) {
            throw new Error('MONGODB_URI is not defined');
        }

        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });

        logger.info('Connected to MongoDB');

        mongoose.connection.on('error', (error) => {
            logger.error('MongoDB connection error:', error);
        });

        mongoose.connection.on('disconnected', () => {
            logger.warn('MongoDB disconnected. Attempting to reconnect...');
        });

    } catch (error) {
        logger.error('Failed to connect to MongoDB:', error);
        throw error;
    }
}