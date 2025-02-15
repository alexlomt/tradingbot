import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '../cache/RedisService';
import { MetricsService } from '../metrics/MetricsService';
import { NotificationService } from '../notification/NotificationService';
import { RiskManagementService } from './RiskManagementService';
import { CircuitBreakerService } from '../circuit-breaker/CircuitBreakerService';
import { DatabaseService } from '../database/DatabaseService';
import AVLTree from 'avl';
import BigNumber from 'bignumber.js';
import {
    Order,
    OrderBook,
    OrderBookLevel,
    OrderMatch,
    OrderSide,
    OrderStatus,
    OrderType,
    MatchResult
} from '../../types/trading.types';

@Injectable()
export class OrderMatchingEngine implements OnModuleInit {
    private readonly logger = new Logger(OrderMatchingEngine.name);
    private readonly orderBooks: Map<string, OrderBook> = new Map();
    private readonly matchingInterval: number;
    private readonly maxOrderBookDepth: number;
    private readonly priceDecimals: number;
    private readonly quantityDecimals: number;

    constructor(
        private readonly configService: ConfigService,
        private readonly redisService: RedisService,
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService,
        private readonly riskManagement: RiskManagementService,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly databaseService: DatabaseService,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.matchingInterval = this.configService.get('MATCHING_INTERVAL_MS', 100);
        this.maxOrderBookDepth = this.configService.get('MAX_ORDERBOOK_DEPTH', 1000);
        this.priceDecimals = this.configService.get('PRICE_DECIMALS', 8);
        this.quantityDecimals = this.configService.get('QUANTITY_DECIMALS', 8);
    }

    async onModuleInit() {
        await this.loadOrderBooks();
        this.startMatchingProcess();
    }

    async addOrder(order: Order): Promise<void> {
        await this.validateOrder(order);
        
        const orderBook = this.getOrCreateOrderBook(order.pair);
        const normalizedOrder = this.normalizeOrder(order);

        if (order.type === OrderType.MARKET) {
            await this.processMarketOrder(normalizedOrder, orderBook);
        } else {
            await this.processLimitOrder(normalizedOrder, orderBook);
        }

        await this.persistOrderBook(order.pair);
        await this.broadcastOrderBookUpdate(order.pair);
    }

    async cancelOrder(orderId: string, userId: string): Promise<boolean> {
        for (const [pair, orderBook] of this.orderBooks) {
            const order = orderBook.orders.get(orderId);
            if (order && order.userId === userId) {
                return this.circuitBreaker.executeFunction(
                    'order_cancellation',
                    async () => {
                        await this.removeOrderFromBook(order, orderBook);
                        await this.persistOrderBook(pair);
                        await this.broadcastOrderBookUpdate(pair);
                        
                        this.eventEmitter.emit('order.cancelled', {
                            orderId,
                            userId,
                            pair
                        });

                        return true;
                    }
                );
            }
        }
        return false;
    }

    getOrderBook(pair: string): OrderBookLevel[] {
        const orderBook = this.orderBooks.get(pair);
        if (!orderBook) return [];

        const bids = this.aggregateOrders(orderBook.bids);
        const asks = this.aggregateOrders(orderBook.asks);

        return [...bids, ...asks].slice(0, this.maxOrderBookDepth);
    }

    private async loadOrderBooks(): Promise<void> {
        const pairs = await this.databaseService.getTradingPairs();
        
        for (const pair of pairs) {
            const orderBook = await this.redisService.get(`orderbook:${pair}`);
            if (orderBook) {
                this.orderBooks.set(pair, JSON.parse(orderBook));
            } else {
                this.orderBooks.set(pair, this.createEmptyOrderBook());
            }
        }
    }

    private startMatchingProcess(): void {
        setInterval(async () => {
            for (const [pair, orderBook] of this.orderBooks) {
                try {
                    await this.matchOrders(pair, orderBook);
                } catch (error) {
                    this.logger.error(`Matching error for ${pair}:`, error);
                    await this.handleMatchingError(pair, error);
                }
            }
        }, this.matchingInterval);
    }

