import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SerumConnector } from '../../dex/SerumConnector';
import { SPLTokenService } from '../../tokens/SPLTokenService';
import { RiskManagementService } from '../risk/RiskManagementService';
import { MetricsService } from '../metrics/MetricsService';
import { NotificationService } from '../notification/NotificationService';
import { CircuitBreakerService } from '../circuit-breaker/CircuitBreakerService';
import {
    MarketMakingStrategy,
    SpreadConfig,
    InventoryConfig,
    OrderGrid,
    MarketDepth,
    PriceLevel,
    MarketMakingMetrics
} from './types/marketMaking.types';
import { OrderSide, OrderType } from '../../types/trading.types';
import BigNumber from 'bignumber.js';

@Injectable()
export class MarketMakingService implements OnModuleInit {
    private readonly logger = new Logger(MarketMakingService.name);
    private readonly strategies: Map<string, MarketMakingStrategy> = new Map();
    private readonly orderGrids: Map<string, OrderGrid> = new Map();
    private readonly updateInterval: number;
    private readonly maxOrderCount: number;
    private readonly minSpreadPercent: number;
    private readonly maxSpreadPercent: number;
    private isActive: boolean = false;

    constructor(
        private readonly configService: ConfigService,
        private readonly serumConnector: SerumConnector,
        private readonly splTokenService: SPLTokenService,
        private readonly riskManagement: RiskManagementService,
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.updateInterval = this.configService.get('MARKET_MAKING_UPDATE_INTERVAL_MS', 1000);
        this.maxOrderCount = this.configService.get('MARKET_MAKING_MAX_ORDERS', 10);
        this.minSpreadPercent = this.configService.get('MARKET_MAKING_MIN_SPREAD', 0.1);
        this.maxSpreadPercent = this.configService.get('MARKET_MAKING_MAX_SPREAD', 2.0);
    }

    async onModuleInit() {
        await this.loadStrategies();
        this.subscribeToMarketData();
    }

    async startMarketMaking(): Promise<void> {
        if (this.isActive) return;

        this.isActive = true;
        this.logger.log('Starting market making activities');

        for (const [marketId, strategy] of this.strategies) {
            await this.initializeMarketMaking(marketId, strategy);
        }

        this.startUpdateLoop();
    }

    async stopMarketMaking(): Promise<void> {
        this.isActive = false;
        this.logger.log('Stopping market making activities');

        for (const [marketId] of this.strategies) {
            await this.cancelAllOrders(marketId);
        }
    }

    private async initializeMarketMaking(
        marketId: string,
        strategy: MarketMakingStrategy
    ): Promise<void> {
        try {
            await this.validateStrategy(strategy);
            await this.createInitialOrderGrid(marketId, strategy);
            await this.recordStrategyMetrics(marketId, strategy);
        } catch (error) {
            this.logger.error(`Failed to initialize market making for ${marketId}:`, error);
            await this.handleStrategyError(marketId, error);
        }
    }

    private async validateStrategy(strategy: MarketMakingStrategy): Promise<void> {
        if (strategy.spreadConfig.baseSpread < this.minSpreadPercent) {
            throw new Error(`Spread too tight: ${strategy.spreadConfig.baseSpread}%`);
        }

        if (strategy.spreadConfig.baseSpread > this.maxSpreadPercent) {
            throw new Error(`Spread too wide: ${strategy.spreadConfig.baseSpread}%`);
        }

        await this.riskManagement.validateStrategy(strategy);
    }

    private async createInitialOrderGrid(
        marketId: string,
        strategy: MarketMakingStrategy
    ): Promise<void> {
        const orderbook = await this.serumConnector.getOrderbook(marketId);
        const midPrice = this.calculateMidPrice(orderbook);
        
        if (!midPrice) {
            throw new Error(`Unable to determine mid price for ${marketId}`);
        }

        const grid = await this.generateOrderGrid(
            marketId,
            strategy,
            midPrice
        );

        this.orderGrids.set(marketId, grid);
        await this.placeOrderGrid(marketId, grid);
    }

    private calculateMidPrice(orderbook: MarketDepth): BigNumber | null {
        if (!orderbook.bids.length || !orderbook.asks.length) {
            return null;
        }

        const bestBid = new BigNumber(orderbook.bids[0].price);
        const bestAsk = new BigNumber(orderbook.asks[0].price);
        return bestBid.plus(bestAsk).dividedBy(2);
    }

    private async generateOrderGrid(
        marketId: string,
        strategy: MarketMakingStrategy,
        midPrice: BigNumber
    ): Promise<OrderGrid> {
        const { spreadConfig, inventoryConfig } = strategy;
        const grid: OrderGrid = {
            marketId,
            timestamp: new Date(),
            bids: [],
            asks: [],
            midPrice
        };

        const inventory = await this.getCurrentInventory(marketId);
        const skew = this.calculateInventorySkew(inventory, inventoryConfig);
        const adjustedSpread = this.adjustSpreadForInventory(
            spreadConfig,
            skew
        );

        for (let i = 0; i < this.maxOrderCount / 2; i++) {
            const levelSpread = adjustedSpread * (1 + i * spreadConfig.spreadStep);
            const quantity = this.calculateQuantityForLevel(i, strategy);

            grid.bids.push({
                price: midPrice.multipliedBy(1 - levelSpread),
                quantity,
                level: i
            });

            grid.asks.push({
                price: midPrice.multipliedBy(1 + levelSpread),
                quantity,
                level: i
            });
        }

        return grid;
    }

