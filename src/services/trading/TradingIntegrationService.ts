import { Injectable, Logger } from '@nestjs/common';
import { WalletService } from '../wallet/WalletService';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey, Transaction, SendOptions } from '@solana/web3.js';
import { TokenInfo } from '@solana/spl-token-registry';
import { SubscriptionService } from '../subscription/SubscriptionService';
import { MarketCacheService } from './MarketCacheService';
import { TokenValidationService } from './TokenValidationService';
import { TransactionExecutorService } from './TransactionExecutorService';
import { RetryConfig, ExecutionStrategy } from '../../types/trading.types';
import { WarpClient } from './clients/WarpClient';
import { JitoClient } from './clients/JitoClient';

@Injectable()
export class TradingIntegrationService {
    private readonly logger = new Logger(TradingIntegrationService.name);
    private readonly connection: Connection;
    private readonly retryConfig: RetryConfig;

    constructor(
        private readonly walletService: WalletService,
        private readonly configService: ConfigService,
        private readonly subscriptionService: SubscriptionService,
        private readonly marketCache: MarketCacheService,
        private readonly tokenValidation: TokenValidationService,
        private readonly transactionExecutor: TransactionExecutorService,
        private readonly warpClient: WarpClient,
        private readonly jitoClient: JitoClient
    ) {
        this.connection = new Connection(
            this.configService.get<string>('SOLANA_RPC_URL')!,
            'confirmed'
        );

        this.retryConfig = {
            maxAttempts: this.configService.get<number>('MAX_RETRY_ATTEMPTS') || 3,
            baseDelay: this.configService.get<number>('RETRY_BASE_DELAY') || 1000,
            maxDelay: this.configService.get<number>('RETRY_MAX_DELAY') || 5000
        };
    }

    async executeTrade(
        userId: string,
        walletPublicKey: string,
        tokenAddress: string,
        amount: number,
        isBuy: boolean,
        options: {
            slippageTolerance?: number;
            executionStrategy?: ExecutionStrategy;
            priority?: boolean;
        } = {}
    ) {
        // Validate subscription tier limits
        const subscription = await this.subscriptionService.getUserSubscription(userId);
        const wallet = await this.walletService.getWallet(userId, walletPublicKey);
        
        await this.validateTradingLimits(wallet, amount, subscription);

        // Validate token security
        const tokenValidation = await this.tokenValidation.validateToken(tokenAddress);
        if (!tokenValidation.isValid) {
            throw new Error(`Token validation failed: ${tokenValidation.reason}`);
        }

        // Get market data from cache
        const marketData = await this.marketCache.getMarketData(tokenAddress);
        if (!marketData) {
            throw new Error('Market data not available');
        }

        // Prepare transaction
        const privateKey = await this.walletService.getWalletPrivateKey(userId, walletPublicKey);
        const transaction = await this.prepareTransaction(
            privateKey,
            tokenAddress,
            amount,
            isBuy,
            options.slippageTolerance
        );

        // Execute transaction based on strategy
        const result = await this.executeTransaction(
            transaction,
            options.executionStrategy || 'default',
            options.priority || false
        );

        // Update wallet trading metrics
        await this.updateTradingMetrics(wallet, amount);

        return {
            success: true,
            transactionHash: result.signature,
            executionTime: result.executionTime,
            price: result.executedPrice,
            fee: result.fee
        };
    }

    private async validateTradingLimits(wallet: any, amount: number, subscription: any) {
        const { maxPerTradeAmount, maxDailyTrades } = subscription.limits;

        if (amount > maxPerTradeAmount) {
            throw new Error(`Trade amount exceeds tier limit of ${maxPerTradeAmount} USD`);
        }

        if (wallet.dailyTradeCount >= maxDailyTrades) {
            throw new Error(`Daily trade limit of ${maxDailyTrades} reached`);
        }
    }

    private async prepareTransaction(
        privateKey: string,
        tokenAddress: string,
        amount: number,
        isBuy: boolean,
        slippageTolerance: number = 0.01
    ): Promise<Transaction> {
        const market = await this.marketCache.getMarketData(tokenAddress);
        
        // Compute optimal route and build transaction
        const route = await this.findOptimalRoute(tokenAddress, amount, isBuy);
        
        // Calculate minimum output amount with slippage
        const minOutputAmount = this.calculateMinimumOutput(amount, slippageTolerance);

        // Build the transaction with computed parameters
        const transaction = await this.buildTransaction(route, minOutputAmount);

        // Optimize compute units
        await this.optimizeComputeUnits(transaction);

        return transaction;
    }

    private async executeTransaction(
        transaction: Transaction,
        strategy: ExecutionStrategy,
        priority: boolean
    ) {
        let executor;
        switch (strategy) {
            case 'warp':
                executor = this.warpClient;
                break;
            case 'jito':
                executor = this.jitoClient;
                break;
            default:
                executor = this.transactionExecutor;
        }

        const options: SendOptions = {
            maxRetries: this.retryConfig.maxAttempts,
            skipPreflight: priority
        };

        return await executor.execute(transaction, options);
    }

    private async updateTradingMetrics(wallet: any, amount: number) {
        wallet.tradingVolume += amount;
        wallet.dailyTradeCount += 1;
        wallet.lastUsed = new Date();
        await wallet.save();
    }

    private async findOptimalRoute(
        tokenAddress: string,
        amount: number,
        isBuy: boolean
    ) {
        const pools = await this.marketCache.getLiquidityPools(tokenAddress);
        return this.calculateOptimalRoute(pools, amount, isBuy);
    }

