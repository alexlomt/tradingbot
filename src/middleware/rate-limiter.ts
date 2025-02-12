// src/middleware/rate-limiter.ts
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { getRedis } from '../config/redis';
import { logger } from '../config/logger';

interface RateLimitConfig {
    windowMs: number;
    max: number;
}

export const rateLimiter = (config: RateLimitConfig) => {
    const redis = getRedis();

    return rateLimit({
        windowMs: config.windowMs,
        max: config.max,
        standardHeaders: true,
        legacyHeaders: false,
        store: new RedisStore({
            prefix: 'rate-limit:',
            // @ts-ignore (type mismatch in library)
            sendCommand: (...args: string[]) => redis.call(...args),
        }),
        handler: (req, res) => {
            logger.warn({
                ip: req.ip,
                path: req.path
            }, 'Rate limit exceeded');

            res.status(429).json({
                error: 'Too many requests',
                retryAfter: Math.ceil(config.windowMs / 1000)
            });
        }
    });
};