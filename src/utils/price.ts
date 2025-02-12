// src/utils/price.ts
import { Liquidity, Token, TokenAmount, Percent } from '@raydium-io/raydium-sdk';
import BN from 'bn.js';
import { logger } from '../config/logger';

export class PriceUtils {
    static calculateMinAmountOut(
        poolInfo: any,
        amountIn: TokenAmount,
        tokenOut: Token,
        slippagePercent: number
    ): TokenAmount {
        try {
            const slippage = new Percent(slippagePercent, 100);
            const computedAmountOut = Liquidity.computeAmountOut({
                poolKeys: poolInfo.poolKeys,
                poolInfo,
                amountIn,
                currencyOut: tokenOut,
                slippage
            });

            return computedAmountOut.minAmountOut;
        } catch (error) {
            logger.error('Error calculating minimum amount out:', error);
            throw error;
        }
    }

    static calculateProfitLoss(
        buyPrice: number,
        currentPrice: number,
        amount: number
    ): {
        profitLossAmount: number;
        profitLossPercentage: number;
    } {
        const profitLossAmount = (currentPrice - buyPrice) * amount;
        const profitLossPercentage = ((currentPrice - buyPrice) / buyPrice) * 100;

        return {
            profitLossAmount,
            profitLossPercentage
        };
    }
}