    private calculateOptimalRoute(pools: any[], amount: number, isBuy: boolean) {
        // Implementation of optimal route calculation
        // This would include pool selection, price impact calculation,
        // and route optimization logic
        const routes = pools.map(pool => ({
            pool,
            priceImpact: this.calculatePriceImpact(pool, amount, isBuy),
            liquidity: pool.liquidity
        }));

        return routes
            .sort((a, b) => a.priceImpact - b.priceImpact)
            .filter(route => route.liquidity > amount * 2)[0];
    }

    private calculatePriceImpact(pool: any, amount: number, isBuy: boolean): number {
        const { tokenAReserve, tokenBReserve } = pool;
        const k = tokenAReserve * tokenBReserve;
        
        if (isBuy) {
            const newTokenBReserve = tokenBReserve + amount;
            const newTokenAReserve = k / newTokenBReserve;
            return (tokenAReserve - newTokenAReserve) / tokenAReserve;
        } else {
            const newTokenAReserve = tokenAReserve + amount;
            const newTokenBReserve = k / newTokenAReserve;
            return (tokenBReserve - newTokenBReserve) / tokenBReserve;
        }
    }

    private async optimizeComputeUnits(transaction: Transaction): Promise<void> {
        const units = await this.estimateComputeUnits(transaction);
        transaction.setComputeUnitLimit(units);
        transaction.setComputeUnitPrice(this.calculateOptimalComputeUnitPrice());
    }

    private async estimateComputeUnits(transaction: Transaction): Promise<number> {
        const simulation = await this.connection.simulateTransaction(transaction);
        return simulation.value.unitsConsumed || 200000; // Default if estimation fails
    }

    private calculateOptimalComputeUnitPrice(): number {
        // Implementation of compute unit price calculation based on
        // network congestion and priority requirements
        return this.marketCache.getAverageComputeUnitPrice() * 1.2;
    }

    private calculateMinimumOutput(amount: number, slippageTolerance: number): number {
        return amount * (1 - slippageTolerance);
    }
  
    private async buildTransaction(route: any, minOutputAmount: number): Promise<Transaction> {
        const transaction = new Transaction();
        
        // Add token swap instructions
        const swapInstruction = this.createSwapInstruction(
            route.pool.address,
            route.pool.authority,
            route.inputToken,
            route.outputToken,
            route.amount,
            minOutputAmount
        );
        transaction.add(swapInstruction);

        // Add compute budget instruction for priority fee
        const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: this.calculateOptimalPriorityFee()
        });
        transaction.add(priorityFeeInstruction);

        // Add lookup table instruction if available
        if (route.pool.lookupTableAddress) {
            const lookupTableInstruction = AddressLookupTableProgram.createLookupTable({
                authority: route.pool.authority,
                lookupTableAddress: new PublicKey(route.pool.lookupTableAddress),
                payer: route.userPublicKey,
                recentSlot: await this.connection.getSlot()
            });
            transaction.add(lookupTableInstruction);
        }

        // Add MEV protection if enabled
        if (route.mevProtection) {
            const bundleInstruction = await this.jitoClient.createBundleInstruction({
                transaction,
                tipAmount: this.calculateJitoTip()
            });
            transaction.add(bundleInstruction);
        }

        // Add referral fee instruction if applicable
        if (route.referralAddress) {
            const referralInstruction = this.createReferralInstruction(
                route.referralAddress,
                route.referralFeeBps
            );
            transaction.add(referralInstruction);
        }

        // Versioned transaction support
        const { blockhash } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = new PublicKey(route.userPublicKey);

        // Optimize transaction size
        transaction.compileMessage();
        
        return transaction;
    }

    private createSwapInstruction(
        poolAddress: string,
        authority: string,
        inputToken: TokenInfo,
        outputToken: TokenInfo,
        amount: number,
        minOutputAmount: number
    ): TransactionInstruction {
        return new TransactionInstruction({
            programId: new PublicKey(SWAP_PROGRAM_ID),
            keys: [
                { pubkey: new PublicKey(poolAddress), isSigner: false, isWritable: true },
                { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
                { pubkey: new PublicKey(inputToken.address), isSigner: false, isWritable: true },
                { pubkey: new PublicKey(outputToken.address), isSigner: false, isWritable: true },
                { pubkey: new PublicKey(inputToken.mintAddress), isSigner: false, isWritable: true },
                { pubkey: new PublicKey(outputToken.mintAddress), isSigner: false, isWritable: true },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([
                ...new BN(amount).toArray('le', 8),
                ...new BN(minOutputAmount).toArray('le', 8),
            ])
        });
    }

    private createReferralInstruction(
        referralAddress: string,
        referralFeeBps: number
    ): TransactionInstruction {
        return new TransactionInstruction({
            programId: new PublicKey(REFERRAL_PROGRAM_ID),
            keys: [
                { pubkey: new PublicKey(referralAddress), isSigner: false, isWritable: true },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([
                ...new BN(referralFeeBps).toArray('le', 2),
            ])
        });
    }

    private calculateOptimalPriorityFee(): number {
        const basePrice = 1_000_000; // 1 LAMPORT
        const networkCongestion = this.marketCache.getNetworkCongestion();
        const congestionMultiplier = Math.max(1, networkCongestion * 1.5);
        
        return Math.floor(basePrice * congestionMultiplier);
    }

    private calculateJitoTip(): number {
        const baseTip = 10_000; // 0.00001 SOL
        const networkCongestion = this.marketCache.getNetworkCongestion();
        return Math.floor(baseTip * (1 + networkCongestion));
    }

    // ... (remaining code stays the same)
