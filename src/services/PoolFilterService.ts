import {
    Connection,
    PublicKey,
} from '@solana/web3.js';
import {
    Token,
    TokenAmount,
    Currency,
    LiquidityStateV4,
    LIQUIDITY_STATE_LAYOUT_V4
} from '@raydium-io/raydium-sdk';
import { BN } from 'bn.js';
import { Cache } from '../utils/Cache';
import { logger } from '../utils/logger';
import { RateLimiter } from '../utils/RateLimiter';
import { PoolConfig } from '../types/trading.types';
import { ErrorReporter } from '../utils/errorReporting';

export class PoolFilterService {
    private readonly filterCache: Cache<string, {
        matches: number;
        lastCheck: Date;
        verified: boolean;
    }>;
    private readonly rateLimiter: RateLimiter;

    constructor(
        private readonly connection: Connection,
        private readonly config: PoolConfig,
        private readonly cacheDuration: number = 300000 // 5 minutes
    ) {
        this.filterCache = new Cache<string, any>(cacheDuration);
        this.rateLimiter = new RateLimiter({
            maxRequests: 30,
            timeWindow: 1000
        });
    }

    async validatePool(
        poolAddress: PublicKey,
        poolState: LiquidityStateV4
    ): Promise<boolean> {
        try {
            const cached = this.filterCache.get(poolAddress.toString());
            if (cached?.verified) return true;

            await this.rateLimiter.checkLimit();

            const checks = await Promise.all([
                this.validatePoolSize(poolState),
                this.validateLiquidity(poolState),
                this.validateTokenMetadata(poolState),
                this.validatePoolHistory(poolAddress),
                this.checkConsecutiveMatches(poolAddress)
            ]);

            const isValid = checks.every(check => check);

            if (isValid) {
                this.updateFilterCache(poolAddress, true);
            }

            return isValid;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'PoolFilterService.validatePool',
                poolAddress: poolAddress.toString()
            });
            return false;
        }
    }

    private async validatePoolSize(poolState: LiquidityStateV4): Promise<boolean> {
        const poolSize = new TokenAmount(
            new Token(poolState.baseMint, poolState.baseDecimals),
            poolState.baseReserve
        );

        if (this.config.minSize.gt(poolSize.raw)) {
            logger.debug('Pool size below minimum threshold');
            return false;
        }

        if (this.config.maxSize.gt(new BN(0)) && poolSize.raw.gt(this.config.maxSize)) {
            logger.debug('Pool size above maximum threshold');
            return false;
        }

        return true;
    }

    private async validateLiquidity(poolState: LiquidityStateV4): Promise<boolean> {
        if (poolState.lpReserve.eq(new BN(0))) {
            logger.debug('Pool has no liquidity');
            return false;
        }

        if (poolState.lpReserve.lt(this.config.liquidityThreshold)) {
            logger.debug('Pool liquidity below threshold');
            return false;
        }

        return true;
    }

    private async validateTokenMetadata(poolState: LiquidityStateV4): Promise<boolean> {
        try {
            await this.rateLimiter.checkLimit();

            const [baseInfo, quoteInfo] = await Promise.all([
                this.connection.getAccountInfo(poolState.baseMint),
                this.connection.getAccountInfo(poolState.quoteMint)
            ]);

            if (!baseInfo || !quoteInfo) {
                logger.debug('Token metadata not found');
                return false;
            }

            return true;
        } catch (error) {
            logger.error('Error validating token metadata:', error);
            return false;
        }
    }

    private async validatePoolHistory(poolAddress: PublicKey): Promise<boolean> {
        try {
            await this.rateLimiter.checkLimit();

            const signatures = await this.connection.getSignaturesForAddress(
                poolAddress,
                { limit: 10 }
            );

            if (signatures.length < 2) {
                logger.debug('Insufficient pool history');
                return false;
            }

            return true;
        } catch (error) {
            logger.error('Error validating pool history:', error);
            return false;
        }
    }

    private async checkConsecutiveMatches(poolAddress: PublicKey): Promise<boolean> {
        const cached = this.filterCache.get(poolAddress.toString());
        const now = new Date();

        if (cached) {
            if (now.getTime() - cached.lastCheck.getTime() > this.config.filterCheckDuration) {
                cached.matches = 1;
            } else {
                cached.matches++;
            }
            cached.lastCheck = now;
        } else {
            this.filterCache.set(poolAddress.toString(), {
                matches: 1,
                lastCheck: now,
                verified: false
            });
        }

        return (cached?.matches || 1) >= this.config.consecutiveMatches;
    }

    private updateFilterCache(poolAddress: PublicKey, verified: boolean): void {
        const cached = this.filterCache.get(poolAddress.toString());
        if (cached) {
            cached.verified = verified;
            this.filterCache.set(poolAddress.toString(), cached);
        }
    }

    public clearCache(): void {
        this.filterCache.clear();
    }
}
