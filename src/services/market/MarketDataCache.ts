import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/RedisService';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { WebSocketService } from '../websocket/WebSocketService';
import { CacheService } from '../cache/CacheService';
import { OrderBook, MarketDepth, Candle, Trade } from '../../types/market.types';
import { Subject, Observable } from 'rxjs';
import { throttleTime, map } from 'rxjs/operators';

@Injectable()
export class MarketDataCache implements OnModuleInit {
    private readonly marketUpdates = new Subject<any>();
    private readonly CACHE_PREFIX = 'market';
    private readonly ORDERBOOK_TTL = 30; // 30 seconds
    private readonly TRADE_HISTORY_TTL = 3600; // 1 hour
    private readonly CANDLE_TTL = 86400; // 24 hours
    private readonly MAX_TRADE_HISTORY = 1000;
    private readonly DEPTH_LEVELS = 20;

    constructor(
        private readonly configService: ConfigService,
        private readonly redisService: RedisService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService,
        private readonly webSocketService: WebSocketService,
        private readonly cacheService: CacheService
    ) {}

    async onModuleInit() {
        await this.initializeWebSocketConnections();
        this.startDataCleanupJob();
        this.initializeMetricsReporting();
    }

    private async initializeWebSocketConnections() {
        const markets = this.configService.get<string[]>('TRADING_MARKETS');
        
        for (const market of markets) {
            await this.webSocketService.subscribe(
                `orderbook:${market}`,
                (data) => this.handleOrderBookUpdate(market, data)
            );

            await this.webSocketService.subscribe(
                `trades:${market}`,
                (data) => this.handleTradeUpdate(market, data)
            );

            await this.webSocketService.subscribe(
                `candles:${market}`,
                (data) => this.handleCandleUpdate(market, data)
            );
        }
    }

    private startDataCleanupJob() {
        setInterval(async () => {
            try {
                await this.cleanupStaleData();
            } catch (error) {
                await this.auditService.logSystemEvent({
                    event: 'MARKET_DATA_CLEANUP_ERROR',
                    details: { error: error.message },
                    severity: 'ERROR'
                });
            }
        }, 3600000); // Run every hour
    }

    private initializeMetricsReporting() {
        this.marketUpdates.pipe(
            throttleTime(5000)
        ).subscribe(async (update) => {
            await this.metricsService.recordMarketMetrics(update);
        });
    }

    async getOrderBook(market: string): Promise<OrderBook> {
        const cacheKey = `${this.CACHE_PREFIX}:orderbook:${market}`;
        try {
            const cached = await this.cacheService.get<OrderBook>(cacheKey);
            if (cached) {
                return cached;
            }

            const orderBook = await this.fetchOrderBook(market);
            await this.cacheService.set(cacheKey, orderBook, this.ORDERBOOK_TTL);
            return orderBook;
        } catch (error) {
            await this.handleError('getOrderBook', error, { market });
            throw error;
        }
    }

    async getMarketDepth(market: string, levels: number = this.DEPTH_LEVELS): Promise<MarketDepth> {
        const cacheKey = `${this.CACHE_PREFIX}:depth:${market}:${levels}`;
        try {
            const cached = await this.cacheService.get<MarketDepth>(cacheKey);
            if (cached) {
                return cached;
            }

            const orderBook = await this.getOrderBook(market);
            const depth = this.calculateMarketDepth(orderBook, levels);
            await this.cacheService.set(cacheKey, depth, this.ORDERBOOK_TTL);
            return depth;
        } catch (error) {
            await this.handleError('getMarketDepth', error, { market, levels });
            throw error;
        }
    }

    async getRecentTrades(market: string, limit: number = 100): Promise<Trade[]> {
        const cacheKey = `${this.CACHE_PREFIX}:trades:${market}`;
        try {
            const trades = await this.redisService.lrange(cacheKey, 0, limit - 1);
            return trades.map(trade => JSON.parse(trade));
        } catch (error) {
            await this.handleError('getRecentTrades', error, { market, limit });
            throw error;
        }
    }

