import { Connection, PublicKey } from '@solana/web3.js';
import { 
    Liquidity, 
    LiquidityPoolKeys, 
    LiquidityStateV4,
    MAINNET_PROGRAM_ID,
    Market,
    TokenAmount,
    Token
} from '@raydium-io/raydium-sdk';
import { 
    PoolAnalysisResult,
    PoolSecurityCheck,
    PoolValidationConfig,
    MarketState
} from '../../types/trading.types';
import { TokenPairService } from '../token/TokenPairService';
import { MarketDataService } from '../market/MarketDataService';
import { PoolCache } from '../cache/PoolCache';
import { MarketCache } from '../cache/MarketCache';
import { logger } from '../../utils/logger';
import { ErrorReporter } from '../../utils/errorReporting';
import { PerformanceMonitor } from '../../utils/performance';
import { ConfigService } from '../config/ConfigService';
import BN from 'bn.js';

export class PoolAnalyzer {
    private readonly performanceMonitor: PerformanceMonitor;
    private readonly validationConfig: PoolValidationConfig;

    constructor(
        private readonly connection: Connection,
        private readonly tokenPairService: TokenPairService,
        private readonly marketDataService: MarketDataService,
        private readonly poolCache: PoolCache,
        private readonly marketCache: MarketCache,
        private readonly config: ConfigService
    ) {
        this.performanceMonitor = new PerformanceMonitor();
        this.validationConfig = {
            minLiquidity: new BN(config.get('MIN_POOL_LIQUIDITY') || '1000000000'),
            maxLiquidity: new BN(config.get('MAX_POOL_LIQUIDITY') || '1000000000000000'),
            minVolume24h: new BN(config.get('MIN_POOL_VOLUME_24H') || '100000000'),
            maxPriceImpact: Number(config.get('MAX_PRICE_IMPACT') || '5'),
            minHolders: Number(config.get('MIN_TOKEN_HOLDERS') || '100'),
            checkMutable: config.get('CHECK_IF_MUTABLE') === 'true',
            checkSocials: config.get('CHECK_IF_SOCIALS') === 'true',
            checkRenounced: config.get('CHECK_IF_MINT_IS_RENOUNCED') === 'true',
            checkFreezable: config.get('CHECK_IF_FREEZABLE') === 'true',
            checkBurned: config.get('CHECK_IF_BURNED') === 'true'
        };
    }

    async analyzePool(
        lpAddress: PublicKey,
        customConfig?: Partial<PoolValidationConfig>
    ): Promise<PoolAnalysisResult> {
        const timer = this.performanceMonitor.startTimer('analyzePool');
        
        try {
            const config = { ...this.validationConfig, ...customConfig };
            
            // Get pool state and market data
            const [poolState, marketState] = await Promise.all([
                this.getPoolState(lpAddress),
                this.getMarketState(lpAddress)
            ]);

            if (!poolState || !marketState) {
                return {
                    isValid: false,
                    reason: 'Pool or market state not available',
                    poolState: null,
                    marketState: null,
                    securityChecks: null
                };
            }

            // Perform security checks
            const securityChecks = await this.performSecurityChecks(
                poolState,
                marketState,
                config
            );

            // Validate pool metrics
            const metricsValid = this.validatePoolMetrics(
                poolState,
                marketState,
                config
            );

            if (!metricsValid.isValid) {
                return {
                    isValid: false,
                    reason: metricsValid.reason,
                    poolState,
                    marketState,
                    securityChecks
                };
            }

            if (!securityChecks.allPassed) {
                return {
                    isValid: false,
                    reason: 'Security checks failed',
                    poolState,
                    marketState,
                    securityChecks
                };
            }

            return {
                isValid: true,
                poolState,
                marketState,
                securityChecks
            };

        } catch (error) {
            logger.error('Pool analysis error:', error);
            ErrorReporter.reportError(error, {
                context: 'PoolAnalyzer.analyzePool',
                lpAddress: lpAddress.toString()
            });
            return {
                isValid: false,
                reason: 'Analysis error',
                poolState: null,
                marketState: null,
                securityChecks: null
            };
        } finally {
            this.performanceMonitor.endTimer('analyzePool', timer);
        }
    }

