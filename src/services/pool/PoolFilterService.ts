import { PublicKey } from '@solana/web3.js';
import { 
    LiquidityPoolKeys,
    LiquidityStateV4,
    TokenAmount,
    Percent
} from '@raydium-io/raydium-sdk';
import { 
    PoolValidationConfig,
    PoolSecurityCheck,
    MarketState 
} from '../../types/trading.types';
import { TokenPairService } from '../token/TokenPairService';
import { MarketDataService } from '../market/MarketDataService';
import { PoolCache } from '../cache/PoolCache';
import { MarketCache } from '../cache/MarketCache';
import { ConfigService } from '../config/ConfigService';
import { logger } from '../../utils/logger';
import { ErrorReporter } from '../../utils/errorReporting';
import { PerformanceMonitor } from '../../utils/performance';
import { Redis } from 'ioredis';
import BN from 'bn.js';

interface PoolMetrics {
    liquidity: BN;
    volume24h: BN;
    priceImpact: number;
    holders: number;
    txCount24h: number;
    volatility24h: Percent;
}

export class PoolFilterService {
    private readonly redis?: Redis;
    private readonly performanceMonitor: PerformanceMonitor;
    private readonly blacklistedPools: Set<string>;
    private readonly whitelistedPools: Set<string>;
    private readonly poolMetricsCache: Map<string, PoolMetrics>;

    private readonly CACHE_TTL = 3600; // 1 hour
    private readonly METRICS_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes

