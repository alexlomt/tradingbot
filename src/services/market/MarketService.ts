import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { 
    Connection, 
    PublicKey, 
    Keypair,
    Transaction,
    TransactionInstruction,
    ComputeBudgetProgram
} from '@solana/web3.js';
import { Market, Orderbook } from '@project-serum/serum';
import { Program, Provider } from '@project-serum/anchor';
import { Subject, BehaviorSubject, interval } from 'rxjs';
import { filter, map, takeUntil } from 'rxjs/operators';
import { RedisService } from '../cache/RedisService';
import { SOLANA_NETWORK_CONFIG, PROGRAM_IDS } from '../../config/constants';
import { LiquidityPool, TradeParams, TradeResult } from '../../types/trading.types';

@Injectable()
export class MarketService implements OnModuleInit {
    private readonly logger = new Logger(MarketService.name);
    private connection: Connection;
    private markets: Map<string, Market> = new Map();
    private orderbooks: Map<string, Orderbook> = new Map();
    private liquidityPools: Map<string, LiquidityPool> = new Map();
    private priceFeeds: Map<string, BehaviorSubject<number>> = new Map();
    private destroy$ = new Subject<void>();

    constructor(
        private configService: ConfigService,
        private redisService: RedisService
    ) {
        this.connection = new Connection(
            SOLANA_NETWORK_CONFIG.RPC_ENDPOINTS[0],
            SOLANA_NETWORK_CONFIG.COMMITMENT
        );
    }

    async onModuleInit() {
        await this.initializeMarkets();
        this.startPriceFeeds();
        this.startLiquidityMonitoring();
    }

    private async initializeMarkets() {
        const marketAddresses = await this.loadMarketAddresses();
        
        for (const address of marketAddresses) {
            try {
                const marketPubkey = new PublicKey(address);
                const market = await Market.load(
                    this.connection,
                    marketPubkey,
                    {},
                    PROGRAM_IDS.TOKEN_PROGRAM
                );
                
                this.markets.set(address, market);
                const [bids, asks] = await Promise.all([
                    market.loadBids(this.connection),
                    market.loadAsks(this.connection)
                ]);
                
                this.orderbooks.set(address, { bids, asks });
                this.priceFeeds.set(address, new BehaviorSubject<number>(0));
                
                await this.updateLiquidityPool(market, bids, asks);
            } catch (error) {
                this.logger.error(`Failed to initialize market ${address}`, error);
            }
        }
    }

    private startPriceFeeds() {
        interval(1000).pipe(
            takeUntil(this.destroy$)
        ).subscribe(async () => {
            for (const [address, market] of this.markets) {
                try {
                    const [bids, asks] = await Promise.all([
                        market.loadBids(this.connection),
                        market.loadAsks(this.connection)
                    ]);
                    
                    const bestBid = bids.getBestBid()?.price || 0;
                    const bestAsk = asks.getBestAsk()?.price || 0;
                    const midPrice = (bestBid + bestAsk) / 2;
                    
                    this.priceFeeds.get(address)?.next(midPrice);
                    await this.updateLiquidityPool(market, bids, asks);
                } catch (error) {
                    this.logger.error(`Failed to update price feed for ${address}`, error);
                }
            }
        });
    }

    private startLiquidityMonitoring() {
        interval(5000).pipe(
            takeUntil(this.destroy$)
        ).subscribe(async () => {
            for (const pool of this.liquidityPools.values()) {
                const volume24h = await this.calculateVolume24h(pool.address.toString());
                pool.volume24h = volume24h;
                await this.redisService.set(
                    `pool:${pool.address.toString()}:volume`,
                    volume24h.toString(),
                    3600
                );
            }
        });
    }

