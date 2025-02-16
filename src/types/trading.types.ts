import { PublicKey, TransactionMessage, VersionedTransaction, Commitment } from '@solana/web3.js';
import { Token, TokenAmount, Percent } from '@raydium-io/raydium-sdk';
import { BN } from 'bn.js';

// Subscription System Types
export interface SubscriptionPlan {
    id: string;
    name: string;
    price: number;
    duration: number;
    features: string[];
    maxPositions: number;
    allowedPairs: string[];
    priority: boolean;
    maxDailyTrades: number;
    maxConcurrentTrades: number;
    customStrategySupport: boolean;
}

export interface UserSubscription {
    userId: string;
    planId: string;
    startDate: Date;
    endDate: Date;
    active: boolean;
    paymentHistory: PaymentRecord[];
    features: {
        maxPositions: number;
        allowedPairs: string[];
        priority: boolean;
        maxDailyTrades: number;
        maxConcurrentTrades: number;
        customStrategySupport: boolean;
    };
    tradingStats: {
        dailyTradeCount: number;
        lastTradingDay: Date;
        totalTradeCount: number;
        activePositions: number;
    };
}

export interface PaymentRecord {
    id: string;
    amount: number;
    date: Date;
    status: 'pending' | 'completed' | 'failed';
    transactionId?: string;
    planId: string;
    currency: string;
    paymentMethod: string;
}

// Trading System Types
export interface TransactionConfig {
    computeUnitLimit: number;
    computeUnitPrice: number;
    retryCount: number;
    confirmationStrategy: Commitment;
    priorityFee?: number;
    warpEnabled?: boolean;
    jitoEnabled?: boolean;
    maxTimeout?: number;
    skipPreflight?: boolean;
    subscriberPriority?: boolean;
}

export interface TradingPair {
    baseToken: Token;
    quoteToken: Token;
    baseAmount: TokenAmount;
    quoteAmount: TokenAmount;
    lpAddress: PublicKey;
    marketId: string;
    minLotSize: BN;
    tickSize: BN;
}

export interface TradingStrategyConfig {
    autoBuyDelay: number;
    autoSellDelay: number;
    takeProfit: Percent;
    stopLoss: Percent;
    trailingStop?: Percent;
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

export interface RiskManagementConfig {
    maxDailyLoss: Percent;
    maxPositionSize: TokenAmount;
    maxLeverage: number;
    dailyVolumeLimit: BN;
    emergencyCloseThreshold: Percent;
}

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

export interface TransactionResult {
    signature: string;
    success: boolean;
    error?: string;
    blockTime?: number;
    fee?: number;
    slot?: number;
    confirmations?: number;
    executionTime?: number;
}

export interface TradeExecutionContext {
    pair: TradingPair;
    side: 'buy' | 'sell';
    amount: TokenAmount;
    slippage: Percent;
    timestamp: Date;
    txConfig: TransactionConfig;
    userSubscription?: UserSubscription;
    strategy?: string;
    positionId?: string;
    metadata?: Record<string, any>;
}

export interface MarketState {
    price: BN;
    liquidity: BN;
    volume24h: BN;
    lastUpdate: Date;
    isActive: boolean;
    volatility24h?: Percent;
    priceChange24h?: Percent;
    marketCap?: BN;
    totalTrades24h?: number;
}

export type TransactionExecutor = (
    transaction: VersionedTransaction,
    config: TransactionConfig,
    subscription?: UserSubscription
) => Promise<TransactionResult>;

export interface TradingPermissions {
    canTrade: boolean;
    maxPositions: number;
    allowedPairs: string[];
    priorityExecution: boolean;
    subscriptionValid: boolean;
    remainingDailyTrades: number;
    customStrategiesAllowed: boolean;
}

export interface SubscriptionEvent {
    type: 'subscription-created' | 'subscription-updated' | 'subscription-expired' | 'payment-received';
    userId: string;
    planId: string;
    timestamp: Date;
    details: Partial<UserSubscription>;
}

export type SubscriptionEventHandler = (event: SubscriptionEvent) => Promise<void>;

export interface TradeEvent {
    type: 'trade-executed' | 'trade-failed' | 'position-closed';
    userId: string;
    tradeContext: TradeExecutionContext;
    result: TransactionResult;
    timestamp: Date;
}

export type TradeEventHandler = (event: TradeEvent) => Promise<void>;