    async getPoolState(lpAddress: PublicKey): Promise<LiquidityStateV4 | null> {
        try {
            // Check cache first
            const cached = await this.poolCache.get(lpAddress.toString());
            if (cached) {
                return cached.state;
            }

            // Fetch from chain
            const accountInfo = await this.connection.getAccountInfo(lpAddress);
            if (!accountInfo) return null;

            const state = Liquidity.getStateLayout(4).decode(accountInfo.data);
            
            // Cache the result
            await this.poolCache.add(lpAddress.toString(), state);
            
            return state;
        } catch (error) {
            logger.error('Error fetching pool state:', error);
            ErrorReporter.reportError(error, {
                context: 'PoolAnalyzer.getPoolState',
                lpAddress: lpAddress.toString()
            });
            return null;
        }
    }

    async getPoolKeys(lpAddress: PublicKey): Promise<LiquidityPoolKeys | null> {
        try {
            const poolState = await this.getPoolState(lpAddress);
            if (!poolState) return null;

            const marketState = await this.getMarketState(lpAddress);
            if (!marketState) return null;

            return {
                id: lpAddress,
                baseMint: poolState.baseMint,
                quoteMint: poolState.quoteMint,
                lpMint: poolState.lpMint,
                baseDecimals: poolState.baseDecimal.toNumber(),
                quoteDecimals: poolState.quoteDecimal.toNumber(),
                lpDecimals: 5,
                version: 4,
                programId: MAINNET_PROGRAM_ID.AmmV4,
                authority: Liquidity.getAssociatedAuthority({
                    programId: MAINNET_PROGRAM_ID.AmmV4,
                }).publicKey,
                openOrders: poolState.openOrders,
                targetOrders: poolState.targetOrders,
                baseVault: poolState.baseVault,
                quoteVault: poolState.quoteVault,
                marketVersion: 3,
                marketProgramId: poolState.marketProgramId,
                marketId: poolState.marketId,
                marketAuthority: Market.getAssociatedAuthority({
                    programId: poolState.marketProgramId,
                    marketId: poolState.marketId,
                }).publicKey,
                marketBaseVault: poolState.baseVault,
                marketQuoteVault: poolState.quoteVault,
                marketBids: marketState.bids,
                marketAsks: marketState.asks,
                marketEventQueue: marketState.eventQueue,
                withdrawQueue: poolState.withdrawQueue,
                lpVault: poolState.lpVault,
                lookupTableAccount: PublicKey.default
            };
        } catch (error) {
            logger.error('Error creating pool keys:', error);
            ErrorReporter.reportError(error, {
                context: 'PoolAnalyzer.getPoolKeys',
                lpAddress: lpAddress.toString()
            });
            return null;
        }
    }

    private async getMarketState(lpAddress: PublicKey): Promise<MarketState | null> {
        try {
            // Check cache first
            const cached = await this.marketCache.get(lpAddress);
            if (cached) {
                return cached.state;
            }

            // Fetch from service
            return await this.marketDataService.getMarketState(lpAddress);
        } catch (error) {
            logger.error('Error fetching market state:', error);
            ErrorReporter.reportError(error, {
                context: 'PoolAnalyzer.getMarketState',
                lpAddress: lpAddress.toString()
            });
            return null;
        }
    }

