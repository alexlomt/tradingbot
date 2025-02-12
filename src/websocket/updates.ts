// src/websocket/updates.ts
import { EventEmitter } from 'events';
import { WebSocketManager } from './manager';
import { logger } from '../config/logger';

export class UpdatesManager extends EventEmitter {
    constructor(private readonly wsManager: WebSocketManager) {
        super();
        this.setupListeners();
    }

    private setupListeners() {
        // Bot status updates
        this.on('botStatus', (data) => {
            this.wsManager.broadcast(data.userId, {
                type: 'botUpdate',
                data: {
                    botId: data.botId,
                    status: data.status,
                    timestamp: new Date()
                }
            });
        });

        // Trade execution updates
        this.on('tradeExecution', (data) => {
            this.wsManager.broadcast(data.userId, {
                type: 'tradeExecution',
                data: {
                    botId: data.botId,
                    type: data.type,
                    tokenMint: data.tokenMint,
                    amount: data.amount,
                    price: data.price,
                    signature: data.signature,
                    timestamp: new Date()
                }
            });
        });

        // Filter results
        this.on('filterResult', (data) => {
            this.wsManager.broadcast(data.userId, {
                type: 'filterResult',
                data: {
                    botId: data.botId,
                    tokenMint: data.tokenMint,
                    results: data.results,
                    timestamp: new Date()
                }
            });
        });

        // Error notifications
        this.on('error', (data) => {
            this.wsManager.broadcast(data.userId, {
                type: 'error',
                data: {
                    botId: data.botId,
                    message: data.message,
                    timestamp: new Date()
                }
            });
        });
    }
}