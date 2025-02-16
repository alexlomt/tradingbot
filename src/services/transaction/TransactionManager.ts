import {
    Connection,
    Keypair,
    Transaction,
    TransactionInstruction,
    PublicKey,
    VersionedTransaction,
    TransactionMessage,
    AddressLookupTableAccount,
    ComputeBudgetProgram,
    SendTransactionError
} from '@solana/web3.js';
import {
    TransactionConfig,
    TransactionResult,
    TradeEvent
} from '../../types/trading.types';
import { WarpTransactionService } from './WarpTransactionService';
import { JitoTransactionService } from './JitoTransactionService';
import { Redis } from 'ioredis';
import { logger } from '../../utils/logger';
import { ErrorReporter } from '../../utils/errorReporting';
import { PerformanceMonitor } from '../../utils/performance';
import { ConfigService } from '../config/ConfigService';
import { EventEmitter } from 'events';
import BN from 'bn.js';

interface TransactionCache {
    signature: string;
    type: string;
    status: 'pending' | 'confirmed' | 'failed';
    timestamp: number;
    metadata?: Record<string, any>;
}

export class TransactionManager extends EventEmitter {
    private readonly redis?: Redis;
    private readonly lookupTables: Map<string, AddressLookupTableAccount>;
    private readonly pendingTransactions: Map<string, {
        retries: number;
        lastAttempt: number;
    }>;
    private readonly performanceMonitor: PerformanceMonitor;

    constructor(
        private readonly connection: Connection,
        private readonly warpService: WarpTransactionService,
        private readonly jitoService: JitoTransactionService,
        private readonly config: ConfigService
    ) {
        super();
        this.lookupTables = new Map();
        this.pendingTransactions = new Map();
        this.performanceMonitor = new PerformanceMonitor();

        if (config.get('REDIS_ENABLED') === 'true') {
            this.redis = new Redis({
                host: config.get('REDIS_HOST'),
                port: parseInt(config.get('REDIS_PORT') || '6379'),
                password: config.get('REDIS_PASSWORD'),
                retryStrategy: (times: number) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            });

            this.redis.on('error', (error) => {
                logger.error('Redis connection error:', error);
                ErrorReporter.reportError(error, {
                    context: 'TransactionManager.redis',
                    service: 'Redis'
                });
            });
        }

        this.initializeLookupTables();
        this.startTransactionMonitoring();
    }

    async createTransaction(
        instructions: TransactionInstruction[],
        config?: TransactionConfig
    ): Promise<VersionedTransaction> {
        const timer = this.performanceMonitor.startTimer('createTransaction');

        try {
            if (config?.priorityFee) {
                instructions.unshift(
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: config.priorityFee.toNumber()
                    })
                );
            }

            if (config?.computeUnitLimit) {
                instructions.unshift(
                    ComputeBudgetProgram.setComputeUnitLimit({
                        units: config.computeUnitLimit
                    })
                );
            }

            const lookupTableAccounts = await this.getRelevantLookupTables(instructions);
            const messageV0 = new TransactionMessage({
                payerKey: this.connection.rpcEndpoint.includes('devnet') 
                    ? new PublicKey('11111111111111111111111111111111') 
                    : new PublicKey(this.config.get('WALLET_PUBLIC_KEY')),
                recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
                instructions
            }).compileToV0Message(lookupTableAccounts);