    private async performSecurityChecks(
        poolState: LiquidityStateV4,
        marketState: MarketState,
        config: PoolValidationConfig
    ): Promise<PoolSecurityCheck> {
        const checks: PoolSecurityCheck = {
            isMutable: true,
            hasSocials: false,
            isRenounced: false,
            isFreezable: true,
            isBurned: false,
            allPassed: false
        };

        try {
            const baseToken = await this.tokenPairService.getTokenByMint(poolState.baseMint);
            
            if (config.checkMutable) {
                checks.isMutable = await this.checkTokenMutability(baseToken);
            }

            if (config.checkSocials) {
                checks.hasSocials = await this.checkTokenSocials(baseToken);
            }

            if (config.checkRenounced) {
                checks.isRenounced = await this.checkMintAuthority(baseToken);
            }

            if (config.checkFreezable) {
                checks.isFreezable = await this.checkFreezeAuthority(baseToken);
            }

            if (config.checkBurned) {
                checks.isBurned = await this.checkTokenBurn(baseToken);
            }

            checks.allPassed = this.validateSecurityChecks(checks, config);

        } catch (error) {
            logger.error('Security check error:', error);
            ErrorReporter.reportError(error, {
                context: 'PoolAnalyzer.performSecurityChecks',
                poolState: poolState.baseMint.toString()
            });
        }

        return checks;
    }

    private validatePoolMetrics(
        poolState: LiquidityStateV4,
        marketState: MarketState,
        config: PoolValidationConfig
    ): { isValid: boolean; reason?: string } {
        const liquidity = new BN(poolState.quoteReserve);
        
        if (liquidity.lt(config.minLiquidity)) {
            return { isValid: false, reason: 'Insufficient liquidity' };
        }

        if (liquidity.gt(config.maxLiquidity)) {
            return { isValid: false, reason: 'Exceeds maximum liquidity' };
        }

        if (marketState.volume24h.lt(config.minVolume24h)) {
            return { isValid: false, reason: 'Insufficient 24h volume' };
        }

        const priceImpact = this.calculatePriceImpact(poolState, marketState);
        if (priceImpact > config.maxPriceImpact) {
            return { isValid: false, reason: 'Price impact too high' };
        }

        return { isValid: true };
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

    private validateSecurityChecks(
        checks: PoolSecurityCheck,
        config: PoolValidationConfig
    ): boolean {
        return (
            (!config.checkMutable || !checks.isMutable) &&
            (!config.checkSocials || checks.hasSocials) &&
            (!config.checkRenounced || checks.isRenounced) &&
            (!config.checkFreezable || !checks.isFreezable) &&
            (!config.checkBurned || checks.isBurned)
        );
    }

    private async checkTokenMutability(token: Token): Promise<boolean> {
        try {
            const mintInfo = await this.connection.getAccountInfo(token.mint);
            return mintInfo?.data[0] === 1; // Check if authority can modify
        } catch (error) {
            logger.error('Error checking token mutability:', error);
            return true; // Assume mutable on error
        }
    }

    private async checkTokenSocials(token: Token): Promise<boolean> {
        // Implementation would depend on your token metadata standard
        return true; // Placeholder - implement based on your requirements
    }

    private async checkMintAuthority(token: Token): Promise<boolean> {
        try {
            const mintInfo = await this.connection.getAccountInfo(token.mint);
            // Check if mint authority is null or burned
            return !mintInfo || mintInfo.data.length < 82;
        } catch (error) {
            logger.error('Error checking mint authority:', error);
            return false;
        }
    }

    private async checkFreezeAuthority(token: Token): Promise<boolean> {
        try {
            const mintInfo = await this.connection.getAccountInfo(token.mint);
            // Check if freeze authority exists
            return mintInfo?.data.slice(82, 114).some(byte => byte !== 0) || false;
        } catch (error) {
            logger.error('Error checking freeze authority:', error);
            return true;
        }
    }

    private async checkTokenBurn(token: Token): Promise<boolean> {
        try {
            const supply = await this.tokenPairService.getTokenSupply(token);
            const initialSupply = await this.tokenPairService.getInitialSupply(token);
            return supply.lessThan(initialSupply);
        } catch (error) {
            logger.error('Error checking token burn:', error);
            return false;
        }
    }
}
