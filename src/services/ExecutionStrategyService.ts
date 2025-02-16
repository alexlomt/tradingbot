import {
    Connection,
    Keypair,
    Transaction,
    VersionedTransaction,
    TransactionMessage,
    PublicKey,
    ComputeBudgetProgram,
} from '@solana/web3.js';
import {
    TransactionConfig,
    TransactionResult,
    ExecutionStrategy
} from '../types/trading.types';
import { WarpExecutor } from './WarpExecutor';
import { JitoExecutor } from './JitoExecutor';
import { logger } from '../utils/logger';
import { ErrorReporter } from '../utils/errorReporting';
import { RateLimiter } from '../utils/RateLimiter';

export class ExecutionStrategyService {
    private readonly rateLimiter: RateLimiter;
    private currentStrategy: ExecutionStrategy = 'default';
    
    constructor(
        private readonly connection: Connection,
        private readonly warpExecutor: WarpExecutor,
        private readonly jitoExecutor: JitoExecutor,
        private readonly maxRetries: number = 3
    ) {
        this.rateLimiter = new RateLimiter({
            maxRequests: 30,
            timeWindow: 1000
        });
    }

    async executeTransaction(
        transaction: VersionedTransaction,
        signer: Keypair,
        config: TransactionConfig
    ): Promise<TransactionResult> {
        let attempts = 0;
        let lastError: Error | null = null;

        while (attempts < this.maxRetries) {
            try {
                await this.rateLimiter.checkLimit();
                
                const strategy = this.selectStrategy(config);
                const result = await this.executeWithStrategy(
                    strategy,
                    transaction,
                    signer,
                    config
                );

                if (result.success) {
                    return result;
                }

                // If the transaction failed, try a different strategy
                this.rotateStrategy();
                attempts++;
                
                if (result.error) {
                    lastError = new Error(result.error);
                }
            } catch (error) {
                lastError = error as Error;
                attempts++;
                await this.handleExecutionError(error, attempts);
            }
        }

        ErrorReporter.reportError(lastError || new Error('Max retries exceeded'), {
            context: 'ExecutionStrategyService.executeTransaction',
            attempts,
            strategy: this.currentStrategy
        });

        return {
            success: false,
            error: lastError?.message || 'Transaction failed after max retries'
        };
    }

    private selectStrategy(config: TransactionConfig): ExecutionStrategy {
        if (config.warpEnabled && config.priorityFee > 1000) {
            return 'warp';
        }
        
        if (config.jitoEnabled && config.priorityFee > 2000) {
            return 'jito';
        }
        
        return 'default';
    }

    private async executeWithStrategy(
        strategy: ExecutionStrategy,
        transaction: VersionedTransaction,
        signer: Keypair,
        config: TransactionConfig
    ): Promise<TransactionResult> {
        const latestBlockhash = await this.connection.getLatestBlockhash();
        
        switch (strategy) {
            case 'warp':
                return this.warpExecutor.executeTransaction(
                    transaction,
                    config,
                    undefined // subscription passed if available
                );
                
            case 'jito':
                return this.jitoExecutor.executeTransaction(
                    transaction,
                    config,
                    undefined // subscription passed if available
                );
                
            default:
                return this.executeDefaultStrategy(
                    transaction,
                    signer,
                    latestBlockhash,
                    config
                );
        }
    }

    private async executeDefaultStrategy(
        transaction: VersionedTransaction,
        signer: Keypair,
        blockhash: { blockhash: string; lastValidBlockHeight: number },
        config: TransactionConfig
    ): Promise<TransactionResult> {
        try {
            // Add compute budget instruction if needed
            if (config.computeUnitLimit || config.computeUnitPrice) {
                const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({
                    units: config.computeUnitLimit || 200000
                });
                
                const priceIx = ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: config.computeUnitPrice || 1
                });

                transaction.message.instructions.unshift(budgetIx, priceIx);
            }

            transaction.sign([signer]);
            
            const signature = await this.connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: config.skipPreflight || false,
                    maxRetries: 1
                }
            );

            const confirmation = await this.connection.confirmTransaction({
                signature,
                ...blockhash
            });

            return {
                signature,
                success: !confirmation.value.err,
                error: confirmation.value.err?.toString()
            };
        } catch (error) {
            logger.error('Default execution strategy failed:', error);
            throw error;
        }
    }

    private rotateStrategy(): void {
        const strategies: ExecutionStrategy[] = ['default', 'warp', 'jito'];
        const currentIndex = strategies.indexOf(this.currentStrategy);
        this.currentStrategy = strategies[(currentIndex + 1) % strategies.length];
    }

    private async handleExecutionError(error: any, attempt: number): Promise<void> {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        if (attempt < this.maxRetries - 1) {
            this.rotateStrategy();
        }
    }
}
