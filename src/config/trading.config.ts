import { BN } from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import {
    TradingStrategyConfig,
    RiskManagementConfig,
    PoolConfig
} from '../types/trading.types';
import { Percent } from '@raydium-io/raydium-sdk';

export const TRADING_CONFIG: TradingStrategyConfig = {
    autoBuyDelay: 500, // milliseconds
    autoSellDelay: 500,
    takeProfit: new Percent(new BN(5), new BN(100)), // 5%
    stopLoss: new Percent(new BN(2), new BN(100)), // 2%
    trailingStop: new Percent(new BN(1), new BN(100)), // 1%
    slippageTolerance: new Percent(new BN(1), new BN(1000)), // 0.1%
    priceCheckInterval: 1000, // 1 second
    priceCheckDuration: 300000, // 5 minutes
    maxRetries: 3,
    oneTokenAtTime: true,
    subscriptionRequired: true,
    maxConcurrentTrades: 5,
    emergencyCloseAll: false,
    riskManagement: {
        maxDailyLoss: new Percent(new BN(10), new BN(100)), // 10%
        maxPositionSize: new BN('1000000000'), // 1 SOL
        maxLeverage: 1,
        dailyVolumeLimit: new BN('10000000000'), // 10 SOL
        emergencyCloseThreshold: new Percent(new BN(20), new BN(100)) // 20%
    } as RiskManagementConfig
};

export const POOL_CONFIG: PoolConfig = {
    minSize: new BN('100000000'), // 0.1 SOL
    maxSize: new BN('1000000000000'), // 1000 SOL
    checkBurn: true,
    checkFreeze: true,
    checkRenounced: true,
    consecutiveMatches: 3,
    filterCheckInterval: 1000, // 1 second
    filterCheckDuration: 60000, // 1 minute
    liquidityThreshold: new BN('1000000000'), // 1 SOL
    volumeThreshold: new BN('10000000000') // 10 SOL
};

export const NETWORK_CONFIG = {
    commitment: 'confirmed' as const,
    wsEndpoint: process.env.WS_ENDPOINT || 'wss://api.mainnet-beta.solana.com',
    httpEndpoint: process.env.HTTP_ENDPOINT || 'https://api.mainnet-beta.solana.com',
};

export const EXECUTION_CONFIG = {
    warp: {
        enabled: true,
        apiKey: process.env.WARP_API_KEY,
        baseUrl: process.env.WARP_BASE_URL || 'https://api.warp.com/v1',
        region: process.env.WARP_REGION || 'us-east-1'
    },
    jito: {
        enabled: true,
        apiKey: process.env.JITO_API_KEY,
        baseUrl: process.env.JITO_BASE_URL || 'https://api.jito.wtf',
        wsUrl: process.env.JITO_WS_URL || 'wss://api.jito.wtf/ws',
        region: process.env.JITO_REGION || 'us-east-1'
    }
};

export const TOKEN_WHITELIST = new Set([
    'So11111111111111111111111111111111111111112', // WSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    // Add more whitelisted tokens here
]);

export const TOKEN_BLACKLIST = new Set([
    // Add blacklisted tokens here
]);

