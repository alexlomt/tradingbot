// src/services/trading/price-tracker.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { Liquidity, LiquidityPoolKeysV4, Token, TokenAmount, Percent } from '@raydium-io/raydium-sdk';
import BN from 'bn.js';
import { EventEmitter } from 'events';
import { logger } from '../../config/logger';

interface PriceConfig {
    takeProfit: number;
    stopLoss: number;
    priceCheckInterval: number;
    priceCheckDuration: number;
}

export class PriceTracker extends EventEmitter {
    private tracking: Map<string, {
        startPrice: BN;
        lastCheck: number;
        checkCount: number;
    }> = new Map();

    constructor(
        private readonly connection: Connection,
        private readonly config: PriceConfig
    ) {
        super();
    }

    async startTracking(
        poolKeys: LiquidityPoolKeysV4,
        amountIn: TokenAmount,
        tokenOut: Token
    ): Promise<void> {
        const tokenMint = poolKeys.baseMint.toString();
        
        try {
            // Get initial price
            const initialPrice = await this.getCurrentPrice(poolKeys, amountIn, tokenOut);
            
            this.tracking.set(tokenMint, {
                startPrice: initialPrice,
                lastCheck: Date.now(),
                checkCount: 0
            });

            this.startPriceChecks(poolKeys, amountIn, tokenOut);
        } catch (error) {
            logger.error('Error starting price tracking:', error);
            throw error;
        }
    }

    private async startPriceChecks(
        poolKeys: LiquidityPoolKeysV4,
        amountIn: TokenAmount,
        tokenOut: Token
    ): Promise<void> {
        const tokenMint = poolKeys.baseMint.toString();
        const tracking = this.tracking.get(tokenMint);
        if (!tracking) return;

        const timesToCheck = Math.floor(this.config.priceCheckDuration / this.config.priceCheckInterval);

        while (tracking.checkCount < timesToCheck) {
            try {
                const currentPrice = await this.getCurrentPrice(poolKeys, amountIn, tokenOut);
                const priceChange = this.calculatePriceChange(tracking.startPrice, currentPrice);

                // Emit price update
                this.emit('priceUpdate', {
                    tokenMint,
                    currentPrice: currentPrice.toString(),
                    priceChange,
                    timestamp: Date.now()
                });

                // Check take profit/stop loss
                if (priceChange >= this.config.takeProfit) {
                    this.emit('takeProfitReached', {
                        tokenMint,
                        price: currentPrice.toString(),
                        priceChange
                    });
                    break;
                }

                if (priceChange <= -this.config.stopLoss) {
                    this.emit('stopLossReached', {
                        tokenMint,
                        price: currentPrice.toString(),
                        priceChange
                    });
                    break;
                }

                tracking.lastCheck = Date.now();
                tracking.checkCount++;

                await new Promise(resolve => setTimeout(resolve, this.config.priceCheckInterval));
            } catch (error) {
                logger.error('Error checking price:', error);
            }
        }

        this.tracking.delete(tokenMint);
    }

    private async getCurrentPrice(
        poolKeys: LiquidityPoolKeysV4,
        amountIn: TokenAmount,
        tokenOut: Token
    ): Promise<BN> {
        const poolInfo = await Liquidity.fetchInfo({
            connection: this.connection,
            poolKeys,
        });

        const computed = Liquidity.computeAmountOut({
            poolKeys,
            poolInfo,
            amountIn,
            currencyOut: tokenOut,
            slippage: new Percent(0)
        });

        return computed.amountOut.raw;
    }

    private calculatePriceChange(startPrice: BN, currentPrice: BN): number {
        const change = currentPrice.sub(startPrice).muln(100);
        return change.div(startPrice).toNumber();
    }

    stopTracking(tokenMint: string): void {
        this.tracking.delete(tokenMint);
    }
}