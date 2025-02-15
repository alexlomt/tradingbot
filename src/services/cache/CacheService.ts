import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/RedisService';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import LRUCache from 'lru-cache';

interface CacheConfig {
    ttl: number;
    maxSize: number;
    updateAgeOnGet: boolean;
}

@Injectable()
export class CacheService implements OnModuleInit {
    private localCache: LRUCache<string, any>;
    private readonly namespace: string = 'tradingbot';
    private readonly defaultTTL: number = 300; // 5 minutes
    private readonly cacheConfigs: Map<string, CacheConfig>;

    constructor(
        private readonly redisService: RedisService,
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService
    ) {
        this.cacheConfigs = new Map([
            ['user', { ttl: 300, maxSize: 1000, updateAgeOnGet: true }],
            ['role', { ttl: 600, maxSize: 100, updateAgeOnGet: true }],
            ['trading', { ttl: 60, maxSize: 10000, updateAgeOnGet: true }],
            ['market', { ttl: 30, maxSize: 5000, updateAgeOnGet: true }],
            ['analytics', { ttl: 900, maxSize: 500, updateAgeOnGet: false }]
        ]);
    }

    async onModuleInit() {
        this.initializeLocalCache();
        await this.validateRedisConnection();
        this.startCacheMonitoring();
    }

    private initializeLocalCache() {
        this.localCache = new LRUCache({
            max: this.configService.get<number>('CACHE_LOCAL_MAX_SIZE', 5000),
            ttl: this.configService.get<number>('CACHE_LOCAL_TTL', 60) * 1000, // Convert to milliseconds
            updateAgeOnGet: true,
            allowStale: false,
            fetchMethod: async (key: string) => {
                return await this.fetchFromRedis(key);
            }
        });
    }

    private async validateRedisConnection() {
        try {
            await this.redisService.ping();
        } catch (error) {
            await this.auditService.logSystemEvent({
                event: 'CACHE_REDIS_CONNECTION_ERROR',
                details: { error: error.message },
                severity: 'ERROR'
            });
            throw error;
        }
    }

    private startCacheMonitoring() {
        setInterval(async () => {
            const metrics = {
                localCacheSize: this.localCache.size,
                localCacheItemCount: this.localCache.itemCount,
                localCacheHitRate: this.metricsService.getCacheHitRate('local'),
                redisCacheHitRate: this.metricsService.getCacheHitRate('redis')
            };

            await this.metricsService.recordCacheMetrics(metrics);
        }, 60000); // Every minute
    }

    async get<T>(key: string, type?: string): Promise<T | null> {
        const cacheKey = this.getCacheKey(key, type);
        const start = Date.now();

        try {
            // Try local cache first
            const localValue = this.localCache.get(cacheKey);
            if (localValue !== undefined) {
                this.metricsService.recordCacheHit('local');
                this.metricsService.recordCacheLatency('local', Date.now() - start);
                return localValue as T;
            }

            // Try Redis if not in local cache
            const redisValue = await this.fetchFromRedis(cacheKey);
            if (redisValue !== null) {
                this.metricsService.recordCacheHit('redis');
                this.localCache.set(cacheKey, redisValue); // Update local cache
                this.metricsService.recordCacheLatency('redis', Date.now() - start);
                return redisValue as T;
            }

            this.metricsService.recordCacheMiss();
            return null;
        } catch (error) {
            await this.handleCacheError('get', error, cacheKey);
            return null;
        }
    }

    async set(key: string, value: any, type?: string, ttl?: number): Promise<void> {
        const cacheKey = this.getCacheKey(key, type);
        const config = this.getCacheConfig(type);
        const effectiveTTL = ttl || config.ttl;

        try {
            // Set in both local and Redis cache
            await Promise.all([
                this.localCache.set(cacheKey, value),
                this.redisService.setex(cacheKey, effectiveTTL, JSON.stringify(value))
            ]);

            await this.metricsService.recordCacheOperation('set');
        } catch (error) {
            await this.handleCacheError('set', error, cacheKey);
        }
    }

    async del(key: string, type?: string): Promise<void> {
        const cacheKey = this.getCacheKey(key, type);

        try {
            // Delete from both local and Redis cache
            await Promise.all([
                this.localCache.delete(cacheKey),
                this.redisService.del(cacheKey)
            ]);

            await this.metricsService.recordCacheOperation('del');
        } catch (error) {
            await this.handleCacheError('del', error, cacheKey);
        }
    }

    async flush(type?: string): Promise<void> {
        try {
            if (type) {
                const pattern = this.getCacheKey('*', type);
                const keys = await this.redisService.keys(pattern);
                
                await Promise.all([
                    // Clear matching keys from local cache
                    this.localCache.clear(),
                    // Clear matching keys from Redis
                    ...keys.map(key => this.redisService.del(key))
                ]);
            } else {
                // Clear all caches
                await Promise.all([
                    this.localCache.clear(),
                    this.redisService.flushdb()
                ]);
            }

            await this.metricsService.recordCacheOperation('flush');
        } catch (error) {
            await this.handleCacheError('flush', error);
        }
    }

    private getCacheKey(key: string, type?: string): string {
        return `${this.namespace}:${type || 'default'}:${key}`;
    }

    private getCacheConfig(type?: string): CacheConfig {
        return this.cacheConfigs.get(type) || {
            ttl: this.defaultTTL,
            maxSize: 1000,
            updateAgeOnGet: true
        };
    }

    private async fetchFromRedis(key: string): Promise<any> {
        const value = await this.redisService.get(key);
        return value ? JSON.parse(value) : null;
    }

    private async handleCacheError(
        operation: string,
        error: any,
        key?: string
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'CACHE_ERROR',
            details: {
                operation,
                key,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementCacheError();
        throw error;
    }

    // Cache warming methods
    async warmCache(type: string, data: Record<string, any>): Promise<void> {
        const config = this.getCacheConfig(type);
        
        try {
            await Promise.all(
                Object.entries(data).map(([key, value]) =>
                    this.set(key, value, type, config.ttl)
                )
            );

            await this.auditService.logSystemEvent({
                event: 'CACHE_WARMED',
                details: { type, count: Object.keys(data).length },
                severity: 'INFO'
            });
        } catch (error) {
            await this.handleCacheError('warm', error);
        }
    }
}