    constructor(
        private readonly tokenPairService: TokenPairService,
        private readonly marketDataService: MarketDataService,
        private readonly poolCache: PoolCache,
        private readonly marketCache: MarketCache,
        private readonly config: ConfigService
    ) {
        this.performanceMonitor = new PerformanceMonitor();
        this.blacklistedPools = new Set(config.get('BLACKLISTED_POOLS')?.split(',') || []);
        this.whitelistedPools = new Set(config.get('WHITELISTED_POOLS')?.split(',') || []);
        this.poolMetricsCache = new Map();

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
                    context: 'PoolFilterService.redis',
                    service: 'Redis'
                });
            });
        }

        this.startMetricsUpdateInterval();
    }

    async validatePool(
        lpAddress: PublicKey,
        poolKeys: LiquidityPoolKeys,
        customConfig?: Partial<PoolValidationConfig>
    ): Promise<boolean> {
        const timer = this.performanceMonitor.startTimer('validatePool');

        try {
            const addressStr = lpAddress.toString();

            // Check blacklist/whitelist
            if (this.blacklistedPools.has(addressStr)) {
                logger.debug(`Pool ${addressStr} is blacklisted`);
                return false;
            }

            if (this.whitelistedPools.has(addressStr)) {
                return true;
            }

            // Get pool and market states
            const [poolState, marketState] = await Promise.all([
                this.poolCache.get(addressStr),
                this.marketCache.get(lpAddress)
            ]);

            if (!poolState?.state || !marketState?.state) {
                logger.debug(`Missing state data for pool ${addressStr}`);
                return false;
            }

            // Get or calculate pool metrics
            const metrics = await this.getPoolMetrics(
                lpAddress,
                poolState.state,
                marketState.state
            );

            // Validate against configuration
            const config: PoolValidationConfig = {
                ...this.getDefaultConfig(),
                ...customConfig
            };

            return this.validateMetrics(metrics, config);

        } catch (error) {
            logger.error('Pool validation error:', error);
            ErrorReporter.reportError(error, {
                context: 'PoolFilterService.validatePool',
                lpAddress: lpAddress.toString()
            });
            return false;
        } finally {
            this.performanceMonitor.endTimer('validatePool', timer);
        }
    }

    async getPoolMetrics(
        lpAddress: PublicKey,
        poolState: LiquidityStateV4,
        marketState: MarketState
    ): Promise<PoolMetrics> {
        const addressStr = lpAddress.toString();
        const cachedMetrics = this.poolMetricsCache.get(addressStr);
        
        if (cachedMetrics) {
            return cachedMetrics;
        }

        const metrics = await this.calculatePoolMetrics(
            lpAddress,
            poolState,
            marketState
        );

        this.poolMetricsCache.set(addressStr, metrics);
        await this.cachePoolMetrics(addressStr, metrics);

        return metrics;
    }

    private async calculatePoolMetrics(
        lpAddress: PublicKey,
        poolState: LiquidityStateV4,
        marketState: MarketState
    ): Promise<PoolMetrics> {
        const [holders, txCount24h] = await Promise.all([
            this.tokenPairService.getTokenHolders(poolState.baseMint),
            this.getTransactionCount24h(lpAddress)
        ]);

        const liquidity = new BN(poolState.quoteReserve)
            .mul(marketState.price)
            .div(new BN(10 ** 9));

        const priceImpact = this.calculatePriceImpact(
            poolState,
            marketState
        );

        return {
            liquidity,
            volume24h: marketState.volume24h,
            priceImpact,
            holders,
            txCount24h,
            volatility24h: marketState.volatility24h || new Percent(new BN(0), new BN(100))
        };
    }

    private calculatePriceImpact(
        poolState: LiquidityStateV4,
        marketState: MarketState
    ): number {
        const spotPrice = marketState.price;
        const poolPrice = new BN(poolState.baseReserve)
            .mul(new BN(1e9))
            .div(new BN(poolState.quoteReserve));

        return Math.abs(
            (spotPrice.sub(poolPrice).toNumber() / spotPrice.toNumber()) * 100
        );
    }

    private async getTransactionCount24h(lpAddress: PublicKey): Promise<number> {
        if (!this.redis) return 0;

        try {
            const count = await this.redis.get(`pool:${lpAddress.toString()}:tx_count`);
            return count ? parseInt(count) : 0;
        } catch (error) {
            logger.error('Error getting transaction count:', error);
            return 0;
        }
    }

    private async cachePoolMetrics(
        address: string,
        metrics: PoolMetrics
    ): Promise<void> {
        if (!this.redis) return;

        try {
            await this.redis.setex(
                `pool:${address}:metrics`,
                this.CACHE_TTL,
                JSON.stringify(metrics)
            );
        } catch (error) {
            logger.error('Error caching pool metrics:', error);
        }
    }

    private validateMetrics(
        metrics: PoolMetrics,
        config: PoolValidationConfig
    ): boolean {
        return (
            metrics.liquidity.gte(config.minLiquidity) &&
            metrics.liquidity.lte(config.maxLiquidity) &&
            metrics.volume24h.gte(config.minVolume24h) &&
            metrics.priceImpact <= config.maxPriceImpact &&
            metrics.holders >= config.minHolders
        );
    }

    private getDefaultConfig(): PoolValidationConfig {
        return {
            minLiquidity: new BN(this.config.get('MIN_POOL_LIQUIDITY') || '1000000000'),
            maxLiquidity: new BN(this.config.get('MAX_POOL_LIQUIDITY') || '1000000000000000'),
            minVolume24h: new BN(this.config.get('MIN_POOL_VOLUME_24H') || '100000000'),
            maxPriceImpact: Number(this.config.get('MAX_PRICE_IMPACT') || '5'),
            minHolders: Number(this.config.get('MIN_TOKEN_HOLDERS') || '100'),
            checkMutable: this.config.get('CHECK_IF_MUTABLE') === 'true',
            checkSocials: this.config.get('CHECK_IF_SOCIALS') === 'true',
            checkRenounced: this.config.get('CHECK_IF_MINT_IS_RENOUNCED') === 'true',
            checkFreezable: this.config.get('CHECK_IF_FREEZABLE') === 'true',
            checkBurned: this.config.get('CHECK_IF_BURNED') === 'true'
        };
    }

    private startMetricsUpdateInterval(): void {
        setInterval(async () => {
            try {
                const pools = await this.poolCache.getAllPools();
                
                for (const [address, pool] of pools) {
                    const marketState = await this.marketCache.get(new PublicKey(address));
                    if (!marketState) continue;

                    const metrics = await this.calculatePoolMetrics(
                        new PublicKey(address),
                        pool.state,
                        marketState.state
                    );

                    this.poolMetricsCache.set(address, metrics);
                    await this.cachePoolMetrics(address, metrics);
                }
            } catch (error) {
                logger.error('Error updating pool metrics:', error);
                ErrorReporter.reportError(error, {
                    context: 'PoolFilterService.updateMetrics'
                });
            }
        }, this.METRICS_UPDATE_INTERVAL);
    }

    async addToBlacklist(lpAddress: string): Promise<void> {
        this.blacklistedPools.add(lpAddress);
        await this.updateBlacklistConfig();
    }

    async removeFromBlacklist(lpAddress: string): Promise<void> {
        this.blacklistedPools.delete(lpAddress);
        await this.updateBlacklistConfig();
    }

    async addToWhitelist(lpAddress: string): Promise<void> {
        this.whitelistedPools.add(lpAddress);
        await this.updateWhitelistConfig();
    }

    async removeFromWhitelist(lpAddress: string): Promise<void> {
        this.whitelistedPools.delete(lpAddress);
        await this.updateWhitelistConfig();
    }

    private async updateBlacklistConfig(): Promise<void> {
        await this.config.set(
            'BLACKLISTED_POOLS',
            Array.from(this.blacklistedPools).join(',')
        );
    }

    private async updateWhitelistConfig(): Promise<void> {
        await this.config.set(
            'WHITELISTED_POOLS',
            Array.from(this.whitelistedPools).join(',')
        );
    }
}
