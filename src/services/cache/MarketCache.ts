import { Connection, PublicKey } from '@solana/web3.js';
import { Market, MarketState, Percent } from '@raydium-io/raydium-sdk';
import { Redis } from 'ioredis';
import { logger } from '../../utils/logger';
import { ConfigService } from '../config/ConfigService';
import { ErrorReporter } from '../../utils/errorReporting';
import BN from 'bn.js';

interface MarketCacheEntry {
    state: MarketState;
    lastUpdated: number;
    volatility24h?: Percent;
    volume24h?: BN;
    metadata?: Record<string, any>;
}

export class MarketCache {
    private readonly cache: Map<string, MarketCacheEntry>;
    private readonly redis?: Redis;
    private readonly TTL: number = 24 * 60 * 60; // 24 hours in seconds
    private readonly CLEANUP_INTERVAL: number = 60 * 60 * 1000; // 1 hour in milliseconds
    private readonly connection: Connection;

    constructor(
        connection: Connection,
        private readonly config?: ConfigService
    ) {
        this.connection = connection;
        this.cache = new Map();

        if (config?.get('REDIS_ENABLED') === 'true') {
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
                    context: 'MarketCache.redis',
                    service: 'Redis'
                });
            });
        }

        setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
    }

    async add(
        address: PublicKey,
        state: MarketState,
        metadata?: Record<string, any>
    ): Promise<void> {
        const entry: MarketCacheEntry = {
            state,
            lastUpdated: Date.now(),
            metadata
        };

        this.cache.set(address.toString(), entry);

        if (this.redis) {
            try {
                await this.redis.setex(
                    `market:${address.toString()}`,
                    this.TTL,
                    JSON.stringify(entry)
                );
            } catch (error) {
                logger.error('Redis set error:', error);
                ErrorReporter.reportError(error, {
                    context: 'MarketCache.add',
                    address: address.toString()
                });
            }
        }
    }

    async get(address: PublicKey): Promise<MarketCacheEntry | null> {
        const addressStr = address.toString();

        // Try memory cache first
        const memoryEntry = this.cache.get(addressStr);
        if (memoryEntry) {
            return memoryEntry;
        }

        // Try Redis if available
        if (this.redis) {
            try {
                const redisEntry = await this.redis.get(`market:${addressStr}`);
                if (redisEntry) {
                    const entry = JSON.parse(redisEntry);
                    this.cache.set(addressStr, entry); // Update memory cache
                    return entry;
                }
            } catch (error) {
                logger.error('Redis get error:', error);
                ErrorReporter.reportError(error, {
                    context: 'MarketCache.get',
                    address: addressStr
                });
            }
        }

        // If not in cache, fetch from chain
        try {
            const marketState = await this.fetchMarketState(address);
            if (marketState) {
                await this.add(address, marketState);
                return this.cache.get(addressStr)!;
            }
        } catch (error) {
            logger.error('Market fetch error:', error);
            ErrorReporter.reportError(error, {
                context: 'MarketCache.get',
                address: addressStr
            });
        }

        return null;
    }

    private async fetchMarketState(address: PublicKey): Promise<MarketState | null> {
        try {
            const accountInfo = await this.connection.getAccountInfo(address);
            if (!accountInfo) return null;

            return Market.getStateLayout().decode(accountInfo.data);
        } catch (error) {
            logger.error('Error fetching market state:', error);
            ErrorReporter.reportError(error, {
                context: 'MarketCache.fetchMarketState',
                address: address.toString()
            });
            return null;
        }
    }

    async update(
        address: PublicKey,
        updates: Partial<Omit<MarketCacheEntry, 'state'>>
    ): Promise<void> {
        const addressStr = address.toString();
        const entry = await this.get(address);
        if (!entry) {
            logger.warn(`Attempted to update non-existent market cache entry: ${addressStr}`);
            return;
        }

        const updatedEntry = {
            ...entry,
            ...updates,
            lastUpdated: Date.now()
        };

        this.cache.set(addressStr, updatedEntry);

        if (this.redis) {
            try {
                await this.redis.setex(
                    `market:${addressStr}`,
                    this.TTL,
                    JSON.stringify(updatedEntry)
                );
            } catch (error) {
                logger.error('Redis update error:', error);
                ErrorReporter.reportError(error, {
                    context: 'MarketCache.update',
                    address: addressStr
                });
            }
        }
    }

    has(address: PublicKey): boolean {
        return this.cache.has(address.toString());
    }

    async delete(address: PublicKey): Promise<void> {
        const addressStr = address.toString();
        this.cache.delete(addressStr);

        if (this.redis) {
            try {
                await this.redis.del(`market:${addressStr}`);
            } catch (error) {
                logger.error('Redis delete error:', error);
                ErrorReporter.reportError(error, {
                    context: 'MarketCache.delete',
                    address: addressStr
                });
            }
        }
    }

    private cleanup(): void {
        const now = Date.now();
        const expiryTime = now - (this.TTL * 1000);

        for (const [address, entry] of this.cache.entries()) {
            if (entry.lastUpdated < expiryTime) {
                this.delete(new PublicKey(address));
            }
        }
    }

    async getAllMarkets(): Promise<Map<string, MarketCacheEntry>> {
        if (this.redis) {
            try {
                const keys = await this.redis.keys('market:*');
                const entries = await Promise.all(
                    keys.map(async (key) => {
                        const value = await this.redis!.get(key);
                        return [key.replace('market:', ''), JSON.parse(value!)];
                    })
                );
                return new Map(entries);
            } catch (error) {
                logger.error('Redis getAllMarkets error:', error);
                ErrorReporter.reportError(error, {
                    context: 'MarketCache.getAllMarkets'
                });
            }
        }

        return new Map(this.cache);
    }

    async clear(): Promise<void> {
        this.cache.clear();

        if (this.redis) {
            try {
                const keys = await this.redis.keys('market:*');
                if (keys.length > 0) {
                    await this.redis.del(...keys);
                }
            } catch (error) {
                logger.error('Redis clear error:', error);
                ErrorReporter.reportError(error, {
                    context: 'MarketCache.clear'
                });
            }
        }
    }
}
