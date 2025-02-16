import { PublicKey, Keypair } from '@solana/web3.js';
import { Token, TokenAmount, Percent } from '@raydium-io/raydium-sdk';
import { BN } from 'bn.js';

// Core Trading Types
export interface TradingPair {
    lpAddress: PublicKey;
    baseToken: Token;
    quoteToken: Token;
    baseAmount: TokenAmount;
    quoteAmount: TokenAmount;
    lpToken?: Token;
}

export interface MarketState {
    price: BN;
    liquidity: BN;
    volume24h: BN;
    lastUpdate: Date;
    isActive: boolean;
    volatility24h?: Percent;
    priceChange24h?: Percent;
}

// Subscription System
export interface UserSubscription {
    userId: string;
    planId: string;
    active: boolean;
    startDate: Date;
    endDate: Date;
    features: {
        priority: boolean;
        maxPositions: number;
        customStrategies: boolean;
    };
    tradingStats: {
        dailyTradeCount: number;
        lastTradingDay: Date;
        totalVolume: BN;
    };
}

export interface SubscriptionPlan {
    id: string;
    name: string;
    price: number;
    duration: number;
    features: string[];
    maxPositions: number;
    maxDailyTrades: number;
    priority: boolean;
    allowedPairs: string[];
    customStrategySupport: boolean;
}

export interface TradingPermissions {
    canTrade: boolean;
    maxPositions: number;
    allowedPairs: string[];
    priorityExecution: boolean;
    subscriptionValid: boolean;
    remainingDailyTrades: number;
    customStrategiesAllowed: boolean;
}

// Transaction and Execution
export type ExecutionStrategy = 'default' | 'warp' | 'jito';

export interface TransactionConfig {
    warpEnabled?: boolean;
    jitoEnabled?: boolean;
    priorityFee?: number;
    computeUnitLimit?: number;
    computeUnitPrice?: number;
    skipPreflight?: boolean;
    maxTimeout?: number;
    maxRetries?: number;
    metadata?: Record<string, any>;
}

export interface TransactionResult {
    signature?: string;
    success: boolean;
    error?: string;
    blockTime?: number;
    fee?: number;
    confirmations?: number;
    slot?: number;
}

// Trading Context and Configuration
export interface TradeExecutionContext {
    pair: TradingPair;
    side: 'buy' | 'sell';
    userSubscription: UserSubscription;
    slippage: Percent;
    deadline?: number;
    metadata?: Record<string, any>;
}

export interface TradingStrategyConfig {
    autoBuyDelay: number;
    autoSellDelay: number;
    takeProfit: Percent;
    stopLoss: Percent;
    trailingStop: Percent;
    slippageTolerance: Percent;
    priceCheckInterval: number;
    priceCheckDuration: number;
    maxRetries: number;
    oneTokenAtTime: boolean;
    subscriptionRequired: boolean;
    maxConcurrentTrades: number;
    emergencyCloseAll: boolean;
    riskManagement: RiskManagementConfig;
}

// Risk Management
export interface RiskManagementConfig {
    maxDailyLoss: Percent;
    maxPositionSize: BN;
    maxLeverage: number;
    dailyVolumeLimit: BN;
    emergencyCloseThreshold: Percent;
}

// Pool Configuration
export interface PoolConfig {
    minSize: BN;
    maxSize: BN;
    checkBurn: boolean;
    checkFreeze: boolean;
    checkRenounced: boolean;
    consecutiveMatches: number;
    filterCheckInterval: number;
    filterCheckDuration: number;
    liquidityThreshold: BN;
    volumeThreshold: BN;
}

// Token Management
export interface TokenPairConfig {
    wsol: {
        address: string;
        decimals: number;
    };
    usdc: {
        address: string;
        decimals: number;
    };
    defaultSlippage: number;
}

// Events
export interface MarketEvent {
    type: 'market:update' | 'pool:new' | 'wallet:update';
    address: PublicKey;
    data: any;
    timestamp: Date;
}

export interface SubscriptionEvent {
    type: 'subscription-expired' | 'subscription-renewed' | 'subscription-cancelled';
    userId: string;
    planId: string;
    timestamp: Date;
    details: UserSubscription;
}

export interface TradeEvent {
    type: 'trade:executed' | 'trade:failed' | 'position:closed';
    context: TradeExecutionContext;
    result: TransactionResult;
    timestamp: Date;
}

// Database Models
export interface DatabaseConfig {
    uri: string;
    options: {
        useNewUrlParser: boolean;
        useUnifiedTopology: boolean;
        maxPoolSize: number;
    };
}

// Service Interfaces
export interface IMarketDataService {
    getMarketState(lpAddress: PublicKey): Promise<MarketState>;
    subscribeToMarketUpdates(lpAddress: PublicKey, callback: (state: MarketState) => void): Promise<() => void>;
    getMarketSummary(pair: TradingPair): Promise<{
        currentPrice: BN;
        priceChange24h: Percent;
        volume24h: BN;
        liquidity: BN;
        volatility24h?: Percent;
    }>;
}

export interface IPoolAnalyzer {
    validatePool(lpAddress: PublicKey): Promise<boolean>;
    getPoolKeys(lpAddress: PublicKey): Promise<any>;
    getPoolState(lpAddress: PublicKey): Promise<any>;
}

export interface IRiskManager {
    validateTrade(context: TradeExecutionContext): Promise<boolean>;
    shouldClosePosition(position: TradeExecutionContext, update: { marketState: MarketState; pnlPercent: Percent }): Promise<boolean>;
    updateRiskMetrics(userId: string, update: { loss?: BN; volume?: BN; isLoss?: boolean }): void;
}

// Cache Keys
export type CacheKey = string;
export type CacheValue = any;

// Error Types
export interface ErrorContext {
    context: string;
    timestamp: Date;
    details: Record<string, any>;
}

export interface ErrorReport extends Error {
    context: ErrorContext;
    timestamp: Date;
    severity: 'low' | 'medium' | 'high' | 'critical';
}
