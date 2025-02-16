import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { 
    MarketState, 
    MarketDataSubscription,
    PoolState
} from '../../types/trading.types';
import { Market, LiquidityStateV4, TokenAmount, Percent } from '@raydium-io/raydium-sdk';
import { WebSocket } from 'ws';
import { Redis } from 'ioredis';
import { logger } from '../../utils/logger';
import { ErrorReporter } from '../../utils/errorReporting';
import { PerformanceMonitor } from '../../utils/performance';
import { ConfigService } from '../config/ConfigService';
import { MarketCache } from '../cache/MarketCache';
import { PoolCache } from '../cache/PoolCache';
import BN from 'bn.js';

interface MarketUpdateConfig {
    walletPublicKey: PublicKey;
    quoteToken: PublicKey;
    autoSell: boolean;
    cacheNewMarkets: boolean;
    startTimestamp: number;
}

export class MarketEventService extends EventEmitter {
    private readonly subscriptions: Map<string, MarketDataSubscription>;
    private readonly websocket: WebSocket;
    private readonly redis?: Redis;
    private readonly performanceMonitor: PerformanceMonitor;
    private readonly updateIntervals: Map<string, NodeJS.Timer>;
    private isRunning: boolean = false;

    private readonly WEBSOCKET_RECONNECT_DELAY = 5000;
    private readonly DEFAULT_UPDATE_INTERVAL = 1000;
    private readonly MAX_RETRY_ATTEMPTS = 3;
    private readonly CACHE_TTL = 24 * 60 * 60; // 24 hours

    constructor(
        private readonly connection: Connection,
        private readonly marketCache: MarketCache,
        private readonly poolCache: PoolCache,
        private readonly config: ConfigService
    ) {
        super();
        this.subscriptions = new Map();
        this.updateIntervals = new Map();
        this.performanceMonitor = new PerformanceMonitor();

        // Initialize WebSocket connection
        this.websocket = new WebSocket(this.config.get('MARKET_WS_URL'));
        this.setupWebSocket();

        // Initialize Redis if enabled
        if (this.config.get('REDIS_ENABLED') === 'true') {
            this.redis = new Redis({
                host: this.config.get('REDIS_HOST'),
                port: parseInt(this.config.get('REDIS_PORT') || '6379'),
                password: this.config.get('REDIS_PASSWORD'),
                retryStrategy: (times: number) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            });

            this.redis.on('error', (error) => {
                logger.error('Redis connection error:', error);
                ErrorReporter.reportError(error, {
                    context: 'MarketEventService.redis',
                    service: 'Redis'
                });
            });
        }
    }

    async start(config: MarketUpdateConfig): Promise<void> {
        if (this.isRunning) {
            logger.warn('Market event service is already running');
            return;
        }

        try {
            this.isRunning = true;
            logger.info('Starting market event service...');

            // Subscribe to market updates via WebSocket
            this.websocket.send(JSON.stringify({
                op: 'subscribe',
                channel: 'markets',
                walletAddress: config.walletPublicKey.toString(),
                quoteToken: config.quoteToken.toString()
            }));

            // Initialize market monitoring
            await this.initializeMarketMonitoring(config);

            logger.info('Market event service started successfully');
        } catch (error) {
            this.isRunning = false;
            logger.error('Failed to start market event service:', error);
            ErrorReporter.reportError(error, {
                context: 'MarketEventService.start',
                config: JSON.stringify(config)
            });
            throw error;
        }
    }

    stop(): void {
        this.isRunning = false;
        this.websocket.close();
        
        // Clear all update intervals
        for (const interval of this.updateIntervals.values()) {
            clearInterval(interval);
        }
        this.updateIntervals.clear();
        
        // Clear all subscriptions
        this.subscriptions.clear();
        
        logger.info('Market event service stopped');
    }

    async subscribeToMarket(
        marketAddress: PublicKey,
        callback: (state: MarketState) => Promise<void>,
        updateInterval: number = this.DEFAULT_UPDATE_INTERVAL
    ): Promise<void> {
        const subscription: MarketDataSubscription = {
            marketAddress,
            updateInterval,
            callback
        };

        this.subscriptions.set(marketAddress.toString(), subscription);
        await this.startMarketUpdates(subscription);
    }

    async unsubscribeFromMarket(marketAddress: PublicKey): Promise<void> {
        const addressStr = marketAddress.toString();
        const interval = this.updateIntervals.get(addressStr);
        
        if (interval) {
            clearInterval(interval);
            this.updateIntervals.delete(addressStr);
        }
        
        this.subscriptions.delete(addressStr);
    }

    private async initializeMarketMonitoring(config: MarketUpdateConfig): Promise<void> {
        try {
            // Load existing markets from cache
            const markets = await this.marketCache.getAllMarkets();
            
            for (const [address, market] of markets) {
                if (market.state.lastUpdate >= config.startTimestamp) {
                    await this.monitorMarket(new PublicKey(address));
                }
            }
        } catch (error) {
            logger.error('Error initializing market monitoring:', error);
            ErrorReporter.reportError(error, {
                context: 'MarketEventService.initializeMarketMonitoring'
            });
        }
    }

    private async startMarketUpdates(subscription: MarketDataSubscription): Promise<void> {
        const addressStr = subscription.marketAddress.toString();
        
        if (this.updateIntervals.has(addressStr)) {
            clearInterval(this.updateIntervals.get(addressStr));
        }

        const interval = setInterval(async () => {
            try {
                const marketState = await this.fetchMarketState(subscription.marketAddress);
                if (marketState) {
                    await subscription.callback(marketState);
                }
            } catch (error) {
                logger.error(`Error updating market ${addressStr}:`, error);
            }
        }, subscription.updateInterval);

        this.updateIntervals.set(addressStr, interval);
    }

