import {
    Connection,
    PublicKey,
} from '@solana/web3.js';
import {
    Liquidity,
    LiquidityPoolKeys,
    LIQUIDITY_STATE_LAYOUT_V4,
    Token
} from '@raydium-io/raydium-sdk';
import {
    PoolConfig,
    MarketState
} from '../types/trading.types';
import { logger } from '../utils/logger';
import { Cache } from '../utils/Cache';
import { ErrorReporter } from '../utils/errorReporting';
import { BN } from 'bn.js';
import { RateLimiter } from '../utils/RateLimiter';

export class PoolAnalyzer {
    private readonly poolKeysCache: Cache<string, LiquidityPoolKeys>;
    private readonly poolStateCache: Cache<string, MarketState>;
    private readonly rateLimiter: RateLimiter;

    constructor(
        private readonly connection: Connection,
        private readonly config: PoolConfig,
        private readonly cacheDuration: number = 30000 // 30 seconds
    ) {
        this.poolKeysCache = new Cache<string, LiquidityPoolKeys>(cacheDuration);
        this.poolStateCache = new Cache<string, MarketState>(cacheDuration);
        this.rateLimiter = new RateLimiter({
            maxRequests: 30,
            timeWindow: 1000 // 1 second
        });
    }

    async validatePool(lpAddress: PublicKey): Promise<boolean> {
        try {
            await this.rateLimiter.checkLimit();
            
            const poolState = await this.getPoolState(lpAddress);
            if (!poolState) return false;

            const validationResults = await Promise.all([
                this.validatePoolSize(poolState),
                this.validateLiquidity(poolState),
                this.validateBurnStatus(lpAddress),
                this.validateFreezeStatus(lpAddress),
                this.validateRenounceStatus(lpAddress)
            ]);

            return validationResults.every(result => result);
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'PoolAnalyzer.validatePool',
                lpAddress: lpAddress.toString()
            });
            return false;
        }
    }

    async getPoolKeys(lpAddress: PublicKey): Promise<LiquidityPoolKeys> {
        const cached = this.poolKeysCache.get(lpAddress.toString());
        if (cached) return cached;

        try {
            await this.rateLimiter.checkLimit();
            
            const accountInfo = await this.connection.getAccountInfo(lpAddress);
            if (!accountInfo) throw new Error('Pool account not found');

            const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);
            const poolKeys = await Liquidity.getAssociatedPoolKeys({
                version: 4,
                baseMint: poolState.baseMint,
                quoteMint: poolState.quoteMint,
                marketId: poolState.marketId
            });

            this.poolKeysCache.set(lpAddress.toString(), poolKeys);
            return poolKeys;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'PoolAnalyzer.getPoolKeys',
                lpAddress: lpAddress.toString()
            });
            throw error;
        }
    }

    async getPoolState(lpAddress: PublicKey): Promise<MarketState | null> {
        const cached = this.poolStateCache.get(lpAddress.toString());
        if (cached) return cached;

        try {
            await this.rateLimiter.checkLimit();
            
            const accountInfo = await this.connection.getAccountInfo(lpAddress);
            if (!accountInfo) return null;

            const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);
            const marketState: MarketState = {
                price: poolState.currentPrice,
                liquidity: poolState.lpReserve,
                volume24h: poolState.volume24h || new BN(0),
                lastUpdate: new Date(),
                isActive: true,
                volatility24h: poolState.priceHistory 
                    ? this.calculateVolatility(poolState.priceHistory)
                    : undefined
            };

            this.poolStateCache.set(lpAddress.toString(), marketState);
            return marketState;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'PoolAnalyzer.getPoolState',
                lpAddress: lpAddress.toString()
            });
            return null;
        }
    }

    private async validatePoolSize(state: MarketState): Promise<boolean> {
        if (this.config.minSize.gt(ZERO) && state.liquidity.lt(this.config.minSize)) {
            logger.debug('Pool size below minimum threshold');
            return false;
        }

        if (this.config.maxSize.gt(ZERO) && state.liquidity.gt(this.config.maxSize)) {
            logger.debug('Pool size above maximum threshold');
            return false;
        }

        return true;
    }

    private async validateLiquidity(state: MarketState): Promise<boolean> {
        if (!state.liquidity.gt(ZERO)) {
            logger.debug('Pool has no liquidity');
            return false;
        }

        if (state.liquidity.lt(this.config.liquidityThreshold)) {
            logger.debug('Pool liquidity below threshold');
            return false;
        }

        return true;
    }

    private async validateBurnStatus(lpAddress: PublicKey): Promise<boolean> {
        if (!this.config.checkBurn) return true;

        try {
            await this.rateLimiter.checkLimit();
            
            const burnAccount = await this.connection.getAccountInfo(
                await this.getBurnAddress(lpAddress)
            );
            return burnAccount !== null;
        } catch (error) {
            logger.error('Error checking burn status:', error);
            return false;
        }
    }

    private async validateFreezeStatus(lpAddress: PublicKey): Promise<boolean> {
        if (!this.config.checkFreeze) return true;

        try {
            await this.rateLimiter.checkLimit();
            
            const poolKeys = await this.getPoolKeys(lpAddress);
            const freezeAuthority = await Token.getFreezeAuthorityInfo(
                this.connection,
                poolKeys.baseMint
            );
            return freezeAuthority === null;
        } catch (error) {
            logger.error('Error checking freeze status:', error);
            return false;
        }
    }

    private async validateRenounceStatus(lpAddress: PublicKey): Promise<boolean> {
        if (!this.config.checkRenounced) return true;

        try {
            await this.rateLimiter.checkLimit();
            
            const poolKeys = await this.getPoolKeys(lpAddress);
            const mintAuthority = await Token.getMintAuthorityInfo(
                this.connection,
                poolKeys.baseMint
            );
            return mintAuthority === null;
        } catch (error) {
            logger.error('Error checking renounce status:', error);
            return false;
        }
    }

    private calculateVolatility(priceHistory: BN[]): Percent {
        if (priceHistory.length < 2) return new Percent(ZERO, BN_HUNDRED);

        const returns = [];
        for (let i = 1; i < priceHistory.length; i++) {
            const previousPrice = priceHistory[i - 1];
            const currentPrice = priceHistory[i];
            const return_ = currentPrice.sub(previousPrice)
                .mul(BN_HUNDRED)
                .div(previousPrice);
            returns.push(return_);
        }

        const mean = returns.reduce((a, b) => a.add(b), ZERO)
            .div(new BN(returns.length));
        
        const variance = returns.reduce(
            (acc, val) => acc.add(val.sub(mean).pow(new BN(2))),
            ZERO
        ).div(new BN(returns.length));

        return new Percent(variance.sqrt(), BN_HUNDRED);
    }

    private async getBurnAddress(lpAddress: PublicKey): Promise<PublicKey> {
        const [burnAddress] = await PublicKey.findProgramAddress(
            [Buffer.from('burn'), lpAddress.toBuffer()],
            LIQUIDITY_PROGRAM_ID
        );
        return burnAddress;
    }

    public clearCache(): void {
        this.poolKeysCache.clear();
        this.poolStateCache.clear();
    }
}

const ZERO = new BN(0);
const BN_HUNDRED = new BN(100);
const LIQUIDITY_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
