import * as dotenv from 'dotenv';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import path from 'path';
import fs from 'fs';

// Load environment variables
dotenv.config({
    path: process.env.NODE_ENV === 'production' 
        ? '.env.production' 
        : '.env.development'
});

export interface TradingBotConfig {
    // Network Configuration
    rpcEndpoint: string;
    wsEndpoint: string;
    commitment: 'processed' | 'confirmed' | 'finalized';
    cluster: 'mainnet-beta' | 'devnet';

    // Wallet Configuration
    walletPath: string;
    walletPublicKey: PublicKey;

    // Redis Configuration
    redisEnabled: boolean;
    redisHost: string;
    redisPort: number;
    redisPassword: string;
    redisTls: boolean;

    // Trading Parameters
    maxConcurrentTrades: number;
    maxDailyTrades: number;
    maxPositionSize: BN;
    dailyVolumeLimit: BN;
    defaultSlippage: number;
    minLiquidityUsd: BN;
    emergencyCloseAll: boolean;

    // Risk Management
    riskManagement: {
        takeProfit: number;
        stopLoss: number;
        maxDrawdown: number;
        maxLeverage: number;
        cooldownPeriod: number;
    };

    // Transaction Settings
    useWarpTransactions: boolean;
    useJitoTransactions: boolean;
    useCustomFee: boolean;
    customFee: BN;
    computeUnitLimit: number;
    computeUnitPrice: number;
    skipPreflight: boolean;
    maxRetries: number;
    maxTimeout: number;

    // Market Data Settings
    marketUpdateInterval: number;
    priceUpdateInterval: number;
    liquidityCheckInterval: number;
    volatilityWindow: number;

    // Snipe List Configuration
    snipeListEnabled: boolean;
    maxSnipeListEntries: number;
    snipeListAutoRemoveDays: number;
    snipeListPersist: boolean;
    snipeListSyncInterval: number;
    snipeListBackupInterval: number;

    // Cache Settings
    cacheEnabled: boolean;
    cacheTtl: number;
    cacheMaxSize: number;
    cacheUpdateInterval: number;

    // Logging and Monitoring
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    sentryEnabled: boolean;
    sentryDsn: string;
    metricsEnabled: boolean;
    metricsPort: number;

    // Feature Flags
    features: {
        automaticTrading: boolean;
        riskManagement: boolean;
        warpIntegration: boolean;
        jitoIntegration: boolean;
        metricsDashboard: boolean;
    };
}

/**
 * Runtime configuration manager for the trading bot
 */
export class ConfigService {
    private static instance: ConfigService;
    private config: Map<string, any>;
    private configPath: string;

    private constructor() {
        this.config = new Map();
        this.configPath = path.join(process.cwd(), 'config', 'runtime.json');
        this.loadConfig();
    }

    static getInstance(): ConfigService {
        if (!ConfigService.instance) {
            ConfigService.instance = new ConfigService();
        }
        return ConfigService.instance;
    }

    get(key: string): string {
        return this.config.get(key) || process.env[key] || '';
    }

    getNumber(key: string): number {
        return Number(this.get(key)) || 0;
    }

    getBoolean(key: string): boolean {
        return this.get(key).toLowerCase() === 'true';
    }

    getBN(key: string): BN {
        return new BN(this.get(key) || '0');
    }

    getPublicKey(key: string): PublicKey {
        return new PublicKey(this.get(key));
    }

    async set(key: string, value: any): Promise<void> {
        this.config.set(key, value);
        await this.saveConfig();
    }

    private loadConfig(): void {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                for (const [key, value] of Object.entries(data)) {
                    this.config.set(key, value);
                }
            }
        } catch (error) {
            console.error('Error loading configuration:', error);
        }
    }

    private async saveConfig(): Promise<void> {
        try {
            const data = Object.fromEntries(this.config);
            await fs.promises.writeFile(
                this.configPath,
                JSON.stringify(data, null, 2)
            );
        } catch (error) {
            console.error('Error saving configuration:', error);
        }
    }
}
