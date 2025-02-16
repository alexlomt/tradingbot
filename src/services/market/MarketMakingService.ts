import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { 
    Liquidity, 
    Token as RaydiumToken, 
    TokenAmount, 
    MAINNET_PROGRAM_ID,
    LiquidityPoolKeys
} from '@raydium-io/raydium-sdk';
import { OrderManagementService } from '../order/OrderManagementService';
import { PositionTrackingService } from '../position/PositionTrackingService';
import { RiskManagementService } from '../risk/RiskManagementService';
import { MarketDataCache } from './MarketDataCache';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { WalletService } from '../wallet/WalletService';
import { OrderSide, OrderType } from '../../types/order.types';
import { Decimal } from 'decimal.js';
import { BehaviorSubject, Observable } from 'rxjs';

interface MarketMakingConfig {
    enabled: boolean;
    market: string;
    baseSize: Decimal;
    quoteSize: Decimal;
    spreadPercentage: Decimal;
    priceOffset: Decimal;
    updateInterval: number;
    maxOrders: number;
    minProfitSpread: Decimal;
    maxExposure: Decimal;
    useAutoHedging: boolean;
}

@Injectable()
export class MarketMakingService implements OnModuleInit {
    private connection: Connection;
    private configs: Map<string, MarketMakingConfig> = new Map();
    private pools: Map<string, Liquidity> = new Map();
    private poolKeys: Map<string, LiquidityPoolKeys> = new Map();
    private readonly UPDATE_INTERVAL = 1000; // 1 second
    private readonly MAX_RETRIES = 3;
    private readonly marketUpdates = new BehaviorSubject<Map<string, any>>(new Map());

    constructor(
        private readonly configService: ConfigService,
        private readonly orderManagement: OrderManagementService,
        private readonly positionTracking: PositionTrackingService,
        private readonly riskManagement: RiskManagementService,
        private readonly marketDataCache: MarketDataCache,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService,
        private readonly walletService: WalletService
    ) {
        this.connection = new Connection(
            this.configService.get<string>('SOLANA_RPC_URL'),
            'confirmed'
        );
    }

    async onModuleInit() {
        await this.loadConfigurations();
        await this.initializePools();
        this.startMarketMaking();
    }

    private async loadConfigurations() {
        const marketConfigs = this.configService.get<MarketMakingConfig[]>('MARKET_MAKING');
        
        for (const config of marketConfigs) {
            if (config.enabled) {
                this.configs.set(config.market, {
                    ...config,
                    spreadPercentage: new Decimal(config.spreadPercentage),
                    priceOffset: new Decimal(config.priceOffset),
                    baseSize: new Decimal(config.baseSize),
                    quoteSize: new Decimal(config.quoteSize),
                    minProfitSpread: new Decimal(config.minProfitSpread),
                    maxExposure: new Decimal(config.maxExposure)
                });
            }
        }
    }

    private async initializePools() {
        for (const [market, config] of this.configs) {
            try {
                const poolData = await this.marketDataCache.getPoolData(market);
                const poolKeys = this.createPoolKeys(poolData);
                
                const pool = await Liquidity.load(
                    this.connection,
                    poolKeys.id,
                    poolKeys.version
                );

                this.pools.set(market, pool);
                this.poolKeys.set(market, poolKeys);

                await this.auditService.logSystemEvent({
                    event: 'POOL_INITIALIZED',
                    details: {
                        market,
                        poolId: poolKeys.id.toString()
                    },
                    severity: 'INFO'
                });
            } catch (error) {
                await this.handleError('initializePools', error, { market });
            }
        }
    }

    private createPoolKeys(poolData: any): LiquidityPoolKeys {
        return {
            id: new PublicKey(poolData.id),
            baseMint: new PublicKey(poolData.baseMint),
            quoteMint: new PublicKey(poolData.quoteMint),
            lpMint: new PublicKey(poolData.lpMint),
            version: 4,
            programId: MAINNET_PROGRAM_ID.AmmV4,
            authority: poolData.authority,
            openOrders: new PublicKey(poolData.openOrders),
            targetOrders: new PublicKey(poolData.targetOrders),
            baseVault: new PublicKey(poolData.baseVault),
            quoteVault: new PublicKey(poolData.quoteVault),
            withdrawQueue: new PublicKey(poolData.withdrawQueue),
            lpVault: new PublicKey(poolData.lpVault),
            marketId: new PublicKey(poolData.marketId),
            marketBaseVault: new PublicKey(poolData.marketBaseVault),
            marketQuoteVault: new PublicKey(poolData.marketQuoteVault),
            marketBids: new PublicKey(poolData.marketBids),
            marketAsks: new PublicKey(poolData.marketAsks)
        };
    }

