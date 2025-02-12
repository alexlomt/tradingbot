// src/websocket/manager.ts
import WebSocket from 'ws';
import { logger } from '../config/logger';

export class WebSocketManager {
    private connections: Map<string, Set<WebSocket>> = new Map();

    addConnection(userId: string, ws: WebSocket) {
        if (!this.connections.has(userId)) {
            this.connections.set(userId, new Set());
        }
        this.connections.get(userId)!.add(ws);
        
        logger.debug(`WebSocket connection added for user: ${userId}`);
    }

    removeConnection(userId: string, ws: WebSocket) {
        const userConnections = this.connections.get(userId);
        if (userConnections) {
            userConnections.delete(ws);
            if (userConnections.size === 0) {
                this.connections.delete(userId);
            }
        }
        
        logger.debug(`WebSocket connection removed for user: ${userId}`);
    }

    broadcast(userId: string, message: any) {
        const userConnections = this.connections.get(userId);
        if (!userConnections) return;

        userConnections.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify(message));
                } catch (error) {
                    logger.error('Error broadcasting message:', error);
                }
            }
        });
    }

    broadcastToAll(message: any) {
        this.connections.forEach((connections, userId) => {
            this.broadcast(userId, message);
        });
    }

    getConnectionCount(userId: string): number {
        return this.connections.get(userId)?.size || 0;
    }

    getTotalConnections(): number {
        let total = 0;
        this.connections.forEach(connections => {
            total += connections.size;
        });
        return total;
    }
}
