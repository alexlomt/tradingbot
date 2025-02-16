import { 
    Connection, 
    PublicKey,
    AccountInfo,
    Context,
    KeyedAccountInfo
} from '@solana/web3.js';
import { EventEmitter } from 'events';
import { Token } from '@raydium-io/raydium-sdk';
import { logger } from '../utils/logger';

export class MarketListenerService extends EventEmitter {
    private subscriptions: Map<string, number>;
    
    constructor(
        private readonly connection: Connection
    ) {
        super();
        this.subscriptions = new Map();
    }

    async start(config: {
        walletPublicKey: PublicKey;
        quoteToken: Token;
        autoSell: boolean;
        cacheNewMarkets: boolean;
    }): Promise<void> {
        try {
            // Subscribe to market updates
            this.subscribeToMarkets(config.quoteToken);
            
            // Subscribe to pool updates if auto-sell is enabled
            if (config.autoSell) {
                this.subscribeToPools();
            }

            // Subscribe to wallet updates
            this.subscribeToWallet(config.walletPublicKey);

            logger.info('Market listener service started successfully');
        } catch (error) {
            logger.error('Failed to start market listener:', error);
            throw error;
        }
    }

    private async subscribeToMarkets(quoteToken: Token): Promise<void> {
        const subscription = this.connection.onProgramAccountChange(
            new PublicKey(quoteToken.programId),
            (accountInfo: KeyedAccountInfo) => {
                this.emit('market', accountInfo);
            }
        );
        
        this.subscriptions.set('markets', subscription);
    }

    private async subscribeToPools(): Promise<void> {
        // Add pool subscription logic
    }

    private async subscribeToWallet(walletPublicKey: PublicKey): Promise<void> {
        // Add wallet subscription logic
    }

    public stop(): void {
        for (const [key, subscription] of this.subscriptions) {
            this.connection.removeAccountChangeListener(subscription);
            this.subscriptions.delete(key);
        }
        
        this.removeAllListeners();
        logger.info('Market listener service stopped');
    }
}
