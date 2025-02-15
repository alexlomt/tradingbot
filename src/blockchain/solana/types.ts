import { Commitment, PublicKey } from '@solana/web3.js';

export interface SolanaConfig {
    rpcEndpoint: string;
    wsEndpoint: string;
    privateKey: string;
    commitment: Commitment;
}

export interface TransactionResult {
    signature: string;
    confirmationStatus: any;
    duration: number;
}

export interface TokenAccountInfo {
    mint: PublicKey;
    owner: PublicKey;
    amount: bigint;
    delegate: PublicKey | null;
    state: number;
    isNative: boolean;
    delegatedAmount: bigint;
    closeAuthority: PublicKey | null;
}

export interface NetworkStatus {
    slotHeight: number;
    epoch: number;
    absoluteSlot: number;
    blockHeight: number;
    transactionsPerSecond: number;
    totalSupply: number;
    circulating: number;
}

export interface SolanaMetrics {
    signature: string;
    duration: number;
    success: boolean;
    timestamp: Date;
}

export interface SlotMetrics {
    slot: number;
    timestamp: Date;
    parent: number;
    root: number;
}
