// src/config/constants.ts
export const JWT_CONFIG = {
    ACCESS_TOKEN_EXPIRY: process.env.JWT_EXPIRES_IN || '24h',
    REFRESH_TOKEN_EXPIRY: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
};

export const RATE_LIMITS = {
    LOGIN: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 5 // 5 attempts
    },
    API: {
        windowMs: 15 * 60 * 1000,
        max: 100 // 100 requests per 15 minutes
    }
};

export const SOLANA_CONFIG = {
    RPC_ENDPOINT: process.env.SOLANA_RPC_ENDPOINT!,
    WS_ENDPOINT: process.env.SOLANA_WS_ENDPOINT!,
    COMMITMENT: 'confirmed' as const
};