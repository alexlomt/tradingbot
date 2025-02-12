// src/config/logger.ts
import pino from 'pino';

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l o',
            ignore: 'pid,hostname',
        },
    },
    mixin() {
        return {
            service: 'trading-bot',
            env: process.env.NODE_ENV,
        };
    },
});
