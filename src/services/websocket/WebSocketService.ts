import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { Subject, BehaviorSubject } from 'rxjs';
import { WebSocket } from 'ws';
import { MarketEvent, MarketEventType, MarketChannel } from '../../types/market.types';
import { RetryStrategy } from '../../utils/RetryStrategy';

interface WebSocketConnection {
    ws: WebSocket;
    url: string;
    isAlive: boolean;
    subscriptions: Set<string>;
    reconnectAttempts: number;
}

@Injectable()
export class WebSocketService implements OnModuleInit, OnModuleDestroy {
    private connections: Map<string, WebSocketConnection> = new Map();
    private messageSubject = new Subject<MarketEvent>();
    private connectionStatus = new BehaviorSubject<boolean>(false);
    
    private readonly PING_INTERVAL = 30000;
    private readonly MAX_RECONNECT_ATTEMPTS = 5;
    private readonly INITIAL_RECONNECT_DELAY = 1000;
    private readonly MAX_RECONNECT_DELAY = 30000;
    private pingInterval: NodeJS.Timeout;

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService
    ) {}

    async onModuleInit() {
        await this.initializeConnections();
        this.startPingInterval();
    }

    async onModuleDestroy() {
        this.stopPingInterval();
        await this.closeAllConnections();
    }

    private async initializeConnections() {
        const endpoints = this.configService.get<string[]>('WEBSOCKET_ENDPOINTS');
        
        for (const endpoint of endpoints) {
            await this.createConnection(endpoint);
        }
    }

    private async createConnection(url: string): Promise<WebSocketConnection> {
        try {
            const ws = new WebSocket(url, {
                handshakeTimeout: 10000,
                perMessageDeflate: true,
                headers: this.getAuthHeaders()
            });

            const connection: WebSocketConnection = {
                ws,
                url,
                isAlive: false,
                subscriptions: new Set(),
                reconnectAttempts: 0
            };

            this.setupWebSocketHandlers(connection);
            this.connections.set(url, connection);

            await this.waitForConnection(connection);
            return connection;
        } catch (error) {
            await this.handleError('createConnection', error, { url });
            throw error;
        }
    }

    private setupWebSocketHandlers(connection: WebSocketConnection) {
        const { ws, url } = connection;

        ws.on('open', async () => {
            connection.isAlive = true;
            connection.reconnectAttempts = 0;
            this.connectionStatus.next(true);
            
            await this.auditService.logSystemEvent({
                event: 'WEBSOCKET_CONNECTED',
                details: { url },
                severity: 'INFO'
            });

            // Resubscribe to channels after reconnection
            await this.resubscribeChannels(connection);
        });

        ws.on('message', async (data: Buffer) => {
            try {
                const message = JSON.parse(data.toString());
                await this.handleMessage(message);
                await this.metricsService.recordWebSocketMessage(message.type);
            } catch (error) {
                await this.handleError('messageHandler', error, { url });
            }
        });

        ws.on('pong', () => {
            connection.isAlive = true;
        });

        ws.on('error', async (error) => {
            await this.handleError('websocketError', error, { url });
        });

        ws.on('close', async () => {
            connection.isAlive = false;
            this.connectionStatus.next(false);
            
            await this.auditService.logSystemEvent({
                event: 'WEBSOCKET_DISCONNECTED',
                details: { url },
                severity: 'WARNING'
            });

            await this.handleReconnection(connection);
        });
    }

    private async handleReconnection(connection: WebSocketConnection) {
        if (connection.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            await this.auditService.logSystemEvent({
                event: 'WEBSOCKET_RECONNECTION_FAILED',
                details: {
                    url: connection.url,
                    attempts: connection.reconnectAttempts
                },
                severity: 'ERROR'
            });
            return;
        }

        const delay = RetryStrategy.exponentialBackoff(
            connection.reconnectAttempts,
            this.INITIAL_RECONNECT_DELAY,
            this.MAX_RECONNECT_DELAY
        );

        connection.reconnectAttempts++;

        setTimeout(async () => {
            try {
                await this.createConnection(connection.url);
            } catch (error) {
                await this.handleError('reconnection', error, { url: connection.url });
            }
        }, delay);
    }

    async subscribe(channel: string, callback: (data: any) => void): Promise<void> {
        const connection = this.getOptimalConnection();
        if (!connection) {
            throw new Error('No available WebSocket connections');
        }

        try {
            const subscribeMessage = {
                type: 'subscribe',
                channel,
                auth: this.getAuthToken()
            };

            connection.ws.send(JSON.stringify(subscribeMessage));
            connection.subscriptions.add(channel);

            this.messageSubject.subscribe((event: MarketEvent) => {
                if (event.type === channel) {
                    callback(event.data);
                }
            });

            await this.auditService.logSystemEvent({
                event: 'WEBSOCKET_SUBSCRIBED',
                details: { channel },
                severity: 'INFO'
            });
        } catch (error) {
            await this.handleError('subscribe', error, { channel });
            throw error;
        }
    }

    async unsubscribe(channel: string): Promise<void> {
        for (const connection of this.connections.values()) {
            if (connection.subscriptions.has(channel)) {
                try {
                    const unsubscribeMessage = {
                        type: 'unsubscribe',
                        channel
                    };

                    connection.ws.send(JSON.stringify(unsubscribeMessage));
                    connection.subscriptions.delete(channel);

                    await this.auditService.logSystemEvent({
                        event: 'WEBSOCKET_UNSUBSCRIBED',
                        details: { channel },
                        severity: 'INFO'
                    });
                } catch (error) {
                    await this.handleError('unsubscribe', error, { channel });
                }
            }
        }
    }

    private async handleMessage(message: any) {
        if (message.type === 'error') {
            await this.handleError('serverError', new Error(message.message), message);
            return;
        }

        const event: MarketEvent = {
            type: message.type as MarketEventType,
            market: message.market,
            timestamp: Date.now(),
            data: message.data
        };

        this.messageSubject.next(event);
    }

    private startPingInterval() {
        this.pingInterval = setInterval(() => {
            for (const connection of this.connections.values()) {
                if (!connection.isAlive) {
                    connection.ws.terminate();
                    continue;
                }

                connection.isAlive = false;
                connection.ws.ping();
            }
        }, this.PING_INTERVAL);
    }

    private stopPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
    }

    private async closeAllConnections() {
        for (const connection of this.connections.values()) {
            connection.ws.close();
        }
        this.connections.clear();
    }

    private getOptimalConnection(): WebSocketConnection | null {
        // Simple round-robin selection for now
        // Could be enhanced with load balancing metrics
        for (const connection of this.connections.values()) {
            if (connection.isAlive) {
                return connection;
            }
        }
        return null;
    }

    private async resubscribeChannels(connection: WebSocketConnection) {
        for (const channel of connection.subscriptions) {
            try {
                const subscribeMessage = {
                    type: 'subscribe',
                    channel,
                    auth: this.getAuthToken()
                };
                connection.ws.send(JSON.stringify(subscribeMessage));
            } catch (error) {
                await this.handleError('resubscribe', error, { channel });
            }
        }
    }

    private getAuthHeaders(): Record<string, string> {
        return {
            'Authorization': `Bearer ${this.getAuthToken()}`,
            'X-API-Key': this.configService.get<string>('API_KEY')
        };
    }

    private getAuthToken(): string {
        return this.configService.get<string>('AUTH_TOKEN');
    }

    private async handleError(
        operation: string,
        error: Error,
        context: any
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'WEBSOCKET_ERROR',
            details: {
                operation,
                error: error.message,
                context
            },
            severity: 'ERROR'
        });
        await this.metricsService.incrementWebSocketError(operation);
    }

    private waitForConnection(connection: WebSocketConnection): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('WebSocket connection timeout'));
            }, 10000);

            connection.ws.once('open', () => {
                clearTimeout(timeout);
                resolve();
            });

            connection.ws.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }
}