    async executeTrade(params: TradeParams): Promise<TradeResult> {
        const { inputMint, outputMint, amount, slippage, userId, walletPublicKey } = params;
        
        const pool = this.findBestPool(inputMint, outputMint, amount);
        if (!pool) {
            throw new Error('No suitable liquidity pool found');
        }

        const route = await this.calculateOptimalRoute(pool, amount);
        const transaction = await this.buildTradeTransaction(route, params);
        
        const result = await this.executeTransaction(transaction, params);
        await this.updatePoolState(pool, result);

        return {
            success: true,
            transactionHash: result.signature,
            inputAmount: amount,
            outputAmount: result.outputAmount,
            price: result.executionPrice,
            fee: result.fee,
            executionTime: result.executionTime,
            route: [pool]
        };
    }

    private async calculateOptimalRoute(pool: LiquidityPool, amount: number) {
        const marketImpact = await this.calculateMarketImpact(pool, amount);
        const optimalSplit = await this.calculateOptimalSplit(amount, marketImpact);
        
        return {
            pool,
            splits: optimalSplit,
            expectedOutput: this.calculateExpectedOutput(pool, amount, marketImpact)
        };
    }

    private async buildTradeTransaction(
        route: any,
        params: TradeParams
    ): Promise<Transaction> {
        const transaction = new Transaction();

        // Add compute budget instruction for better execution priority
        transaction.add(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: await this.calculateOptimalUnitPrice()
            })
        );

        // Add swap instructions
        const swapIx = await this.createSwapInstruction(route, params);
        transaction.add(swapIx);

        return transaction;
    }

    private async createSwapInstruction(
        route: any,
        params: TradeParams
    ): Promise<TransactionInstruction> {
        const { pool, splits } = route;
        
        return new TransactionInstruction({
            programId: new PublicKey(pool.address),
            keys: [
                { pubkey: new PublicKey(params.walletPublicKey), isSigner: true, isWritable: true },
                { pubkey: pool.tokenAMint, isSigner: false, isWritable: true },
                { pubkey: pool.tokenBMint, isSigner: false, isWritable: true },
                { pubkey: PROGRAM_IDS.TOKEN_PROGRAM, isSigner: false, isWritable: false }
            ],
            data: Buffer.from([
                ...new Uint8Array([0]), // instruction discriminator
                ...new Uint8Array(new Float64Array([params.amount]).buffer),
                ...new Uint8Array(new Float64Array([params.slippage]).buffer)
            ])
        });
    }

    private async updatePoolState(pool: LiquidityPool, tradeResult: any) {
        pool.tokenAReserve += tradeResult.inputAmount;
        pool.tokenBReserve -= tradeResult.outputAmount;
        pool.volume24h += tradeResult.inputAmount;
        
        await this.redisService.set(
            `pool:${pool.address.toString()}`,
            JSON.stringify(pool),
            300
        );
    }

    private findBestPool(
        inputMint: PublicKey,
        outputMint: PublicKey,
        amount: number
    ): LiquidityPool | null {
        let bestPool: LiquidityPool | null = null;
        let lowestImpact = Infinity;

        for (const pool of this.liquidityPools.values()) {
            if (
                (pool.tokenAMint.equals(inputMint) && pool.tokenBMint.equals(outputMint)) ||
                (pool.tokenAMint.equals(outputMint) && pool.tokenBMint.equals(inputMint))
            ) {
                const impact = this.calculatePriceImpact(pool, amount);
                if (impact < lowestImpact) {
                    lowestImpact = impact;
                    bestPool = pool;
                }
            }
        }

        return bestPool;
    }

    private calculatePriceImpact(pool: LiquidityPool, amount: number): number {
        const k = pool.tokenAReserve * pool.tokenBReserve;
        const newReserve = pool.tokenAReserve + amount;
        const newOutput = k / newReserve;
        const priceImpact = Math.abs(1 - (newOutput / pool.tokenBReserve));
        
        return priceImpact;
    }

    async getMarketPrice(inputMint: string, outputMint: string): Promise<number> {
        for (const [address, feed] of this.priceFeeds) {
            const market = this.markets.get(address);
            if (
                market?.baseMintAddress.toString() === inputMint &&
                market?.quoteMintAddress.toString() === outputMint
            ) {
                return feed.getValue();
            }
        }
        throw new Error('Market not found');
    }

    async onDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }
}
