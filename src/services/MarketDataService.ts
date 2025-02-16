import {
    Connection,
    PublicKey,
} from '@solana/web3.js';
import {
    MarketState,
    TradingPair
} from '../types/trading.types';
import { PoolAnalyzer } from '../core/PoolAnalyzer';
import { Cache } from '../utils/Cache';
import { logger } from '../utils/logger';
import { RateLimiter } from '../utils/RateLimiter';
import { EventEmitter } from 'events';
import { BN } from 'bn.js';

export class MarketDataService extends EventEmitter {
    private readonly marketStateCache: Cache<string, MarketState>;
    private readonly priceUpdateSubscriptions: Map<string, number>;
    private readonly rateLimiter: RateLimiter;
    private readonly updateInterval: number;
    private isRunning: boolean = false;

    constructor(
        private readonly connection: Connection,
        private readonly poolAnalyzer: PoolAnalyzer,
        cacheDuration: number = 5000, // 5 seconds
        updateInterval: number = 1000 // 1 second
    ) {
        super();
        this.marketStateCache = new Cache<string, MarketState>(cacheDuration);
        this.priceUpdateSubscriptions = new Map();
        this.rateLimiter = new RateLimiter({
            maxRequests: 50,
            timeWindow: 1000
        });
        this.updateInterval = updateInterval;
    }

    async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.startMarketDataLoop();
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        this.marketStateCache.clear();
        this.priceUpdateSubscriptions.clear();
    }

    async getMarketState(lpAddress: PublicKey): Promise<MarketState> {
        const cached = this.marketStateCache.get(lpAddress.toString());
        if (cached) return cached;

        await this.rateLimiter.checkLimit();
        const state = await this.poolAnalyzer.getPoolState(lpAddress);
        
        if (!state) {
            throw new Error(`Failed to fetch market state for ${lpAddress}`);
        }

        this.marketStateCache.set(lpAddress.toString(), state);
        return state;
    }

    async subscribeToMarketUpdates(
        lpAddress: PublicKey,
        callback: (state: MarketState) => void
    ): Promise<() => void> {
        const key = lpAddress.toString();
        const currentSubs = this.priceUpdateSubscriptions.get(key) || 0;
        this.priceUpdateSubscriptions.set(key, currentSubs + 1);

        this.on(`market-update:${key}`, callback);

        return () => {
            const subs = this.priceUpdateSubscriptions.get(key) || 0;
            if (subs <= 1) {
                this.priceUpdateSubscriptions.delete(key);
            } else {
                this.priceUpdateSubscriptions.set(key, subs - 1);
            }
            this.off(`market-update:${key}`, callback);
        };
    }

    async getMarketSummary(pair: TradingPair): Promise<{
        currentPrice: BN;
        priceChange24h: Percent;
        volume24h: BN;
        liquidity: BN;
        volatility24h?: Percent;
    }> {
        const state = await this.getMarketState(pair.lpAddress);
        return {
            currentPrice: state.price,
            priceChange24h: state.priceChange24h,
            volume24h: state.volume24h,
            liquidity: state.liquidity,
            volatility24h: state.volatility24h
        };
    }

    private async startMarketDataLoop(): Promise<void> {
        while (this.isRunning) {
            try {
                await this.updateMarketData();
                await new Promise(resolve => setTimeout(resolve, this.updateInterval));
            } catch (error) {
                logger.error('Error in market data loop:', error);
            }
        }
    }

    private async updateMarketData(): Promise<void> {
        const subscriptions = Array.from(this.priceUpdateSubscriptions.keys());
        
        await Promise.all(
            subscriptions.map(async (lpAddress) => {
                try {
                    await this.rateLimiter.checkLimit();
                    const state = await this.poolAnalyzer.getPoolState(new PublicKey(lpAddress));
                    
                    if (state) {
                        this.marketStateCache.set(lpAddress, state);
                        this.emit(`market-update:${lpAddress}`, state);
                    }
                } catch (error) {
                    logger.error(`Error updating market data for ${lpAddress}:`, error);
                }
            })
        );
    }
}
