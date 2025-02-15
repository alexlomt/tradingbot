import { Injectable, Logger } from '@nestjs/common';
import { 
    Connection, 
    Transaction, 
    PublicKey, 
    SendOptions,
    ComputeBudgetProgram,
    TransactionMessage,
    VersionedTransaction
} from '@solana/web3.js';
import { JitoClient } from './clients/JitoClient';
import { WarpClient } from './clients/WarpClient';
import { RedisService } from '../cache/RedisService';
import { MarketService } from '../market/MarketService';
import * as retry from 'async-retry';
import { 
    TransactionConfig,
    TransactionResult,
    MEVProtectionStrategy
} from '../../types/transaction.types';
import { SOLANA_NETWORK_CONFIG } from '../../config/constants';

@Injectable()
export class TransactionService {
    private readonly logger = new Logger(TransactionService.name);
    private readonly connection: Connection;
    private readonly networkLatency: Map<string, number> = new Map();

    constructor(
        private readonly jitoClient: JitoClient,
        private readonly warpClient: WarpClient,
        private readonly redisService: RedisService,
        private readonly marketService: MarketService,
        private readonly configService: ConfigService
    ) {
        this.connection = new Connection(
            SOLANA_NETWORK_CONFIG.RPC_ENDPOINTS[0],
            SOLANA_NETWORK_CONFIG.COMMITMENT
        );
        this.initializeNetworkMonitoring();
    }

    private async initializeNetworkMonitoring() {
        setInterval(async () => {
            for (const endpoint of SOLANA_NETWORK_CONFIG.RPC_ENDPOINTS) {
                const latency = await this.measureNetworkLatency(endpoint);
                this.networkLatency.set(endpoint, latency);
            }
        }, 60000); // Monitor every minute
    }

    async sendTransaction(
        transaction: Transaction,
        config: TransactionConfig
    ): Promise<TransactionResult> {
        const startTime = Date.now();
        
        try {
            // Optimize transaction for current network conditions
            const optimizedTx = await this.optimizeTransaction(transaction, config);
            
            // Select MEV protection strategy based on transaction value and network conditions
            const mevStrategy = await this.selectMEVProtectionStrategy(config);
            
            // Execute transaction with retry logic
            const result = await retry(
                async (bail) => {
                    try {
                        return await this.executeTransaction(optimizedTx, mevStrategy, config);
                    } catch (error) {
                        if (this.isRetryableError(error)) {
                            throw error;
                        }
                        bail(error);
                        return null;
                    }
                },
                {
                    retries: SOLANA_NETWORK_CONFIG.RETRY_ATTEMPTS,
                    factor: 1.5,
                    minTimeout: 1000,
                    maxTimeout: 5000
                }
            );

            if (!result) {
                throw new Error('Transaction failed after retries');
            }

            await this.verifyTransaction(result.signature);
            await this.cacheTransactionResult(result);

            return {
                ...result,
                executionTime: Date.now() - startTime
            };
        } catch (error) {
            this.logger.error('Transaction failed', {
                error,
                config,
                transactionId: transaction.signature?.toString()
            });
            throw error;
        }
    }

