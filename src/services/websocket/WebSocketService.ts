import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { w3cwebsocket as W3CWebSocket } from 'websocket';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { Subject, BehaviorSubject, interval, Observable } from 'rxjs';
import { filter, map, retryWhen, delay, take } from 'rxjs/operators';
import { MarketData, OrderBookUpdate, TradeUpdate } from '../../types/market.types';
import { Decimal } from 'decimal.js';

interface WebSocketMessage {
    type: string;
    market: string;
    data: any;
}

@Injectable()
export class WebSocketService implements OnModuleInit, OnModuleDestroy {
    private ws: W3CWebSocket;
    private readonly connection: Connection;
    private readonly messageSubject = new Subject<WebSocketMessage>();
    private readonly connectionStatus = new BehaviorSubject<boolean>(false);
    private readonly subscriptions = new Map<string, Set<string>>();
    private readonly markets = new Map<string, Market>();
    private readonly MAX_RECONNECT_ATTEMPTS = 5;
    private readonly PING_INTERVAL = 30000; // 30 seconds
    private readonly RECONNECT_DELAY = 5000; // 5 seconds

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService
    ) {
        this.connection = new Connection(
            this.configService.get<string>('SOLANA_RPC_WEBSOCKET_URL'),
            'confirmed'
        );
    }

    async onModuleInit() {
        await this.initializeWebSocket();
        this.startHeartbeat();
    }

    onModuleDestroy() {
        this.closeConnection();
    }

    private async initializeWebSocket() {
        try {
            const url = this.configService.get<string>('WEBSOCKET_URL');
            this.ws = new W3CWebSocket(url, {
                headers: {
                    'Auth-Key': this.configService.get<string>('WEBSOCKET_AUTH_KEY')
                }
            });

            this.ws.onopen = () => {
                this.connectionStatus.next(true);
                this.resubscribeAll();
                this.auditService.logSystemEvent({
                    event: 'WEBSOCKET_CONNECTED',
                    details: { url },
                    severity: 'INFO'
                });
            };

            this.ws.onclose = async () => {
                this.connectionStatus.next(false);
                await this.handleDisconnect();
            };

            this.ws.onerror = async (error) => {
                await this.handleError('websocket_error', error);
            };

            this.ws.onmessage = (message) => {
                try {
                    const data = JSON.parse(message.data as string);
                    this.messageSubject.next(data);
                } catch (error) {
                    this.handleError('message_parse', error);
                }
            };

        } catch (error) {
            await this.handleError('initialization', error);
        }
    }

    private async handleDisconnect() {
        await this.auditService.logSystemEvent({
            event: 'WEBSOCKET_DISCONNECTED',
            details: { timestamp: new Date() },
            severity: 'WARNING'
        });

        let attempts = 0;
        while (attempts < this.MAX_RECONNECT_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, this.RECONNECT_DELAY));
            try {
                await this.initializeWebSocket();
                if (this.connectionStatus.value) {
                    return;
                }
            } catch (error) {
                attempts++;
            }
        }

        await this.auditService.logSystemEvent({
            event: 'WEBSOCKET_RECONNECT_FAILED',
            details: { attempts },
            severity: 'CRITICAL'
        });
    }

    private startHeartbeat() {
        interval(this.PING_INTERVAL).subscribe(() => {
            if (this.connectionStatus.value) {
                this.send({ type: 'ping' });
            }
        });
    }

    async subscribe(
        market: string,
        channels: string[]
    ): Promise<boolean> {
        try {
            if (!this.subscriptions.has(market)) {
                this.subscriptions.set(market, new Set());
            }

            const marketSubs = this.subscriptions.get(market);
            channels.forEach(channel => marketSubs.add(channel));

            if (this.connectionStatus.value) {
                await this.send({
                    type: 'subscribe',
                    market,
                    channels
                });
            }

            await this.metricsService.incrementSubscription(market);
            return true;
        } catch (error) {
            await this.handleError('subscribe', error);
            return false;
        }
    }

    async unsubscribe(
        market: string,
        channels: string[]
    ): Promise<boolean> {
        try {
            const marketSubs = this.subscriptions.get(market);
            if (!marketSubs) return true;

            channels.forEach(channel => marketSubs.delete(channel));
            
            if (marketSubs.size === 0) {
                this.subscriptions.delete(market);
            }

            if (this.connectionStatus.value) {
                await this.send({
                    type: 'unsubscribe',
                    market,
                    channels
                });
            }

            return true;
        } catch (error) {
            await this.handleError('unsubscribe', error);
            return false;
        }
    }

    getOrderBookUpdates(market: string): Observable<OrderBookUpdate> {
        return this.messageSubject.pipe(
            filter(msg => 
                msg.type === 'orderbook' && 
                msg.market === market
            ),
            map(msg => ({
                bids: msg.data.bids.map(this.processLevel),
                asks: msg.data.asks.map(this.processLevel)
            }))
        );
    }

    getTradeUpdates(market: string): Observable<TradeUpdate> {
        return this.messageSubject.pipe(
            filter(msg => 
                msg.type === 'trade' && 
                msg.market === market
            ),
            map(msg => ({
                price: new Decimal(msg.data.price),
                size: new Decimal(msg.data.size),
                side: msg.data.side,
                timestamp: new Date(msg.data.timestamp)
            }))
        );
    }

    getMarketData(market: string): Observable<MarketData> {
        return this.messageSubject.pipe(
            filter(msg => 
                msg.type === 'ticker' && 
                msg.market === market
            ),
            map(msg => ({
                lastPrice: new Decimal(msg.data.lastPrice),
                bidPrice: new Decimal(msg.data.bidPrice),
                askPrice: new Decimal(msg.data.askPrice),
                volume24h: new Decimal(msg.data.volume24h),
                priceChange24h: new Decimal(msg.data.priceChange24h),
                highPrice24h: new Decimal(msg.data.highPrice24h),
                lowPrice24h: new Decimal(msg.data.lowPrice24h)
            }))
        );
    }

    private async send(message: any): Promise<void> {
        if (!this.connectionStatus.value) {
            throw new Error('WebSocket not connected');
        }

        try {
            this.ws.send(JSON.stringify(message));
        } catch (error) {
            await this.handleError('send_message', error);
            throw error;
        }
    }

    private async resubscribeAll() {
        for (const [market, channels] of this.subscriptions.entries()) {
            await this.send({
                type: 'subscribe',
                market,
                channels: Array.from(channels)
            });
        }
    }

    private processLevel(level: [string, string]): [Decimal, Decimal] {
        return [
            new Decimal(level[0]), // price
            new Decimal(level[1])  // size
        ];
    }

    private async handleError(
        operation: string,
        error: Error
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'WEBSOCKET_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('websocket');
    }

    getConnectionStatus(): Observable<boolean> {
        return this.connectionStatus.asObservable();
    }
}