    private startMarketMaking() {
        setInterval(async () => {
            for (const [market, config] of this.configs) {
                try {
                    if (await this.shouldUpdateOrders(market)) {
                        await this.updateMarketMakingOrders(market);
                    }
                } catch (error) {
                    await this.handleError('marketMakingUpdate', error, { market });
                }
            }
        }, this.UPDATE_INTERVAL);
    }

    private async shouldUpdateOrders(market: string): Promise<boolean> {
        const config = this.configs.get(market);
        if (!config.enabled) return false;

        const risk = await this.riskManagement.validateMarketMakingRisk(market);
        if (!risk.isValid) return false;

        const pool = this.pools.get(market);
        const poolData = await pool.getPoolData();
        
        // Check if there's enough liquidity
        const baseBalance = await this.walletService.getTokenBalance(poolData.baseMint);
        const quoteBalance = await this.walletService.getTokenBalance(poolData.quoteMint);

        return baseBalance.gte(config.baseSize) && quoteBalance.gte(config.quoteSize);
    }

    private async updateMarketMakingOrders(market: string) {
        const config = this.configs.get(market);
        const pool = this.pools.get(market);
        const poolKeys = this.poolKeys.get(market);

        // Get current market state
        const poolData = await pool.getPoolData();
        const midPrice = new Decimal(poolData.price.toString());
        
        // Calculate order prices
        const bidPrice = midPrice.mul(new Decimal(1).minus(config.spreadPercentage));
        const askPrice = midPrice.mul(new Decimal(1).plus(config.spreadPercentage));

        // Cancel existing orders
        await this.orderManagement.cancelAllOrders(market);

        // Place new orders
        try {
            // Place bid
            await this.orderManagement.createOrder({
                market,
                side: OrderSide.BUY,
                price: bidPrice,
                size: config.baseSize,
                type: OrderType.LIMIT,
                postOnly: true
            });

            // Place ask
            await this.orderManagement.createOrder({
                market,
                side: OrderSide.SELL,
                price: askPrice,
                size: config.baseSize,
                type: OrderType.LIMIT,
                postOnly: true
            });

            // Update metrics
            await this.metricsService.recordMarketMakingUpdate({
                market,
                midPrice: midPrice.toString(),
                bidPrice: bidPrice.toString(),
                askPrice: askPrice.toString(),
                spread: config.spreadPercentage.toString(),
                baseSize: config.baseSize.toString(),
                timestamp: new Date()
            });

            // Auto-hedge if enabled
            if (config.useAutoHedging) {
                await this.handleAutoHedging(market);
            }

        } catch (error) {
            await this.handleError('updateMarketMakingOrders', error, { market });
        }
    }

    private async handleAutoHedging(market: string) {
        const position = await this.positionTracking.getPositions().get(market);
        if (!position || position.size.isZero()) return;

        const config = this.configs.get(market);
        const hedgeSize = position.size.abs().mul(config.baseSize);

        if (hedgeSize.gt(config.maxExposure)) {
            const side = position.size.isNegative() ? OrderSide.BUY : OrderSide.SELL;
            
            await this.orderManagement.createOrder({
                market,
                side,
                size: hedgeSize,
                type: OrderType.MARKET,
                reduceOnly: true
            });
        }
    }

    async startMarketMaking(market: string): Promise<boolean> {
        const config = this.configs.get(market);
        if (!config) return false;

        config.enabled = true;
        await this.auditService.logSystemEvent({
            event: 'MARKET_MAKING_STARTED',
            details: { market },
            severity: 'INFO'
        });

        return true;
    }

    async stopMarketMaking(market: string): Promise<boolean> {
        const config = this.configs.get(market);
        if (!config) return false;

        config.enabled = false;
        await this.orderManagement.cancelAllOrders(market);
        
        await this.auditService.logSystemEvent({
            event: 'MARKET_MAKING_STOPPED',
            details: { market },
            severity: 'INFO'
        });

        return true;
    }

    getMarketUpdates(): Observable<Map<string, any>> {
        return this.marketUpdates.asObservable();
    }

    private async handleError(
        operation: string,
        error: Error,
        context?: any
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'MARKET_MAKING_ERROR',
            details: {
                operation,
                error: error.message,
                context
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('market_making');
    }
}
