import {
    Connection,
    VersionedTransaction,
    PublicKey,
    ComputeBudgetProgram,
} from '@solana/web3.js';
import {
    TransactionConfig,
    TransactionResult,
    UserSubscription
} from '../types/trading.types';
import { logger } from '../utils/logger';
import { ErrorReporter } from '../utils/errorReporting';
import { RateLimiter } from '../utils/RateLimiter';
import { Cache } from '../utils/Cache';
import { BN } from 'bn.js';
import WebSocket from 'ws';

export class JitoExecutor {
    private readonly rateLimiter: RateLimiter;
    private readonly blockCache: Cache<string, { slot: number; leader: string }>;
    private ws: WebSocket | null = null;
    private readonly pendingTransactions: Map<string, {
        resolve: (value: TransactionResult) => void;
        reject: (error: Error) => void;
        timestamp: number;
    }>;

    constructor(
        private readonly connection: Connection,
        private readonly apiKey: string,
        private readonly jitoUrl: string,
        private readonly websocketUrl: string,
        private readonly region: string = 'us-east-1'
    ) {
        this.rateLimiter = new RateLimiter({
            maxRequests: 25,
            timeWindow: 1000
        });
        this.blockCache = new Cache<string, any>(5000); // 5 seconds cache
        this.pendingTransactions = new Map();
        this.initializeWebSocket();
    }

    private initializeWebSocket(): void {
        this.ws = new WebSocket(this.websocketUrl);

        this.ws.on('open', () => {
            logger.info('Connected to Jito websocket');
            this.subscribeToBlocks();
        });

        this.ws.on('message', (data: string) => {
            try {
                const message = JSON.parse(data);
                this.handleWebSocketMessage(message);
            } catch (error) {
                logger.error('Error processing websocket message:', error);
            }
        });

        this.ws.on('error', (error) => {
            logger.error('Jito websocket error:', error);
            this.reconnectWebSocket();
        });

        this.ws.on('close', () => {
            logger.warn('Jito websocket closed, attempting to reconnect...');
            this.reconnectWebSocket();
        });
    }

    private reconnectWebSocket(): void {
        setTimeout(() => {
            if (this.ws?.readyState === WebSocket.CLOSED) {
                this.initializeWebSocket();
            }
        }, 5000);
    }

    private subscribeToBlocks(): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                method: 'subscribe',
                params: ['blocks', 'transactions'],
                id: Date.now()
            }));
        }
    }

    private handleWebSocketMessage(message: any): void {
        if (message.method === 'block') {
            this.handleBlockUpdate(message.params);
        } else if (message.method === 'transaction') {
            this.handleTransactionUpdate(message.params);
        }
    }

    private handleBlockUpdate(params: any): void {
        this.blockCache.set(params.slot.toString(), {
            slot: params.slot,
            leader: params.leader
        });
    }

    private handleTransactionUpdate(params: any): void {
        const pending = this.pendingTransactions.get(params.signature);
        if (!pending) return;

        if (params.success) {
            pending.resolve({
                signature: params.signature,
                success: true,
                blockTime: params.blockTime,
                fee: params.fee,
                slot: params.slot
            });
        } else {
            pending.reject(new Error(params.error || 'Transaction failed'));
        }

        this.pendingTransactions.delete(params.signature);
    }

    async executeTransaction(
        transaction: VersionedTransaction,
        config: TransactionConfig,
        subscription?: UserSubscription
    ): Promise<TransactionResult> {
        try {
            await this.rateLimiter.checkLimit();

            const bundle = await this.prepareBundleTransaction(
                transaction,
                config,
                subscription
            );

            const signature = await this.submitToJito(bundle);
            const result = await this.waitForConfirmation(signature, config);

            if (!result.success) {
                throw new Error(`Jito transaction failed: ${result.error}`);
            }

            return result;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'JitoExecutor.executeTransaction',
                config,
                subscription: subscription?.userId
            });

            return {
                signature: '',
                success: false,
                error: error.message
            };
        }
    }

    private async prepareBundleTransaction(
        transaction: VersionedTransaction,
        config: TransactionConfig,
        subscription?: UserSubscription
    ): Promise<Buffer> {
        const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: subscription?.features.priority
                ? config.priorityFee * 2
                : config.priorityFee
        });

        const message = transaction.message;
        message.instructions.unshift(priorityFeeIx);

        const bundle = Buffer.from(transaction.serialize());
        return bundle;
    }

    private async submitToJito(
        bundleBuffer: Buffer
    ): Promise<string> {
        const response = await fetch(`${this.jitoUrl}/v1/transactions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'X-Region': this.region
            },
            body: JSON.stringify({
                transaction: bundleBuffer.toString('base64'),
                skipPreflight: true
            })
        });

        if (!response.ok) {
            throw new Error(`Jito submission failed: ${await response.text()}`);
        }

        const result = await response.json();
        return result.signature;
    }

    private waitForConfirmation(
        signature: string,
        config: TransactionConfig
    ): Promise<TransactionResult> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingTransactions.delete(signature);
                reject(new Error('Transaction confirmation timeout'));
            }, config.maxTimeout || 30000);

            this.pendingTransactions.set(signature, {
                resolve: (result) => {
                    clearTimeout(timeout);
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
                timestamp: Date.now()
            });
        });
    }

    public cleanup(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.blockCache.clear();
        this.pendingTransactions.clear();
    }
}
