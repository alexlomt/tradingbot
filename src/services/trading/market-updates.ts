// src/services/trading/market-updates.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { MarketCache } from './cache/market.cache';
import { MARKET_STATE_LAYOUT_V3, MinimalMarketLayoutV3 } from './types/market';
import { logger } from '../../config/logger';

export class MarketUpdates {
    constructor(
        private readonly connection: Connection,
        private readonly marketCache: MarketCache
    ) {}

    async handleMarketUpdate(accountId: PublicKey, accountInfo: AccountInfo<Buffer>): Promise<void> {
        try {
            const marketState = MARKET_STATE_LAYOUT_V3.decode(accountInfo.data);
            
            // Update cache
            await this.marketCache.save(accountId.toString(), this.extractMinimalMarket(marketState));
            
            logger.debug(`Updated market cache for ${accountId.toString()}`);
        } catch (error) {
            logger.error('Error handling market update:', error);
        }
    }

    private extractMinimalMarket(marketState: any): MinimalMarketLayoutV3 {
        return {
            eventQueue: marketState.eventQueue,
            bids: marketState.bids,
            asks: marketState.asks
        };
    }

    async getMinimalMarket(marketId: string): Promise<MinimalMarketLayoutV3> {
        try {
            const marketInfo = await this.connection.getAccountInfo(
                new PublicKey(marketId),
                this.connection.commitment
            );

            if (!marketInfo?.data) {
                throw new Error('Market not found');
            }

            return MARKET_STATE_LAYOUT_V3.decode(marketInfo.data);
        } catch (error) {
            logger.error('Error fetching market:', error);
            throw error;
        }
    }
}