            return new VersionedTransaction(messageV0);
        } catch (error) {
            logger.error('Error creating transaction:', error);
            ErrorReporter.reportError(error, {
                context: 'TransactionManager.createTransaction',
                instructions: instructions.length
            });
            throw error;
        } finally {
            this.performanceMonitor.endTimer('createTransaction', timer);
        }
    }

    async sendTransaction(
        transaction: VersionedTransaction,
        signer: Keypair,
        config?: TransactionConfig
    ): Promise<TransactionResult> {
        const timer = this.performanceMonitor.startTimer('sendTransaction');

        try {
            let signature: string;

            // Handle different transaction services
            if (config?.warpEnabled) {
                signature = await this.warpService.sendTransaction(
                    transaction,
                    signer,
                    config
                );
            } else if (config?.jitoEnabled) {
                signature = await this.jitoService.sendTransaction(
                    transaction,
                    signer,
                    config
                );
            } else {
                signature = await this.sendStandardTransaction(
                    transaction,
                    signer,
                    config
                );
            }

            // Monitor transaction
            this.pendingTransactions.set(signature, {
                retries: 0,
                lastAttempt: Date.now()
            });

            // Wait for confirmation
            const confirmation = await this.waitForConfirmation(
                signature,
                config?.maxTimeout || 60000
            );

            if (!confirmation.success) {
                throw new Error(`Transaction failed: ${confirmation.error}`);
            }

            // Cache successful transaction
            await this.cacheTransaction(signature, {
                type: 'standard',
                status: 'confirmed',
                timestamp: Date.now()
            });

            return {
                success: true,
                signature,
                gasUsed: confirmation.gasUsed
            };

        } catch (error) {
            logger.error('Transaction error:', error);
            ErrorReporter.reportError(error, {
                context: 'TransactionManager.sendTransaction',
                config: JSON.stringify(config)
            });

            return {
                success: false,
                error: error.message
            };
        } finally {
            this.performanceMonitor.endTimer('sendTransaction', timer);
        }
    }

    private async sendStandardTransaction(
        transaction: VersionedTransaction,
        signer: Keypair,
        config?: TransactionConfig
    ): Promise<string> {
        transaction.sign([signer]);

        const signature = await this.connection.sendTransaction(transaction, {
            skipPreflight: config?.skipPreflight || false,
            maxRetries: config?.maxRetries || 3,
            preflightCommitment: 'processed'
        });

        return signature;
    }

    private async waitForConfirmation(
        signature: string,
        timeout: number
    ): Promise<{ success: boolean; error?: string; gasUsed?: number }> {
        try {
            const startTime = Date.now();
            
            while (Date.now() - startTime < timeout) {
                const confirmation = await this.connection.getSignatureStatus(signature);
                
                if (confirmation.value?.err) {
                    return {
                        success: false,
                        error: JSON.stringify(confirmation.value.err)
                    };
                }

                if (confirmation.value?.confirmationStatus === 'confirmed') {
                    const tx = await this.connection.getTransaction(signature, {
                        maxSupportedTransactionVersion: 0
                    });

                    return {
                        success: true,
                        gasUsed: tx?.meta?.computeUnitsConsumed
                    };
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            throw new Error('Transaction confirmation timeout');
        } catch (error) {
            logger.error('Confirmation error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async cacheTransaction(
        signature: string,
        metadata: Partial<TransactionCache>
    ): Promise<void> {
        if (!this.redis) return;

        try {
            await this.redis.setex(
                `tx:${signature}`,
                24 * 60 * 60, // 24 hours
                JSON.stringify({
                    signature,
                    ...metadata,
                    timestamp: Date.now()
                })
            );
        } catch (error) {
            logger.error('Cache transaction error:', error);
        }
    }

    private async initializeLookupTables(): Promise<void> {
        try {
            const tables = this.config.get('LOOKUP_TABLES')?.split(',') || [];
            
            for (const table of tables) {
                const account = await this.connection.getAddressLookupTable(
                    new PublicKey(table)
                );
                
                if (account.value) {
                    this.lookupTables.set(table, account.value);
                }
            }
        } catch (error) {
            logger.error('Error initializing lookup tables:', error);
        }
    }

    private async getRelevantLookupTables(
        instructions: TransactionInstruction[]
    ): Promise<AddressLookupTableAccount[]> {
        const relevantTables: AddressLookupTableAccount[] = [];
        const programIds = new Set(instructions.map(ix => ix.programId.toString()));

        for (const [address, table] of this.lookupTables.entries()) {
            if (table.state.addresses.some(addr => 
                programIds.has(addr.toString())
            )) {
                relevantTables.push(table);
            }
        }

        return relevantTables;
    }

    private startTransactionMonitoring(): void {
        setInterval(() => {
            for (const [signature, data] of this.pendingTransactions.entries()) {
                if (Date.now() - data.lastAttempt > 60000) { // 1 minute
                    this.pendingTransactions.delete(signature);
                }
            }
        }, 60000); // Check every minute
    }

    addTradeEventHandler(handler: (event: TradeEvent) => void): void {
        this.on('trade', handler);
    }

    removeTradeEventHandler(handler: (event: TradeEvent) => void): void {
        this.off('trade', handler);
    }
}
