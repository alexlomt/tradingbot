import { Connection, PublicKey, TransactionInstruction, Keypair } from '@solana/web3.js';
import { Token, TokenAmount, Currency, LiquidityStateV4, Percent } from '@raydium-io/raydium-sdk';
import BN from 'bn.js';

export interface TradingStrategyConfig {
    // Core trading settings
    oneTokenAtTime: boolean;
    autoSell: boolean;
    preLoadExistingMarkets: boolean;
    cacheNewMarkets: boolean;
    useSnipeList: boolean;
    
    // Transaction settings
    useWarpTransactions: boolean;
    useJitoTransactions: boolean;
    useCustomFee: boolean;
    customFee?: BN;
    computeUnitLimit: number;
    computeUnitPrice: number;
    skipPreflight: boolean;
    maxRetries: number;
    maxTimeout: number;

    // Trading parameters
    quoteAmount: TokenAmount;
    buySlippage: number;
    sellSlippage: number;
    autoBuyDelay: number;
    autoSellDelay: number;
    maxBuyRetries: number;
    maxSellRetries: number;
    retryDelay: number;
    minTimeBetweenTrades: number;

    // Risk management
    takeProfit: number;
    stopLoss: number;
    maxHoldingTime: number;
    priceCheckInterval: number;
    maxPriceChange: BN;
    maxVolumeChange: BN;
    minLiquidityUsd: BN;
    emergencyCloseAll: boolean;

    // Risk limits
    riskManagement: RiskManagementConfig;
}

export interface RiskManagementConfig {
    maxPositionSize: BN;
    dailyVolumeLimit: BN;
    maxDrawdown: number;
    maxLeverage: number;
    minLiquidity: BN;
    maxSlippage: number;
    maxExposurePerToken: number;
    cooldownPeriod: number;
    emergencyThresholds: EmergencyThresholds;
}

export interface EmergencyThresholds {
    maxLoss: number;
    maxDrawdown: number;
    minLiquidity: BN;
    volatilityThreshold: number;
    maxPriceDeviation: number;
}

export interface TradingPair {
    lpAddress: PublicKey;
    baseToken: Token;
    quoteToken: Token;
    baseAmount: TokenAmount;
    quoteAmount: TokenAmount;
}

export interface MarketState {
    isActive: boolean;
    price: BN;
    bids: PublicKey;
    asks: PublicKey;
    eventQueue: PublicKey;
    volume24h: BN;
    liquidity: BN;
    lastUpdate: number;
    volatility24h?: Percent;
}

export interface PoolState extends LiquidityStateV4 {
    lastTraded?: number;
    priceHistory?: Array<{
        price: BN;
        timestamp: number;
    }>;
    metadata?: Record<string, any>;
}

export interface TradeExecutionContext {
    pair: TradingPair;
    side: 'buy' | 'sell';
    amount: TokenAmount;
    slippage: Percent;
    timestamp: Date;
    userSubscription: UserSubscription;
    txConfig: TransactionConfig;
    positionId: string;
    metadata?: Record<string, any>;
}

export interface TransactionConfig {
    warpEnabled: boolean;
    jitoEnabled: boolean;
    priorityFee?: BN;
    computeUnitLimit: number;
    computeUnitPrice: number;
    skipPreflight: boolean;
    maxRetries: number;
    maxTimeout: number;
}

export interface TransactionResult {
    success: boolean;
    signature?: string;
    error?: string;
    price?: BN;
    gasUsed?: number;
    effects?: {
        balanceChanges: Map<string, BN>;
        tokenChanges: Map<string, TokenAmount>;
    };
}

export interface UserSubscription {
    userId: string;
    tier: 'basic' | 'premium' | 'enterprise';
    features: {
        warpEnabled: boolean;
        jitoEnabled: boolean;
        maxConcurrentTrades: number;
        maxDailyTrades: number;
        priorityExecution: boolean;
    };
    limits: {
        dailyVolume: BN;
        maxPositionSize: BN;
        maxLeverage: number;
    };
    metadata?: Record<string, any>;
}

export interface PoolValidationConfig {
    minLiquidity: BN;
    maxLiquidity: BN;
    minVolume24h: BN;
    maxPriceImpact: number;
    minHolders: number;
    checkMutable: boolean;
    checkSocials: boolean;
    checkRenounced: boolean;
    checkFreezable: boolean;
    checkBurned: boolean;
}

export interface PoolAnalysisResult {
    isValid: boolean;
    reason?: string;
    poolState: LiquidityStateV4 | null;
    marketState: MarketState | null;
    securityChecks: PoolSecurityCheck | null;
}

export interface PoolSecurityCheck {
    isMutable: boolean;
    hasSocials: boolean;
    isRenounced: boolean;
    isFreezable: boolean;
    isBurned: boolean;
    allPassed: boolean;
}

export interface TradeMetrics {
    entryPrice: BN;
    currentPrice: BN;
    unrealizedPnL: BN;
    realizedPnL: BN;
    fees: BN;
    volume: BN;
    holdingTime: number;
    roi: Percent;
}

export interface TradeEvent {
    type: string;
    context: TradeExecutionContext;
    result?: TransactionResult;
    metrics?: TradeMetrics;
    timestamp: Date;
}

export interface MarketDataSubscription {
    marketAddress: PublicKey;
    updateInterval: number;
    callback: (state: MarketState) => Promise<void>;
}

export interface SnipeListEntry {
    mint: PublicKey;
    symbol: string;
    addedAt: number;
    metadata?: Record<string, any>;
}

export interface ExecutionStrategy {
    name: string;
    enabled: boolean;
    priority: number;
    config: Record<string, any>;
    validate: (context: TradeExecutionContext) => Promise<boolean>;
    execute: (
        instructions: TransactionInstruction[],
        context: TradeExecutionContext
    ) => Promise<TransactionResult>;
}

// Enums
export enum TradeStatus {
    PENDING = 'pending',
    EXECUTING = 'executing',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELLED = 'cancelled'
}

export enum OrderType {
    MARKET = 'market',
    LIMIT = 'limit',
    STOP_LOSS = 'stop_loss',
    TAKE_PROFIT = 'take_profit'
}

export enum TradeDirection {
    BUY = 'buy',
    SELL = 'sell'
}

// Type guards
export function isMarketState(obj: any): obj is MarketState {
    return obj && 
           typeof obj.isActive === 'boolean' &&
           obj.price instanceof BN &&
           obj.volume24h instanceof BN;
}

export function isPoolState(obj: any): obj is PoolState {
    return obj && 
           obj.baseDecimal instanceof BN &&
           obj.quoteDecimal instanceof BN;
}
