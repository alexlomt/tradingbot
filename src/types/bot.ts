// src/types/bot.ts
export interface BotConfig {
    walletPrivateKey: string;
    rpcEndpoint: string;
    rpcWebsocketEndpoint: string;
    commitmentLevel: 'processed' | 'confirmed' | 'finalized';
    quoteMint: 'WSOL' | 'USDC';
    quoteAmount: string;
    buySlippage: number;
    sellSlippage: number;
    takeProfit: number;
    stopLoss: number;
    autoSell: boolean;
    transactionExecutor: 'default' | 'warp' | 'jito';
    customFee?: string;
    minPoolSize: number;
    maxPoolSize: number;
    checkIfMutable: boolean;
    checkIfSocials: boolean;
    checkIfMintIsRenounced: boolean;
    checkIfFreezable: boolean;
    checkIfBurned: boolean;
}

export interface BotMetrics {
    totalTrades: number;
    successfulTrades: number;
    failedTrades: number;
    totalVolume: number;
    profitLoss: number;
    lastUpdated: Date;
}
