// src/services/trading/pool-discovery.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID } from '@raydium-io/raydium-sdk';
import { EventEmitter } from 'events';
import { logger } from '../../config/logger';

export class PoolDiscovery extends EventEmitter {
    private startTimestamp: number;

    constructor(
        private readonly connection: Connection,
        private readonly config: {
            quoteMint: PublicKey;
            cacheNewMarkets: boolean;
        }
    ) {
        super();
        this.startTimestamp = Math.floor(Date.now() / 1000);
    }

    async start(): Promise<void> {
        try {
            // Subscribe to Raydium pools
            await this.subscribeToRaydiumPools();

            // Subscribe to OpenBook markets if caching enabled
            if (this.config.cacheNewMarkets) {
                await this.subscribeToOpenbookMarkets();
            }
        } catch (error) {
            logger.error('Error starting pool discovery:', error);
            throw error;
        }
    }

    private async subscribeToRaydiumPools(): Promise<number> {
        return this.connection.onProgramAccountChange(
            MAINNET_PROGRAM_ID.AmmV4,
            async (updatedAccountInfo) => {
                try {
                    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
                    const poolOpenTime = parseInt(poolState.poolOpenTime.toString());

                    // Check if pool is new
                    if (poolOpenTime > this.startTimestamp) {
                        this.emit('newPool', {
                            accountId: updatedAccountInfo.accountId,
                            state: poolState
                        });
                    }
                } catch (error) {
                    logger.error('Error processing pool update:', error);
                }
            },
            this.connection.commitment,
            [
                { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
                {
                    memcmp: {
                        offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
                        bytes: this.config.quoteMint.toBase58(),
                    },
                },
                {
                    memcmp: {
                        offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
                        bytes: MAINNET_PROGRAM_ID.OPENBOOK_MARKET.toBase58(),
                    },
                }
            ]
        );
    }

    private async subscribeToOpenbookMarkets(): Promise<number> {
        return this.connection.onProgramAccountChange(
            MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
            async (updatedAccountInfo) => {
                try {
                    this.emit('newMarket', {
                        accountId: updatedAccountInfo.accountId,
                        accountInfo: updatedAccountInfo.accountInfo
                    });
                } catch (error) {
                    logger.error('Error processing market update:', error);
                }
            },
            this.connection.commitment,
            [
                { dataSize: MARKET_STATE_LAYOUT_V3.span },
                {
                    memcmp: {
                        offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
                        bytes: this.config.quoteMint.toBase58(),
                    },
                }
            ]
        );
    }
}