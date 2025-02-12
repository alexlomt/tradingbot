// src/services/trading/transaction-builder.ts
import { 
    Connection, 
    Keypair, 
    PublicKey, 
    TransactionMessage, 
    VersionedTransaction,
    ComputeBudgetProgram
} from '@solana/web3.js';
import { 
    Liquidity, 
    Token, 
    TokenAmount, 
    LiquidityPoolKeysV4,
    MARKET_STATE_LAYOUT_V3,
    Percent
} from '@raydium-io/raydium-sdk';
import { 
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { logger } from '../../config/logger';
import { MetricsCollector } from '../monitoring/metrics';

export class TransactionBuilder {
    private metrics: MetricsCollector;

    constructor(
        private readonly connection: Connection,
        private readonly config: any
    ) {
        this.metrics = MetricsCollector.getInstance();
    }

    async buildBuyTransaction(
        poolKeys: LiquidityPoolKeysV4,
        wallet: Keypair,
        mintAta: PublicKey,
        amountIn: TokenAmount,
        slippage: number
    ): Promise<{
        transaction: VersionedTransaction;
        signers: Keypair[];
    }> {
        try {
            const timer = this.metrics.startTimer('buildBuyTransaction');

            // Get pool info for price calculation
            const poolInfo = await Liquidity.fetchInfo({
                connection: this.connection,
                poolKeys,
            });

            // Calculate minimum amount out with slippage
            const slippagePercent = new Percent(slippage, 100);
            const computedAmountOut = Liquidity.computeAmountOut({
                poolKeys,
                poolInfo,
                amountIn,
                currencyOut: new Token(
                    TOKEN_PROGRAM_ID,
                    poolKeys.baseMint,
                    poolKeys.baseDecimals
                ),
                slippage: slippagePercent,
            });

            // Get latest blockhash
            const latestBlockhash = await this.connection.getLatestBlockhash();

            // Create Raydium swap instruction
            const { innerTransaction } = Liquidity.makeSwapFixedInInstruction({
                poolKeys,
                userKeys: {
                    tokenAccountIn: this.config.quoteAta,
                    tokenAccountOut: mintAta,
                    owner: wallet.publicKey,
                },
                amountIn: amountIn.raw,
                minAmountOut: computedAmountOut.minAmountOut.raw,
            });

            // Build transaction
            const messageV0 = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: latestBlockhash.blockhash,
                instructions: [
                    // Add compute budget if using default executor
                    ...(this.config.transactionExecutor === 'default' ? [
                        ComputeBudgetProgram.setComputeUnitPrice({
                            microLamports: this.config.computeUnitPrice
                        }),
                        ComputeBudgetProgram.setComputeUnitLimit({
                            units: this.config.computeUnitLimit
                        })
                    ] : []),
                    // Create ATA if needed
                    createAssociatedTokenAccountIdempotentInstruction(
                        wallet.publicKey,
                        mintAta,
                        wallet.publicKey,
                        poolKeys.baseMint
                    ),
                    ...innerTransaction.instructions
                ]
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);

            timer(); // Stop timer

            return {
                transaction,
                signers: [...innerTransaction.signers]
            };
        } catch (error) {
            logger.error('Error building buy transaction:', error);
            throw error;
        }
    }

    async buildSellTransaction(
        poolKeys: LiquidityPoolKeysV4,
        wallet: Keypair,
        tokenAccount: PublicKey,
        amountIn: TokenAmount,
        slippage: number
    ): Promise<{
        transaction: VersionedTransaction;
        signers: Keypair[];
    }> {
        try {
            const timer = this.metrics.startTimer('buildSellTransaction');

            // Get pool info for price calculation
            const poolInfo = await Liquidity.fetchInfo({
                connection: this.connection,
                poolKeys,
            });

            // Calculate minimum amount out with slippage
            const slippagePercent = new Percent(slippage, 100);
            const computedAmountOut = Liquidity.computeAmountOut({
                poolKeys,
                poolInfo,
                amountIn,
                currencyOut: this.config.quoteToken,
                slippage: slippagePercent,
            });

            // Get latest blockhash
            const latestBlockhash = await this.connection.getLatestBlockhash();

            // Create Raydium swap instruction
            const { innerTransaction } = Liquidity.makeSwapFixedInInstruction({
                poolKeys,
                userKeys: {
                    tokenAccountIn: tokenAccount,
                    tokenAccountOut: this.config.quoteAta,
                    owner: wallet.publicKey,
                },
                amountIn: amountIn.raw,
                minAmountOut: computedAmountOut.minAmountOut.raw,
            });

            // Build transaction
            const messageV0 = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: latestBlockhash.blockhash,
                instructions: [
                    // Add compute budget if using default executor
                    ...(this.config.transactionExecutor === 'default' ? [
                        ComputeBudgetProgram.setComputeUnitPrice({
                            microLamports: this.config.computeUnitPrice
                        }),
                        ComputeBudgetProgram.setComputeUnitLimit({
                            units: this.config.computeUnitLimit
                        })
                    ] : []),
                    ...innerTransaction.instructions,
                    // Close token account after sell
                    createCloseAccountInstruction(
                        tokenAccount,
                        wallet.publicKey,
                        wallet.publicKey
                    )
                ]
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);

            timer(); // Stop timer

            return {
                transaction,
                signers: [...innerTransaction.signers]
            };
        } catch (error) {
            logger.error('Error building sell transaction:', error);
            throw error;
        }
    }
}