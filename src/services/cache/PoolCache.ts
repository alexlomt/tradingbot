import { PublicKey } from '@solana/web3.js';
import { LiquidityStateV4, TokenAmount, Currency } from '@raydium-io/raydium-sdk';
import { Redis } from 'ioredis';
import { logger } from '../../utils/logger';
import { ConfigService } from '../config/ConfigService';
import { ErrorReporter } from '../../utils/errorReporting';
import BN from 'bn.js';

interface PoolCacheEntry {
    state: LiquidityStateV4;
    lastUpdated: number;
    lastTraded?: number;
    price?: BN;
    liquidity?: BN;
    metadata?: Record<string, any>;
}

export class PoolCache {
    private readonly cache: Map<string, PoolCacheEntry>;
    private readonly redis?: Redis;
    private readonly TTL: number = 24 * 60 * 60; // 24 hours in seconds
    private readonly CLEANUP_INTERVAL: number = 60 * 60 * 1000; // 1 hour in milliseconds

    constructor(private readonly config?: ConfigService) {
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
                    context: 'PoolCache.redis',
                    service: 'Redis'
                });
            });
        }

        // Start cleanup interval
        setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
    }

    async add(
        address: string,
        state: LiquidityStateV4,
        metadata?: Record<string, any>
    ): Promise<void> {
        const entry: PoolCacheEntry = {
            state,
            lastUpdated: Date.now(),
            metadata
        };

        this.cache.set(address, entry);

        if (this.redis) {
            try {
                await this.redis.setex(
                    `pool:${address}`,
                    this.TTL,
                    JSON.stringify(entry)
                );
            } catch (error) {
                logger.error('Redis set error:', error);
                ErrorReporter.reportError(error, {
                    context: 'PoolCache.add',
                    address
                });
            }
        }
    }

    async get(address: string): Promise<PoolCacheEntry | null> {
        // Try memory cache first
        const memoryEntry = this.cache.get(address);
        if (memoryEntry) {
            return memoryEntry;
        }

        // Try Redis if available
        if (this.redis) {
            try {
                const redisEntry = await this.redis.get(`pool:${address}`);
                if (redisEntry) {
                    const entry = JSON.parse(redisEntry);
                    this.cache.set(address, entry); // Update memory cache
                    return entry;
                }
            } catch (error) {
                logger.error('Redis get error:', error);
                ErrorReporter.reportError(error, {
                    context: 'PoolCache.get',
                    address
                });
            }
        }

        return null;
    }

    async update(
        address: string,
        updates: Partial<Omit<PoolCacheEntry, 'state'>>
    ): Promise<void> {
        const entry = await this.get(address);
        if (!entry) {
            logger.warn(`Attempted to update non-existent pool cache entry: ${address}`);
            return;
        }

        const updatedEntry = {
            ...entry,
            ...updates,
            lastUpdated: Date.now()
        };

        this.cache.set(address, updatedEntry);

        if (this.redis) {
            try {
                await this.redis.setex(
                    `pool:${address}`,
                    this.TTL,
                    JSON.stringify(updatedEntry)
                );
            } catch (error) {
                logger.error('Redis update error:', error);
                ErrorReporter.reportError(error, {
                    context: 'PoolCache.update',
                    address
                });
            }
        }
    }

    has(address: string): boolean {
        return this.cache.has(address);
    }

    async delete(address: string): Promise<void> {
        this.cache.delete(address);

        if (this.redis) {
            try {
                await this.redis.del(`pool:${address}`);
            } catch (error) {
                logger.error('Redis delete error:', error);
                ErrorReporter.reportError(error, {
                    context: 'PoolCache.delete',
                    address
                });
            }
        }
    }

    private cleanup(): void {
        const now = Date.now();
        const expiryTime = now - (this.TTL * 1000);

        for (const [address, entry] of this.cache.entries()) {
            if (entry.lastUpdated < expiryTime) {
                this.delete(address);
            }
        }
    }

    async getAllPools(): Promise<Map<string, PoolCacheEntry>> {
        if (this.redis) {
            try {
                const keys = await this.redis.keys('pool:*');
                const entries = await Promise.all(
                    keys.map(async (key) => {
                        const value = await this.redis!.get(key);
                        return [key.replace('pool:', ''), JSON.parse(value!)];
                    })
                );
                return new Map(entries);
            } catch (error) {
                logger.error('Redis getAllPools error:', error);
                ErrorReporter.reportError(error, {
                    context: 'PoolCache.getAllPools'
                });
            }
        }

        return new Map(this.cache);
    }

    async clear(): Promise<void> {
        this.cache.clear();

        if (this.redis) {
            try {
                const keys = await this.redis.keys('pool:*');
                if (keys.length > 0) {
                    await this.redis.del(...keys);
                }
            } catch (error) {
                logger.error('Redis clear error:', error);
                ErrorReporter.reportError(error, {
                    context: 'PoolCache.clear'
                });
            }
        }
    }
}