    private async optimizeTransaction(
        transaction: Transaction,
        config: TransactionConfig
    ): Promise<Transaction | VersionedTransaction> {
        // Add compute budget instruction based on transaction complexity
        const computeUnits = await this.estimateComputeUnits(transaction);
        const priorityFee = await this.calculateOptimalPriorityFee();

        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({
                units: computeUnits
            }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: priorityFee
            })
        );

        // Convert to versioned transaction if supported
        if (config.useVersionedTransactions) {
            const blockhash = await this.connection.getLatestBlockhash();
            const messageV0 = new TransactionMessage({
                payerKey: new PublicKey(config.payerPublicKey),
                recentBlockhash: blockhash.blockhash,
                instructions: transaction.instructions
            }).compileToV0Message();

            return new VersionedTransaction(messageV0);
        }

        return transaction;
    }

    private async selectMEVProtectionStrategy(
        config: TransactionConfig
    ): Promise<MEVProtectionStrategy> {
        const networkCongestion = await this.getNetworkCongestion();
        const transactionValue = config.transactionValue || 0;

        if (transactionValue > 1000 || networkCongestion > 0.8) {
            return {
                type: 'jito',
                bundleSize: this.calculateOptimalBundleSize(transactionValue),
                tipAmount: this.calculateOptimalTipAmount(transactionValue, networkCongestion)
            };
        } else if (transactionValue > 100 || networkCongestion > 0.5) {
            return {
                type: 'warp',
                maxDelay: 2000,
                priorityFee: this.calculateOptimalPriorityFee()
            };
        }

        return { type: 'default' };
    }

    private async executeTransaction(
        transaction: Transaction | VersionedTransaction,
        mevStrategy: MEVProtectionStrategy,
        config: TransactionConfig
    ): Promise<TransactionResult> {
        switch (mevStrategy.type) {
            case 'jito':
                return await this.jitoClient.sendBundle(
                    transaction,
                    mevStrategy.bundleSize,
                    mevStrategy.tipAmount
                );
            case 'warp':
                return await this.warpClient.sendTransaction(
                    transaction,
                    mevStrategy.maxDelay,
                    mevStrategy.priorityFee
                );
            default:
                const options: SendOptions = {
                    skipPreflight: config.skipPreflight || false,
                    maxRetries: config.maxRetries || SOLANA_NETWORK_CONFIG.RETRY_ATTEMPTS,
                    preflightCommitment: SOLANA_NETWORK_CONFIG.COMMITMENT
                };
                
                const signature = await this.connection.sendTransaction(
                    transaction,
                    options
                );

                return {
                    signature,
                    executionPrice: await this.marketService.getExecutionPrice(config.marketAddress),
                    fee: await this.calculateTransactionFee(transaction)
                };
        }
    }

    private async verifyTransaction(signature: string): Promise<void> {
        const confirmation = await this.connection.confirmTransaction({
            signature,
            blockhash: await this.connection.getLatestBlockhash().blockhash,
            lastValidBlockHeight: await this.connection.getBlockHeight()
        });

        if (confirmation.value.err) {
            throw new Error(`Transaction verification failed: ${confirmation.value.err}`);
        }
    }

    private async estimateComputeUnits(transaction: Transaction): Promise<number> {
        const simulation = await this.connection.simulateTransaction(transaction);
        return simulation.value.unitsConsumed || 200000;
    }

    private async calculateOptimalPriorityFee(): Promise<number> {
        const recentPriorityFees = await this.redisService.get('recent_priority_fees');
        const networkCongestion = await this.getNetworkCongestion();
        
        const baseFee = recentPriorityFees 
            ? Math.ceil(JSON.parse(recentPriorityFees).median * 1.2)
            : 1000000;

        return Math.ceil(baseFee * (1 + networkCongestion));
    }

    private async getNetworkCongestion(): Promise<number> {
        const recentBlocktime = await this.connection.getRecentBlockhash();
        const currentSlot = await this.connection.getSlot();
        const targetBlockTime = 400; // ms
        
        const blocktime = recentBlocktime.lastValidBlockHeight / currentSlot * targetBlockTime;
        return Math.min(Math.max((blocktime - targetBlockTime) / targetBlockTime, 0), 1);
    }

    private calculateOptimalBundleSize(transactionValue: number): number {
        return Math.min(Math.ceil(transactionValue / 1000), 5);
    }

    private calculateOptimalTipAmount(
        transactionValue: number,
        networkCongestion: number
    ): number {
        const baseTip = transactionValue * 0.001;
        return Math.ceil(baseTip * (1 + networkCongestion * 2));
    }

    private async measureNetworkLatency(endpoint: string): Promise<number> {
        const start = Date.now();
        try {
            const connection = new Connection(endpoint);
            await connection.getLatestBlockhash();
            return Date.now() - start;
        } catch {
            return Infinity;
        }
    }

    private async cacheTransactionResult(result: TransactionResult): Promise<void> {
        await this.redisService.set(
            `tx:${result.signature}`,
            JSON.stringify(result),
            3600
        );
    }

    private isRetryableError(error: any): boolean {
        const retryableErrors = [
            'Network request failed',
            'Transaction simulation failed',
            'Transaction was not confirmed',
            'Too many requests',
            'Gateway timeout'
        ];

        return retryableErrors.some(msg => error.message?.includes(msg));
    }
}