    private async fetchMarketState(address: PublicKey): Promise<MarketState | null> {
        const timer = this.performanceMonitor.startTimer('fetchMarketState');
        
        try {
            const accountInfo = await this.connection.getAccountInfo(address);
            if (!accountInfo) return null;

            const state = Market.getStateLayout().decode(accountInfo.data);
            const marketState: MarketState = {
                isActive: true,
                price: state.price,
                bids: state.bids,
                asks: state.asks,
                eventQueue: state.eventQueue,
                volume24h: state.volume24h,
                liquidity: state.baseDepositsTotal.mul(state.price),
                lastUpdate: Date.now(),
                volatility24h: await this.calculateVolatility(address)
            };

            // Update cache
            await this.marketCache.update(address, {
                state: marketState,
                lastUpdated: Date.now()
            });

            return marketState;
        } catch (error) {
            logger.error('Error fetching market state:', error);
            ErrorReporter.reportError(error, {
                context: 'MarketEventService.fetchMarketState',
                address: address.toString()
            });
            return null;
        } finally {
            this.performanceMonitor.endTimer('fetchMarketState', timer);
        }
    }

    private async calculateVolatility(
        address: PublicKey,
        period: number = 24 * 60 * 60 * 1000 // 24 hours
    ): Promise<Percent> {
        try {
            const priceHistory = await this.getPriceHistory(address, period);
            if (priceHistory.length < 2) {
                return new Percent(new BN(0), new BN(100));
            }

            const returns = [];
            for (let i = 1; i < priceHistory.length; i++) {
                const return_ = priceHistory[i].sub(priceHistory[i - 1])
                    .mul(new BN(100))
                    .div(priceHistory[i - 1]);
                returns.push(return_.toNumber());
            }

            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
            const volatility = Math.sqrt(variance);

            return new Percent(new BN(Math.floor(volatility)), new BN(100));
        } catch (error) {
            logger.error('Error calculating volatility:', error);
            return new Percent(new BN(0), new BN(100));
        }
    }

    private async getPriceHistory(
        address: PublicKey,
        period: number
    ): Promise<BN[]> {
        if (!this.redis) return [];

        try {
            const prices = await this.redis.zrangebyscore(
                `market:${address.toString()}:prices`,
                Date.now() - period,
                Date.now()
            );

            return prices.map(p => new BN(p));
        } catch (error) {
            logger.error('Error fetching price history:', error);
            return [];
        }
    }

    private setupWebSocket(): void {
        this.websocket.on('open', () => {
            logger.info('WebSocket connection established');
        });

        this.websocket.on('message', async (data: string) => {
            try {
                const message = JSON.parse(data);
                await this.handleWebSocketMessage(message);
            } catch (error) {
                logger.error('Error handling WebSocket message:', error);
            }
        });

        this.websocket.on('close', () => {
            logger.warn('WebSocket connection closed');
            setTimeout(() => this.reconnectWebSocket(), this.WEBSOCKET_RECONNECT_DELAY);
        });

        this.websocket.on('error', (error) => {
            logger.error('WebSocket error:', error);
            ErrorReporter.reportError(error, {
                context: 'MarketEventService.websocket'
            });
        });
    }

    private async handleWebSocketMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'market_update':
                await this.handleMarketUpdate(message.data);
                break;
            case 'new_market':
                await this.handleNewMarket(message.data);
                break;
            case 'price_update':
                await this.handlePriceUpdate(message.data);
                break;
            default:
                logger.warn('Unknown message type:', message.type);
        }
    }

    private reconnectWebSocket(): void {
        if (!this.isRunning) return;

        try {
            this.websocket.terminate();
            this.websocket.connect(this.config.get('MARKET_WS_URL'));
        } catch (error) {
            logger.error('WebSocket reconnection error:', error);
            setTimeout(() => this.reconnectWebSocket(), this.WEBSOCKET_RECONNECT_DELAY);
        }
    }

    private async handleMarketUpdate(data: any): Promise<void> {
        const address = new PublicKey(data.address);
        const subscription = this.subscriptions.get(address.toString());
        
        if (subscription) {
            const marketState = await this.fetchMarketState(address);
            if (marketState) {
                await subscription.callback(marketState);
                this.emit('market:update', { address, data: marketState });
            }
        }
    }

    private async handleNewMarket(data: any): Promise<void> {
        try {
            const address = new PublicKey(data.address);
            const marketState = await this.fetchMarketState(address);
            
            if (marketState) {
                this.emit('market:new', { address, data: marketState });
            }
        } catch (error) {
            logger.error('Error handling new market:', error);
        }
    }

    private async handlePriceUpdate(data: any): Promise<void> {
        if (!this.redis) return;

        try {
            const address = data.address;
            const price = new BN(data.price);
            
            await this.redis.zadd(
                `market:${address}:prices`,
                Date.now(),
                price.toString()
            );

            // Cleanup old prices
            await this.redis.zremrangebyscore(
                `market:${address}:prices`,
                0,
                Date.now() - (24 * 60 * 60 * 1000) // Remove prices older than 24 hours
            );
        } catch (error) {
            logger.error('Error handling price update:', error);
        }
    }
}