    async getCandles(
        market: string,
        interval: string,
        start: number,
        end: number
    ): Promise<Candle[]> {
        const cacheKey = `${this.CACHE_PREFIX}:candles:${market}:${interval}`;
        try {
            const cached = await this.cacheService.get<Candle[]>(cacheKey);
            if (cached) {
                return this.filterCandlesByTimeRange(cached, start, end);
            }

            const candles = await this.fetchCandles(market, interval, start, end);
            await this.cacheService.set(cacheKey, candles, this.CANDLE_TTL);
            return candles;
        } catch (error) {
            await this.handleError('getCandles', error, { market, interval, start, end });
            throw error;
        }
    }

    subscribeToMarketUpdates(market: string): Observable<any> {
        return this.marketUpdates.pipe(
            map(update => update.market === market ? update : null),
            map(update => update ? this.transformMarketUpdate(update) : null)
        );
    }

    private async handleOrderBookUpdate(market: string, data: any) {
        const cacheKey = `${this.CACHE_PREFIX}:orderbook:${market}`;
        try {
            const orderBook = await this.getOrderBook(market);
            const updated = this.updateOrderBook(orderBook, data);
            await this.cacheService.set(cacheKey, updated, this.ORDERBOOK_TTL);
            this.marketUpdates.next({ type: 'orderbook', market, data: updated });
        } catch (error) {
            await this.handleError('handleOrderBookUpdate', error, { market, data });
        }
    }

    private async handleTradeUpdate(market: string, trade: Trade) {
        const cacheKey = `${this.CACHE_PREFIX}:trades:${market}`;
        try {
            await this.redisService.lpush(cacheKey, JSON.stringify(trade));
            await this.redisService.ltrim(cacheKey, 0, this.MAX_TRADE_HISTORY - 1);
            this.marketUpdates.next({ type: 'trade', market, data: trade });
        } catch (error) {
            await this.handleError('handleTradeUpdate', error, { market, trade });
        }
    }

    private async handleCandleUpdate(market: string, candle: Candle) {
        const cacheKey = `${this.CACHE_PREFIX}:candles:${market}:${candle.interval}`;
        try {
            const candles = await this.getCandles(market, candle.interval, 0, Date.now());
            const updated = this.updateCandles(candles, candle);
            await this.cacheService.set(cacheKey, updated, this.CANDLE_TTL);
            this.marketUpdates.next({ type: 'candle', market, data: candle });
        } catch (error) {
            await this.handleError('handleCandleUpdate', error, { market, candle });
        }
    }

    private async cleanupStaleData() {
        const markets = this.configService.get<string[]>('TRADING_MARKETS');
        for (const market of markets) {
            const tradeKey = `${this.CACHE_PREFIX}:trades:${market}`;
            await this.redisService.ltrim(tradeKey, 0, this.MAX_TRADE_HISTORY - 1);
        }
    }

    private async handleError(operation: string, error: any, context: any) {
        await this.auditService.logSystemEvent({
            event: 'MARKET_DATA_ERROR',
            details: {
                operation,
                error: error.message,
                context
            },
            severity: 'ERROR'
        });
        await this.metricsService.incrementMarketDataError(operation);
    }

    private transformMarketUpdate(update: any) {
        // Transform market updates based on type
        switch (update.type) {
            case 'orderbook':
                return {
                    ...update,
                    timestamp: Date.now(),
                    depth: this.calculateMarketDepth(update.data, this.DEPTH_LEVELS)
                };
            case 'trade':
                return {
                    ...update,
                    value: update.data.price * update.data.size
                };
            default:
                return update;
        }
    }

    private filterCandlesByTimeRange(candles: Candle[], start: number, end: number): Candle[] {
        return candles.filter(candle => 
            candle.timestamp >= start && candle.timestamp <= end
        );
    }

    private calculateMarketDepth(orderBook: OrderBook, levels: number): MarketDepth {
        // Implementation of market depth calculation
        return {
            bids: this.aggregateDepth(orderBook.bids, levels),
            asks: this.aggregateDepth(orderBook.asks, levels),
            timestamp: Date.now()
        };
    }

    private aggregateDepth(orders: [number, number][], levels: number): [number, number][] {
        // Implementation of depth aggregation
        return orders
            .slice(0, levels)
            .reduce((acc, [price, size], i) => {
                if (i === 0) {
                    return [[price, size]];
                }
                const [prevPrice, prevSize] = acc[i - 1];
                return [...acc, [price, size + prevSize]];
            }, [] as [number, number][]);
    }
}
