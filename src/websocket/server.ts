// src/websocket/server.ts
import WebSocket from 'ws';
import { verify } from 'jsonwebtoken';
import { WebSocketManager } from './manager';
import { WebSocketMessageHandler } from './message-handler';
import { RateLimiter } from '../services/security/rate-limiter';
import { logger } from '../config/logger';

interface AuthenticatedWebSocket extends WebSocket {
    userId?: string;
    isAlive?: boolean;
}

export class WebSocketServer {
    private wsManager: WebSocketManager;
    private messageHandler: WebSocketMessageHandler;
    private rateLimiter: RateLimiter;
    private pingInterval: NodeJS.Timeout;

    constructor(private readonly wss: WebSocket.Server) {
        this.wsManager = new WebSocketManager();
        this.messageHandler = new WebSocketMessageHandler();
        this.rateLimiter = new RateLimiter();
        this.init();
    }

    private init() {
        this.wss.on('connection', this.handleConnection.bind(this));
        this.setupHeartbeat();
    }

    private async handleConnection(ws: AuthenticatedWebSocket, req: any) {
        try {
            // Authenticate connection
            const token = req.headers['sec-websocket-protocol'];
            if (!token) {
                ws.close(4001, 'Authentication required');
                return;
            }

            const decoded = verify(token, process.env.JWT_SECRET!) as { userId: string };
            ws.userId = decoded.userId;

            // Check rate limits
            if (!this.rateLimiter.checkLimit(req.socket.remoteAddress)) {
                ws.close(4029, 'Rate limit exceeded');
                return;
            }

            // Initialize connection
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });
            
            // Add to connection manager
            this.wsManager.addConnection(decoded.userId, ws);

            // Set up message handling
            ws.on('message', async (message: string) => {
                try {
                    await this.handleMessage(ws, message);
                } catch (error) {
                    logger.error('Error handling WebSocket message:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        data: { message: 'Error processing message' }
                    }));
                }
            });

            // Handle disconnection
            ws.on('close', () => {
                this.wsManager.removeConnection(decoded.userId, ws);
            });

            // Send initial state
            await this.sendInitialState(ws);

        } catch (error) {
            logger.error('WebSocket connection error:', error);
            ws.close(4000, 'Connection error');
        }
    }

    private async handleMessage(ws: AuthenticatedWebSocket, message: string) {
        if (!ws.userId) return;

        try {
            const data = JSON.parse(message);
            await this.messageHandler.handleMessage(ws.userId, data);
        } catch (error) {
            logger.error('Error parsing WebSocket message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: 'Invalid message format' }
            }));
        }
    }

    private async sendInitialState(ws: AuthenticatedWebSocket) {
        if (!ws.userId) return;

        try {
            const state = await this.messageHandler.getInitialState(ws.userId);
            ws.send(JSON.stringify({
                type: 'initialState',
                data: state
            }));
        } catch (error) {
            logger.error('Error sending initial state:', error);
        }
    }

    private setupHeartbeat() {
        this.pingInterval = setInterval(() => {
            this.wss.clients.forEach((ws: AuthenticatedWebSocket) => {
                if (ws.isAlive === false) {
                    ws.terminate();
                    return;
                }

                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);

        this.wss.on('close', () => {
            clearInterval(this.pingInterval);
        });
    }
}