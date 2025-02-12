// src/config/redis.ts
import Redis from 'ioredis';
import { logger } from './logger';

let redis: Redis;

export async function connectRedis(): Promise<Redis> {
    try {
        redis = new Redis(process.env.REDIS_URL!, {
            maxRetriesPerRequest: 3,
            retryStrategy(times) {
                const delay = Math.min(times * 50, 2000);
                return delay;
            }
        });

        redis.on('error', (error) => {
            logger.error('Redis connection error:', error);
        });

        redis.on('connect', () => {
            logger.info('Connected to Redis');
        });

        return redis;
    } catch (error) {
        logger.error('Failed to connect to Redis:', error);
        throw error;
    }
}

export function getRedis(): Redis {
    if (!redis) {
        throw new Error('Redis connection not initialized');
    }
    return redis;
}
