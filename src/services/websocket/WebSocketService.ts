import { 
    Injectable, 
    OnModuleInit, 
    OnModuleDestroy, 
    Logger 
} from '@nestjs/common';
import { 
    WebSocketGateway, 
    WebSocketServer, 
    SubscribeMessage, 
    OnGatewayConnection,
    OnGatewayDisconnect,
    WsResponse,
    ConnectedSocket
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AuthService } from '../auth/AuthService';
import { MarketService } from '../market/MarketService';
import { RedisService } from '../cache/RedisService';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { 
    WebSocketMessage, 
    MarketUpdateData,
    OrderUpdateData,
    WalletUpdateData 
} from '../../types/websocket.types';
import * as jwt from 'jsonwebtoken';

@WebSocketGateway({
    cors: {
        origin: process.env.FRONTEND_URL,
        credentials: true
    },
    transports: ['websocket'],
    namespace: '/trading'
})
@Injectable()
export class WebSocketService implements OnModuleInit, OnModuleDestroy, OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    private server: Server;
    
    private readonly logger = new Logger(WebSocketService.name);
    private readonly userSessions = new Map<string, Set<string>>();
    private readonly marketSubscriptions = new Map<string, Set<string>>();
    private readonly rateLimiter: RateLimiterMemory;

    constructor(
        private readonly authService: AuthService,
        private readonly marketService: MarketService,
        private readonly redisService: RedisService,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.rateLimiter = new RateLimiterMemory({
            points: 100, // Number of points
            duration: 60, // Per 60 seconds
        });
    }

    async onModuleInit() {
        await this.initializeMarketDataStreams();
        this.startHeartbeat();
    }

    async onModuleDestroy() {
        this.server?.close();
        await this.cleanupConnections();
    }

    async handleConnection(client: Socket) {
        try {
            const token = client.handshake.auth.token;
            if (!token) {
                throw new Error('Authentication required');
            }

            const decoded = await this.authService.verifyToken(token);
            const userId = decoded.sub;

            // Rate limiting check
            try {
                await this.rateLimiter.consume(userId);
            } catch {
                client.disconnect(true);
                return;
            }

            // Store user session
            if (!this.userSessions.has(userId)) {
                this.userSessions.set(userId, new Set());
            }
            this.userSessions.get(userId)!.add(client.id);

            // Set client data
            client.data.userId = userId;
            client.data.authenticated = true;

            // Send initial state
            await this.sendInitialState(client);

            this.logger.log(`Client connected: ${client.id} (User: ${userId})`);
        } catch (error) {
            this.logger.error('Connection error', error);
            client.disconnect(true);
        }
    }

    handleDisconnect(client: Socket) {
        try {
            const userId = client.data.userId;
            if (userId) {
                const userSessions = this.userSessions.get(userId);
                if (userSessions) {
                    userSessions.delete(client.id);
                    if (userSessions.size === 0) {
                        this.userSessions.delete(userId);
                    }
                }
            }

            // Cleanup market subscriptions
            for (const [market, subscribers] of this.marketSubscriptions) {
                subscribers.delete(client.id);
                if (subscribers.size === 0) {
                    this.marketSubscriptions.delete(market);
                }
            }

            this.logger.log(`Client disconnected: ${client.id}`);
        } catch (error) {
            this.logger.error('Disconnect error', error);
        }
    }

    @SubscribeMessage('subscribe_market')
    async handleMarketSubscription(
        @ConnectedSocket() client: Socket,
        payload: { market: string }
    ): Promise<WsResponse<boolean>> {
        try {
            if (!client.data.authenticated) {
                throw new Error('Authentication required');
            }

            const { market } = payload;
            
            if (!this.marketSubscriptions.has(market)) {
                this.marketSubscriptions.set(market, new Set());
                await this.initializeMarketStream(market);
            }
            
            this.marketSubscriptions.get(market)!.add(client.id);

            // Send initial market data
            const marketData = await this.marketService.getMarketData(market);
            client.emit('market_update', {
                market,
                data: marketData
            });

            return { event: 'subscribe_market', data: true };
        } catch (error) {
            this.logger.error('Market subscription error', error);
            return { event: 'subscribe_market', data: false };
        }
    }

    @OnEvent('trade.executed')
    async handleTradeExecution(payload: any) {
        try {
            const { userId, tradeData, result } = payload;
            
            // Notify user's active sessions
            const userSessions = this.userSessions.get(userId);
            if (userSessions) {
                const message: WebSocketMessage<any> = {
                    type: 'trade_executed',
                    data: {
                        trade: tradeData,
                        result: result
                    }
                };

                for (const sessionId of userSessions) {
                    this.server.to(sessionId).emit('message', message);
                }
            }

            // Update market subscribers
            await this.broadcastMarketUpdate(tradeData.market);
        } catch (error) {
            this.logger.error('Trade execution notification error', error);
        }
    }

    @OnEvent('order.updated')
    async handleOrderUpdate(payload: OrderUpdateData) {
        try {
            const { userId, order } = payload;
            const userSessions = this.userSessions.get(userId);
            
            if (userSessions) {
                const message: WebSocketMessage<OrderUpdateData> = {
                    type: 'order_update',
                    data: payload
                };

                for (const sessionId of userSessions) {
                    this.server.to(sessionId).emit('message', message);
                }
            }
        } catch (error) {
            this.logger.error('Order update notification error', error);
        }
    }

    @OnEvent('wallet.updated')
    async handleWalletUpdate(payload: WalletUpdateData) {
        try {
            const { userId, wallet } = payload;
            const userSessions = this.userSessions.get(userId);
            
            if (userSessions) {
                const message: WebSocketMessage<WalletUpdateData> = {
                    type: 'wallet_update',
                    data: payload
                };

                for (const sessionId of userSessions) {
                    this.server.to(sessionId).emit('message', message);
                }
            }
        } catch (error) {
            this.logger.error('Wallet update notification error', error);
        }
    }

    private async initializeMarketDataStreams() {
        const activeMarkets = await this.marketService.getActiveMarkets();
        
        for (const market of activeMarkets) {
            await this.initializeMarketStream(market.address);
        }
    }

    private async initializeMarketStream(market: string) {
        this.marketService.subscribeToMarketUpdates(market, async (data: MarketUpdateData) => {
            await this.broadcastMarketUpdate(market, data);
        });
    }

    private async broadcastMarketUpdate(market: string, data?: MarketUpdateData) {
        const subscribers = this.marketSubscriptions.get(market);
        if (!subscribers) return;

        const marketData = data || await this.marketService.getMarketData(market);
        const message: WebSocketMessage<MarketUpdateData> = {
            type: 'market_update',
            data: marketData
        };

        for (const sessionId of subscribers) {
            this.server.to(sessionId).emit('message', message);
        }
    }

    private async sendInitialState(client: Socket) {
        const userId = client.data.userId;
        
        // Send active orders
        const activeOrders = await this.marketService.getUserActiveOrders(userId);
        client.emit('initial_state', {
            orders: activeOrders,
            timestamp: new Date()
        });
    }

    private startHeartbeat() {
        setInterval(() => {
            this.server.emit('heartbeat', { timestamp: new Date() });
        }, 30000); // Every 30 seconds
    }

    private async cleanupConnections() {
        this.userSessions.clear();
        this.marketSubscriptions.clear();
        await this.marketService.unsubscribeAllMarketUpdates();
    }
}