    private async getCurrentInventory(marketId: string): Promise<BigNumber> {
        const strategy = this.strategies.get(marketId);
        if (!strategy) throw new Error(`Strategy not found for ${marketId}`);

        const balance = await this.splTokenService.getTokenBalance(
            strategy.baseToken,
            strategy.wallet
        );

        return balance.amount;
    }

    private calculateInventorySkew(
        inventory: BigNumber,
        config: InventoryConfig
    ): number {
        const target = new BigNumber(config.targetInventory);
        const range = new BigNumber(config.maxInventory).minus(config.minInventory);
        const deviation = inventory.minus(target).dividedBy(range);

        return Math.max(-1, Math.min(1, deviation.toNumber()));
    }

    private adjustSpreadForInventory(
        spreadConfig: SpreadConfig,
        skew: number
    ): number {
        return spreadConfig.baseSpread * (1 + skew * spreadConfig.inventorySkewImpact);
    }

    private calculateQuantityForLevel(
        level: number,
        strategy: MarketMakingStrategy
    ): BigNumber {
        const baseQuantity = new BigNumber(strategy.baseQuantity);
        const decay = new BigNumber(1).minus(
            level * strategy.quantityDecayFactor
        );
        return baseQuantity.multipliedBy(decay);
    }

    private async placeOrderGrid(
        marketId: string,
        grid: OrderGrid
    ): Promise<void> {
        await this.cancelAllOrders(marketId);

        const orders = [...grid.bids, ...grid.asks];
        for (const order of orders) {
            try {
                await this.serumConnector.placeOrder({
                    marketId,
                    side: order.price.lt(grid.midPrice) ? OrderSide.BUY : OrderSide.SELL,
                    price: order.price,
                    quantity: order.quantity,
                    type: OrderType.LIMIT,
                    postOnly: true
                });
            } catch (error) {
                this.logger.error(`Failed to place order:`, error);
                await this.handleOrderError(marketId, error);
            }
        }
    }

    private async cancelAllOrders(marketId: string): Promise<void> {
        try {
            await this.serumConnector.cancelAllOrders(marketId);
        } catch (error) {
            this.logger.error(`Failed to cancel orders for ${marketId}:`, error);
        }
    }

    private startUpdateLoop(): void {
        setInterval(async () => {
            if (!this.isActive) return;

            for (const [marketId, strategy] of this.strategies) {
                try {
                    await this.updateMarketMaking(marketId, strategy);
                } catch (error) {
                    this.logger.error(`Market making update failed for ${marketId}:`, error);
                    await this.handleUpdateError(marketId, error);
                }
            }
        }, this.updateInterval);
    }

    private async updateMarketMaking(
        marketId: string,
        strategy: MarketMakingStrategy
    ): Promise<void> {
        const orderbook = await this.serumConnector.getOrderbook(marketId);
        const midPrice = this.calculateMidPrice(orderbook);

        if (!midPrice) return;

        const currentGrid = this.orderGrids.get(marketId);
        if (!currentGrid) return;

        const priceDeviation = midPrice
            .minus(currentGrid.midPrice)
            .dividedBy(currentGrid.midPrice)
            .abs();

        if (priceDeviation.gt(strategy.updateThreshold)) {
            const newGrid = await this.generateOrderGrid(
                marketId,
                strategy,
                midPrice
            );
            await this.placeOrderGrid(marketId, newGrid);
            this.orderGrids.set(marketId, newGrid);
        }
    }

    private async recordStrategyMetrics(
        marketId: string,
        strategy: MarketMakingStrategy
    ): Promise<void> {
        const metrics: MarketMakingMetrics = {
            marketId,
            timestamp: new Date(),
            baseSpread: strategy.spreadConfig.baseSpread,
            inventorySkew: await this.calculateInventorySkew(
                await this.getCurrentInventory(marketId),
                strategy.inventoryConfig
            ),
            orderCount: this.maxOrderCount,
            isActive: this.isActive
        };

        await this.metricsService.recordMarketMakingMetrics(metrics);
    }

    private async handleStrategyError(
        marketId: string,
        error: Error
    ): Promise<void> {
        await this.notificationService.sendSystemAlert({
            component: 'MarketMaking',
            type: 'STRATEGY_ERROR',
            marketId,
            error: error.message
        });
    }

    private async handleOrderError(
        marketId: string,
        error: Error
    ): Promise<void> {
        await this.notificationService.sendSystemAlert({
            component: 'MarketMaking',
            type: 'ORDER_ERROR',
            marketId,
            error: error.message
        });
    }

    private async handleUpdateError(
        marketId: string,
        error: Error
    ): Promise<void> {
        await this.notificationService.sendSystemAlert({
            component: 'MarketMaking',
            type: 'UPDATE_ERROR',
            marketId,
            error: error.message
        });
    }
}