    private async matchOrders(pair: string, orderBook: OrderBook): Promise<void> {
        const startTime = Date.now();
        let matchCount = 0;

        while (this.canMatch(orderBook)) {
            const bestBid = orderBook.bids.max();
            const bestAsk = orderBook.asks.min();

            if (!bestBid || !bestAsk || bestBid.price.lt(bestAsk.price)) {
                break;
            }

            const match = await this.executeMatch(bestBid, bestAsk, orderBook);
            if (match) {
                matchCount++;
                await this.processMatch(match, pair);
            }
        }

        const duration = Date.now() - startTime;
        await this.recordMatchingMetrics(pair, matchCount, duration);
    }

    private async executeMatch(
        bid: Order,
        ask: Order,
        orderBook: OrderBook
    ): Promise<OrderMatch | null> {
        const matchPrice = this.calculateMatchPrice(bid.price, ask.price);
        const matchQuantity = BigNumber.minimum(bid.quantity, ask.quantity);

        if (matchQuantity.lte(0)) {
            return null;
        }

        const match: OrderMatch = {
            buyOrderId: bid.id,
            sellOrderId: ask.id,
            price: matchPrice,
            quantity: matchQuantity,
            timestamp: new Date()
        };

        await this.updateOrderQuantities(bid, ask, matchQuantity, orderBook);
        return match;
    }

    private async updateOrderQuantities(
        bid: Order,
        ask: Order,
        matchQuantity: BigNumber,
        orderBook: OrderBook
    ): Promise<void> {
        bid.quantity = bid.quantity.minus(matchQuantity);
        ask.quantity = ask.quantity.minus(matchQuantity);

        if (bid.quantity.lte(0)) {
            await this.removeOrderFromBook(bid, orderBook);
        }

        if (ask.quantity.lte(0)) {
            await this.removeOrderFromBook(ask, orderBook);
        }
    }

    private async processMatch(match: OrderMatch, pair: string): Promise<void> {
        await this.databaseService.saveMatch(match);
        await this.updateOrderStatus(match);
        await this.settleMatch(match);

        this.eventEmitter.emit('order.matched', {
            ...match,
            pair
        });

        await this.metricsService.recordMatch({
            pair,
            price: match.price.toNumber(),
            quantity: match.quantity.toNumber(),
            timestamp: match.timestamp
        });
    }

    private async settleMatch(match: OrderMatch): Promise<void> {
        await this.circuitBreaker.executeFunction(
            'match_settlement',
            async () => {
                const buyOrder = await this.databaseService.getOrder(match.buyOrderId);
                const sellOrder = await this.databaseService.getOrder(match.sellOrderId);

                await this.riskManagement.validateSettlement(match, buyOrder, sellOrder);
                await this.updateBalances(match, buyOrder, sellOrder);
            }
        );
    }

    private async processLimitOrder(order: Order, orderBook: OrderBook): Promise<void> {
        if (order.side === OrderSide.BUY) {
            orderBook.bids.insert(order);
        } else {
            orderBook.asks.insert(order);
        }

        orderBook.orders.set(order.id, order);

        this.eventEmitter.emit('order.added', {
            orderId: order.id,
            pair: order.pair,
            side: order.side,
            price: order.price.toNumber(),
            quantity: order.quantity.toNumber()
        });
    }

