import { PublicKey } from '@solana/web3.js';

export interface TradingLimits {
    maxTradeAmount: number;
    maxDailyTrades: number;
}

export interface SubscriptionTier {
    id: string;
    name: 'BASIC' | 'PREMIUM' | 'UNLIMITED' | 'TRIAL';
    price: number;
    limits: TradingLimits;
}

export interface WalletConfig {
    publicKey: PublicKey;
    encryptedPrivateKey: string;
    userId: string;
    authorizedIps: string[];
}

export interface TradeParams {
    inputMint: PublicKey;
    outputMint: PublicKey;
    amount: number;
    slippage: number;
    userId: string;
    walletPublicKey: string;
}

export interface LiquidityPool {
    address: PublicKey;
    tokenAMint: PublicKey;
    tokenBMint: PublicKey;
    tokenAReserve: number;
    tokenBReserve: number;
    price: number;
    volume24h: number;
    fee: number;
}

export interface ExecutionStrategy {
    type: 'default' | 'warp' | 'jito';
    priority: boolean;
    routingStrategy: 'single' | 'split';
}

export interface TradeResult {
    success: boolean;
    transactionHash: string;
    inputAmount: number;
    outputAmount: number;
    price: number;
    fee: number;
    executionTime: number;
    route: LiquidityPool[];
}
