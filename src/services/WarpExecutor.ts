import {
    Connection,
    VersionedTransaction,
    PublicKey,
} from '@solana/web3.js';
import {
    TransactionConfig,
    TransactionResult,
    UserSubscription
} from '../types/trading.types';
import { logger } from '../utils/logger';
import { ErrorReporter } from '../utils/errorReporting';
import { RateLimiter } from '../utils/RateLimiter';
import axios from 'axios';

export class WarpExecutor {
    private readonly rateLimiter: RateLimiter;
    private readonly endpoints: {
        transaction: string;
        status: string;
    };

    constructor(
        private readonly connection: Connection,
        private readonly apiKey: string,
        private readonly baseUrl: string = 'https://api.warp.com/v1'
    ) {
        this.rateLimiter = new RateLimiter({
            maxRequests: 20,
            timeWindow: 1000
        });

        this.endpoints = {
            transaction: `${this.baseUrl}/transaction`,
            status: `${this.baseUrl}/transaction/status`
        };
    }

    async executeTransaction(
        transaction: VersionedTransaction,
        config: TransactionConfig,
        subscription?: UserSubscription
    ): Promise<TransactionResult> {
        try {
            await this.rateLimiter.checkLimit();

            const serializedTx = transaction.serialize();
            const signature = await this.submitToWarp(
                serializedTx,
                config,
                subscription
            );

            const result = await this.waitForConfirmation(
                signature,
                config
            );

            if (!result.success) {
                throw new Error(`Warp transaction failed: ${result.error}`);
            }

            return result;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'WarpExecutor.executeTransaction',
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

    private async submitToWarp(
        serializedTx: Buffer,
        config: TransactionConfig,
        subscription?: UserSubscription
    ): Promise<string> {
        try {
            const response = await axios.post(
                this.endpoints.transaction,
                {
                    transaction: serializedTx.toString('base64'),
                    config: {
                        priorityFee: config.priorityFee,
                        computeUnits: config.computeUnitLimit,
                        skipPreflight: config.skipPreflight,
                        subscription: subscription?.planId
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.error) {
                throw new Error(response.data.error);
            }

            return response.data.signature;
        } catch (error) {
            logger.error('Warp submission error:', error);
            throw error;
        }
    }

    private async waitForConfirmation(
        signature: string,
        config: TransactionConfig
    ): Promise<TransactionResult> {
        const startTime = Date.now();
        const maxTimeout = config.maxTimeout || 30000;

        while (Date.now() - startTime < maxTimeout) {
            try {
                const status = await this.checkTransactionStatus(signature);

                if (status.confirmed) {
                    return {
                        signature,
                        success: true,
                        blockTime: status.blockTime,
                        fee: status.fee,
                        confirmations: status.confirmations
                    };
                }

                if (status.error) {
                    return {
                        signature,
                        success: false,
                        error: status.error
                    };
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                logger.error('Error checking transaction status:', error);
            }
        }

        return {
            signature,
            success: false,
            error: 'Transaction confirmation timeout'
        };
    }

    private async checkTransactionStatus(
        signature: string
    ): Promise<{
        confirmed: boolean;
        blockTime?: number;
        fee?: number;
        confirmations?: number;
        error?: string;
    }> {
        try {
            const response = await axios.get(
                `${this.endpoints.status}/${signature}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`
                    }
                }
            );

            return {
                confirmed: response.data.confirmed,
                blockTime: response.data.blockTime,
                fee: response.data.fee,
                confirmations: response.data.confirmations,
                error: response.data.error
            };
        } catch (error) {
            logger.error('Error checking Warp status:', error);
            throw error;
        }
    }
}
