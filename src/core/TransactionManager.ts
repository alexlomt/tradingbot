import {
    Connection,
    Keypair,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    TransactionInstruction,
} from '@solana/web3.js';
import { Mutex } from 'async-mutex';
import {
    TransactionConfig,
    TransactionResult,
    TransactionExecutor,
    UserSubscription,
    TradeEvent,
    TradeEventHandler
} from '../types/trading.types';
import { PerformanceMonitor } from '../utils/performance';
import { ErrorReporter } from '../utils/errorReporting';
import { logger } from '../utils/logger';
import { BN } from 'bn.js';

export class TransactionManager {
    private readonly mutex: Mutex;
    private readonly defaultConfig: TransactionConfig;
    private readonly eventHandlers: Set<TradeEventHandler>;
    private transactionCount: number = 0;
    private lastTransactionTime: number = 0;

    constructor(
        private readonly connection: Connection,
        private readonly wallet: Keypair,
        private readonly warpExecutor?: TransactionExecutor,
        private readonly jitoExecutor?: TransactionExecutor,
        config?: Partial<TransactionConfig>
    ) {
        this.mutex = new Mutex();
        this.eventHandlers = new Set();
        this.defaultConfig = {
            computeUnitLimit: 200_000,
            computeUnitPrice: 1000,
            retryCount: 3,
            confirmationStrategy: 'confirmed',
            priorityFee: 0,
            warpEnabled: false,
            jitoEnabled: false,
            maxTimeout: 30000,
            skipPreflight: false,
            subscriberPriority: false,
            ...config
        };
    }

    async executeTransaction(
        instructions: TransactionInstruction[],
        config?: Partial<TransactionConfig>,
        subscription?: UserSubscription
    ): Promise<TransactionResult> {
        const release = await this.mutex.acquire();
        const startTime = performance.now();

        try {
            return await PerformanceMonitor.measureAsync(
                'transaction-execution',
                async () => {
                    const finalConfig = this.prepareTransactionConfig(config, subscription);
                    
                    // Rate limiting check
                    if (!this.checkTransactionRateLimit()) {
                        throw new Error('Transaction rate limit exceeded');
                    }

                    const transaction = await this.buildTransaction(
                        instructions,
                        finalConfig
                    );

                    const result = await this.executeWithStrategy(
                        transaction,
                        finalConfig,
                        subscription
                    );

                    await this.emitTradeEvent({
                        type: result.success ? 'trade-executed' : 'trade-failed',
                        userId: subscription?.userId || 'anonymous',
                        result,
                        timestamp: new Date(),
                        tradeContext: {
                            txConfig: finalConfig,
                            timestamp: new Date(),
                            userSubscription: subscription
                        }
                    });

                    return {
                        ...result,
                        executionTime: performance.now() - startTime
                    };
                }
            );
        } catch (error) {
            const errorResult = {
                signature: '',
                success: false,
                error: error.message,
                executionTime: performance.now() - startTime
            };

            ErrorReporter.reportError(error, {
                context: 'TransactionManager.executeTransaction',
                config: config,
                subscription: subscription?.userId
            });

            await this.emitTradeEvent({
                type: 'trade-failed',
                userId: subscription?.userId || 'anonymous',
                result: errorResult,
                timestamp: new Date(),
                tradeContext: {
                    txConfig: config,
                    timestamp: new Date(),
                    userSubscription: subscription
                }
            });

            throw error;
        } finally {
            this.updateTransactionMetrics();
            release();
        }
    }

    private prepareTransactionConfig(
        config?: Partial<TransactionConfig>,
        subscription?: UserSubscription
    ): TransactionConfig {
        const finalConfig = { ...this.defaultConfig, ...config };

        if (subscription?.features.priority) {
            finalConfig.priorityFee = Math.max(
                finalConfig.priorityFee || 0,
                subscription.features.priority ? 2000 : 1000
            );
            finalConfig.subscriberPriority = true;
        }

        return finalConfig;
    }

    private async buildTransaction(
        instructions: TransactionInstruction[],
        config: TransactionConfig
    ): Promise<VersionedTransaction> {
        const { computeUnitLimit, computeUnitPrice, priorityFee } = config;

        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
            units: computeUnitLimit
        });

        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: computeUnitPrice + (priorityFee || 0)
        });

        const recentBlockhash = await this.connection.getLatestBlockhash(
            config.confirmationStrategy
        );

        const message = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: recentBlockhash.blockhash,
            instructions: [
                modifyComputeUnits,
                addPriorityFee,
                ...instructions
            ]
        }).compileToV0Message();

        const transaction = new VersionedTransaction(message);
        transaction.sign([this.wallet]);

        return transaction;
    }

    private async executeWithStrategy(
        transaction: VersionedTransaction,
        config: TransactionConfig,
        subscription?: UserSubscription
    ): Promise<TransactionResult> {
        if (config.warpEnabled && this.warpExecutor) {
            return this.warpExecutor(transaction, config, subscription);
        }

        if (config.jitoEnabled && this.jitoExecutor) {
            return this.jitoExecutor(transaction, config, subscription);
        }

        return this.executeStandardTransaction(transaction, config);
    }

    private async executeStandardTransaction(
        transaction: VersionedTransaction,
        config: TransactionConfig
    ): Promise<TransactionResult> {
        let lastError: Error;
        const startTime = Date.now();

        for (let attempt = 1; attempt <= config.retryCount; attempt++) {
            try {
                if (Date.now() - startTime > config.maxTimeout) {
                    throw new Error('Transaction timeout exceeded');
                }

                const signature = await this.connection.sendTransaction(
                    transaction,
                    {
                        maxRetries: 3,
                        skipPreflight: config.skipPreflight
                    }
                );

                const confirmation = await this.connection.confirmTransaction(
                    {
                        signature,
                        blockhash: transaction.message.recentBlockhash,
                        lastValidBlockHeight: (await this.connection.getLatestBlockhash()).lastValidBlockHeight
                    },
                    config.confirmationStrategy
                );

                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${confirmation.value.err}`);
                }

                const txInfo = await this.connection.getTransaction(signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: config.confirmationStrategy
                });

                return {
                    signature,
                    success: true,
                    blockTime: txInfo?.blockTime || Date.now() / 1000,
                    fee: txInfo?.meta?.fee || 0,
                    slot: txInfo?.slot,
                    confirmations: txInfo?.confirmations || 0
                };
            } catch (error) {
                lastError = error;
                logger.warn(`Transaction attempt ${attempt} failed: ${error.message}`);
                
                if (attempt < config.retryCount) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                }
            }
        }

        return {
            signature: '',
            success: false,
            error: lastError.message
        };
    }

    private checkTransactionRateLimit(): boolean {
        const now = Date.now();
        const timeWindow = 1000; // 1 second
        const maxTransactions = 10; // Max 10 transactions per second

        if (now - this.lastTransactionTime > timeWindow) {
            this.transactionCount = 0;
        }

        if (this.transactionCount >= maxTransactions) {
            return false;
        }

        return true;
    }

    private updateTransactionMetrics(): void {
        const now = Date.now();
        this.lastTransactionTime = now;
        this.transactionCount++;
    }

    public addTradeEventHandler(handler: TradeEventHandler): void {
        this.eventHandlers.add(handler);
    }

    public removeTradeEventHandler(handler: TradeEventHandler): void {
        this.eventHandlers.delete(handler);
    }

    private async emitTradeEvent(event: TradeEvent): Promise<void> {
        for (const handler of this.eventHandlers) {
            try {
                await handler(event);
            } catch (error) {
                logger.error('Error in trade event handler:', error);
            }
        }
    }
}