    private async processMarketOrder(
        order: Order,
        orderBook: OrderBook
    ): Promise<MatchResult> {
        let remainingQuantity = order.quantity;
        const matches: OrderMatch[] = [];

        const targetTree = order.side === OrderSide.BUY ? orderBook.asks : orderBook.bids;
        
        while (remainingQuantity.gt(0) && !targetTree.isEmpty()) {
            const matchingOrder = order.side === OrderSide.BUY
                ? targetTree.min()
                : targetTree.max();

            if (!matchingOrder) break;

            const matchQuantity = BigNumber.minimum(
                remainingQuantity,
                matchingOrder.quantity
            );

            const match: OrderMatch = {
                buyOrderId: order.side === OrderSide.BUY ? order.id : matchingOrder.id,
                sellOrderId: order.side === OrderSide.BUY ? matchingOrder.id : order.id,
                price: matchingOrder.price,
                quantity: matchQuantity,
                timestamp: new Date()
            };

            matches.push(match);
            remainingQuantity = remainingQuantity.minus(matchQuantity);
            await this.processMatch(match, order.pair);

            if (matchingOrder.quantity.eq(matchQuantity)) {
                await this.removeOrderFromBook(matchingOrder, orderBook);
            } else {
                matchingOrder.quantity = matchingOrder.quantity.minus(matchQuantity);
            }
        }

        return {
            matches,
            remainingQuantity
        };
    }

    private async removeOrderFromBook(
        order: Order,
        orderBook: OrderBook
    ): Promise<void> {
        const tree = order.side === OrderSide.BUY ? orderBook.bids : orderBook.asks;
        tree.remove(order);
        orderBook.orders.delete(order.id);

        this.eventEmitter.emit('order.removed', {
            orderId: order.id,
            pair: order.pair,
            side: order.side
        });
    }

    private async validateOrder(order: Order): Promise<void> {
        if (!order.id || !order.pair || !order.userId) {
            throw new Error('Invalid order: missing required fields');
        }

        if (order.quantity.lte(0) || order.price.lte(0)) {
            throw new Error('Invalid order: price and quantity must be positive');
        }

        await this.riskManagement.validateOrder(order);
    }

    private normalizeOrder(order: Order): Order {
        return {
            ...order,
            price: order.price.dp(this.priceDecimals),
            quantity: order.quantity.dp(this.quantityDecimals)
        };
    }

    private createEmptyOrderBook(): OrderBook {
        return {
            bids: new AVLTree((a: Order, b: Order) => b.price.comparedTo(a.price)),
            asks: new AVLTree((a: Order, b: Order) => a.price.comparedTo(b.price)),
            orders: new Map()
        };
    }

    private getOrCreateOrderBook(pair: string): OrderBook {
        if (!this.orderBooks.has(pair)) {
            this.orderBooks.set(pair, this.createEmptyOrderBook());
        }
        return this.orderBooks.get(pair)!;
    }

    private canMatch(orderBook: OrderBook): boolean {
        if (orderBook.bids.isEmpty() || orderBook.asks.isEmpty()) {
            return false;
        }

        const bestBid = orderBook.bids.max();
        const bestAsk = orderBook.asks.min();

        return bestBid && bestAsk && bestBid.price.gte(bestAsk.price);
    }

    private calculateMatchPrice(bidPrice: BigNumber, askPrice: BigNumber): BigNumber {
        return bidPrice.plus(askPrice).dividedBy(2).dp(this.priceDecimals);
    }

    private async persistOrderBook(pair: string): Promise<void> {
        const orderBook = this.orderBooks.get(pair);
        if (orderBook) {
            await this.redisService.set(
                `orderbook:${pair}`,
                JSON.stringify(orderBook),
                'EX',
                3600
            );
        }
    }

    private async broadcastOrderBookUpdate(pair: string): Promise<void> {
        const orderBook = this.getOrderBook(pair);
        this.eventEmitter.emit('orderbook.updated', {
            pair,
            orderBook,
            timestamp: new Date()
        });
    }

    private async recordMatchingMetrics(
        pair: string,
        matchCount: number,
        duration: number
    ): Promise<void> {
        await this.metricsService.recordMatchingMetrics({
            pair,
            matchCount,
            duration,
            timestamp: new Date()
        });
    }

    private async handleMatchingError(pair: string, error: Error): Promise<void> {
        await this.notificationService.sendSystemAlert({
            component: 'OrderMatching',
            type: 'MATCHING_ERROR',
            pair,
            error: error.message
        });

        await this.metricsService.recordMatchingError({
            pair,
            error: error.message,
            timestamp: new Date()
        });
    }
}
