import {
    Connection,
    PublicKey,
    AccountInfo,
    Context,
    KeyedAccountInfo,
} from '@solana/web3.js';
import {
    MARKET_STATE_LAYOUT_V3,
    LIQUIDITY_STATE_LAYOUT_V4,
    Token,
    LiquidityStateV4
} from '@raydium-io/raydium-sdk';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { Cache } from '../utils/Cache';
import { ErrorReporter } from '../utils/errorReporting';

export interface MarketEventConfig {
    walletPublicKey: PublicKey;
    quoteToken: Token;
    autoSell: boolean;
    cacheNewMarkets: boolean;
    startTimestamp?: number;
}

export class MarketEventService extends EventEmitter {
    private readonly subscriptions: Map<string, number>;
    private readonly marketCache: Cache<string, any>;
    private readonly poolCache: Cache<string, LiquidityStateV4>;
    private isRunning: boolean = false;

    constructor(
        private readonly connection: Connection,
        private readonly cacheDuration: number = 300000 // 5 minutes
    ) {
        super();
        this.subscriptions = new Map();
        this.marketCache = new Cache<string, any>(cacheDuration);
        this.poolCache = new Cache<string, LiquidityStateV4>(cacheDuration);
    }

    async start(config: MarketEventConfig): Promise<void> {
        if (this.isRunning) {
            logger.warn('Market event service is already running');
            return;
        }

        try {
            this.isRunning = true;

            await Promise.all([
                this.subscribeToMarketUpdates(config),
                this.subscribeToPoolUpdates(config),
                this.subscribeToWalletUpdates(config)
            ]);

            logger.info('Market event service started successfully');
        } catch (error) {
            this.isRunning = false;
            ErrorReporter.reportError(error, {
                context: 'MarketEventService.start',
                config
            });
            throw error;
        }
    }

    private async subscribeToMarketUpdates(config: MarketEventConfig): Promise<void> {
        try {
            const marketSubscription = this.connection.onProgramAccountChange(
                new PublicKey(config.quoteToken.programId),
                (accountInfo: KeyedAccountInfo) => {
                    try {
                        const marketState = MARKET_STATE_LAYOUT_V3.decode(
                            accountInfo.accountInfo.data
                        );
                        
                        if (config.cacheNewMarkets) {
                            this.marketCache.set(
                                accountInfo.accountId.toString(),
                                marketState
                            );
                        }

                        this.emit('market:update', {
                            address: accountInfo.accountId,
                            state: marketState,
                            timestamp: new Date()
                        });
                    } catch (error) {
                        logger.error('Error processing market update:', error);
                    }
                },
                'confirmed'
            );

            this.subscriptions.set('market', marketSubscription);
        } catch (error) {
            logger.error('Error subscribing to market updates:', error);
            throw error;
        }
    }

    private async subscribeToPoolUpdates(config: MarketEventConfig): Promise<void> {
        try {
            const poolSubscription = this.connection.onProgramAccountChange(
                new PublicKey(TOKEN_PROGRAM_ID),
                async (accountInfo: KeyedAccountInfo) => {
                    try {
                        const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(
                            accountInfo.accountInfo.data
                        );

                        const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
                        const shouldProcess = !config.startTimestamp || 
                                           poolOpenTime > config.startTimestamp;

                        if (shouldProcess) {
                            this.poolCache.set(
                                accountInfo.accountId.toString(),
                                poolState
                            );

                            this.emit('pool:new', {
                                address: accountInfo.accountId,
                                state: poolState,
                                timestamp: new Date()
                            });
                        }
                    } catch (error) {
                        // Ignore decoding errors for non-pool accounts
                        if (!(error instanceof Error && error.message.includes('Invalid data'))) {
                            logger.error('Error processing pool update:', error);
                        }
                    }
                },
                'confirmed'
            );

            this.subscriptions.set('pool', poolSubscription);
        } catch (error) {
            logger.error('Error subscribing to pool updates:', error);
            throw error;
        }
    }

    private async subscribeToWalletUpdates(config: MarketEventConfig): Promise<void> {
        try {
            const walletSubscription = this.connection.onProgramAccountChange(
                new PublicKey(TOKEN_PROGRAM_ID),
                (accountInfo: KeyedAccountInfo) => {
                    try {
                        const accountData = AccountLayout.decode(
                            accountInfo.accountInfo.data
                        );

                        if (!accountData.owner.equals(config.walletPublicKey)) {
                            return;
                        }

                        if (accountData.mint.equals(config.quoteToken.mint)) {
                            return;
                        }

                        this.emit('wallet:update', {
                            address: accountInfo.accountId,
                            data: accountData,
                            timestamp: new Date()
                        });
                    } catch (error) {
                        logger.error('Error processing wallet update:', error);
                    }
                },
                'confirmed'
            );

            this.subscriptions.set('wallet', walletSubscription);
        } catch (error) {
            logger.error('Error subscribing to wallet updates:', error);
            throw error;
        }
    }

    public stop(): void {
        if (!this.isRunning) return;

        for (const [key, subscription] of this.subscriptions) {
            this.connection.removeAccountChangeListener(subscription);
            this.subscriptions.delete(key);
        }

        this.marketCache.clear();
        this.poolCache.clear();
        this.removeAllListeners();
        this.isRunning = false;

        logger.info('Market event service stopped');
    }

    public getMarketState(address: string): any {
        return this.marketCache.get(address);
    }

    public getPoolState(address: string): LiquidityStateV4 | null {
        return this.poolCache.get(address);
    }
}
