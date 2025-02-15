import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '../circuit-breaker/CircuitBreakerService';
import { MetricsService } from '../metrics/MetricsService';
import { NotificationService } from '../notification/NotificationService';
import { RedisService } from '../cache/RedisService';
import { Web3Service } from '../blockchain/Web3Service';
import { PriceService } from '../price/PriceService';
import { OrderbookService } from '../orderbook/OrderbookService';
import { BalanceService } from '../balance/BalanceService';
import { DatabaseService } from '../database/DatabaseService';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { 
    TradeParams,
    TradeResult,
    OrderType,
    OrderSide,
    MarketInfo,
    TradeStatus,
    OrderbookEntry,
    TradingError
} from '../../types/trading.types';
import BigNumber from 'bignumber.js';

@Injectable()
export class TradingService {
    private readonly logger = new Logger(TradingService.name);
    private readonly maxSlippage: number;
    private readonly maxRetries: number;
    private readonly defaultGasMultiplier: number;

    constructor(
        private readonly configService: ConfigService,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService,
        private readonly redisService: RedisService,
        private readonly web3Service: Web3Service,
        private readonly priceService: PriceService,
        private readonly orderbookService: OrderbookService,
        private readonly balanceService: BalanceService,
        private readonly databaseService: DatabaseService,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.maxSlippage = this.configService.get('MAX_SLIPPAGE_PERCENTAGE', 1);
        this.maxRetries = this.configService.get('MAX_TRADE_RETRIES', 3);
        this.defaultGasMultiplier = this.configService.get('DEFAULT_GAS_MULTIPLIER', 1.1);
    }

    async executeTrade(tradeParams: TradeParams): Promise<TradeResult> {
        return this.circuitBreaker.executeFunction(
            'trade_execution',
            async () => {
                const startTime = Date.now();
                let result: TradeResult;

                try {
                    await this.validateTradeParams(tradeParams);
                    const marketInfo = await this.getMarketInfo(tradeParams.pair);
                    
                    if (tradeParams.type === OrderType.MARKET) {
                        result = await this.executeMarketOrder(tradeParams, marketInfo);
                    } else {
                        result = await this.executeLimitOrder(tradeParams, marketInfo);
                    }

                    await this.processTradingFees(result);
                    await this.updateTradeHistory(result);
                    await this.notifyTradeExecution(result);

                    const executionTime = Date.now() - startTime;
                    await this.metricsService.recordTradeExecution({
                        success: true,
                        volume: result.amount,
                        executionTime,
                        pair: tradeParams.pair
                    });

                    return result;
                } catch (error) {
                    await this.handleTradeError(error, tradeParams);
                    throw error;
                }
            },
            {
                failureThreshold: 3,
                timeoutMs: 30000
            }
        );
    }

    async getMarketPrice(symbol: string): Promise<number> {
        return this.circuitBreaker.executeFunction(
            `market_price_${symbol}`,
            async () => {
                const price = await this.priceService.getCurrentPrice(symbol);
                if (!price || price <= 0) {
                    throw new TradingError('Invalid market price received');
                }
                return price;
            },
            {
                failureThreshold: 5,
                timeoutMs: 2000
            }
        );
    }

    async getOrderbook(pair: string): Promise<{ bids: OrderbookEntry[], asks: OrderbookEntry[] }> {
        return this.circuitBreaker.executeFunction(
            `orderbook_${pair}`,
            async () => {
                const orderbook = await this.orderbookService.getOrderbook(pair);
                return orderbook;
            },
            {
                failureThreshold: 3,
                timeoutMs: 1000
            }
        );
    }

    async cancelOrder(orderId: string, userId: string): Promise<boolean> {
        return this.circuitBreaker.executeFunction(
            'order_cancellation',
            async () => {
                const order = await this.databaseService.getOrder(orderId);
                if (!order || order.userId !== userId) {
                    throw new TradingError('Order not found or unauthorized');
                }

                const success = await this.orderbookService.cancelOrder(orderId);
                if (success) {
                    await this.balanceService.releaseReservedFunds(userId, order);
                    await this.databaseService.updateOrderStatus(orderId, TradeStatus.CANCELLED);
                }

                return success;
            },
            {
                failureThreshold: 3,
                timeoutMs: 5000
            }
        );
    }

    private async validateTradeParams(params: TradeParams): Promise<void> {
        const balance = await this.balanceService.getBalance(
            params.userId,
            params.side === OrderSide.BUY ? params.quoteAsset : params.baseAsset
        );

        const requiredAmount = params.side === OrderSide.BUY
            ? new BigNumber(params.amount).multipliedBy(params.price)
            : new BigNumber(params.amount);

        if (balance.lt(requiredAmount)) {
            throw new TradingError('Insufficient balance for trade');
        }

        if (params.price <= 0 || params.amount <= 0) {
            throw new TradingError('Invalid price or amount');
        }
    }

    private async executeMarketOrder(
        params: TradeParams,
        marketInfo: MarketInfo
    ): Promise<TradeResult> {
        const orderbook = await this.getOrderbook(params.pair);
        const entries = params.side === OrderSide.BUY ? orderbook.asks : orderbook.bids;
        
        let remainingAmount = new BigNumber(params.amount);
        let totalCost = new BigNumber(0);
        const fills = [];

        for (const entry of entries) {
            if (remainingAmount.lte(0)) break;

            const fillAmount = BigNumber.minimum(remainingAmount, entry.amount);
            const fillCost = fillAmount.multipliedBy(entry.price);

            fills.push({
                price: entry.price,
                amount: fillAmount.toNumber(),
                cost: fillCost.toNumber()
            });

            remainingAmount = remainingAmount.minus(fillAmount);
            totalCost = totalCost.plus(fillCost);
        }

        if (remainingAmount.gt(0)) {
            throw new TradingError('Insufficient liquidity for market order');
        }

        const averagePrice = totalCost.dividedBy(params.amount);
        const slippage = this.calculateSlippage(params.price, averagePrice.toNumber());

        if (slippage > this.maxSlippage) {
            throw new TradingError('Slippage exceeds maximum allowed');
        }

        const txHash = await this.web3Service.executeTransaction({
            from: params.userId,
            to: marketInfo.contractAddress,
            data: this.web3Service.encodeTradeData(params, fills),
            value: params.side === OrderSide.BUY ? totalCost.toNumber() : 0
        });

        return {
            orderId: txHash,
            userId: params.userId,
            pair: params.pair,
            side: params.side,
            type: params.type,
            amount: params.amount,
            filledAmount: params.amount,
            price: averagePrice.toNumber(),
            status: TradeStatus.COMPLETED,
            fills,
            timestamp: new Date(),
            txHash
        };
    }

    private async executeLimitOrder(
        params: TradeParams,
        marketInfo: MarketInfo
    ): Promise<TradeResult> {
        const orderId = await this.orderbookService.placeLimitOrder({
            userId: params.userId,
            pair: params.pair,
            side: params.side,
            amount: params.amount,
            price: params.price,
            expiry: params.expiry
        });

        await this.balanceService.reserveFunds(
            params.userId,
            params.side === OrderSide.BUY
                ? { asset: params.quoteAsset, amount: params.amount * params.price }
                : { asset: params.baseAsset, amount: params.amount }
        );

        return {
            orderId,
            userId: params.userId,
            pair: params.pair,
            side: params.side,
            type: params.type,
            amount: params.amount,
            filledAmount: 0,
            price: params.price,
            status: TradeStatus.PENDING,
            fills: [],
            timestamp: new Date()
        };
    }

    private async getMarketInfo(pair: string): Promise<MarketInfo> {
        const cacheKey = `market_info:${pair}`;
        const cached = await this.redisService.get(cacheKey);

        if (cached) {
            return JSON.parse(cached);
        }

        const marketInfo = await this.databaseService.getMarketInfo(pair);
        if (!marketInfo) {
            throw new TradingError('Market not found');
        }

        await this.redisService.set(
            cacheKey,
            JSON.stringify(marketInfo),
            'EX',
            300
        );

        return marketInfo;
    }

    private calculateSlippage(expectedPrice: number, actualPrice: number): number {
        return Math.abs((actualPrice - expectedPrice) / expectedPrice) * 100;
    }

    private async processTradingFees(result: TradeResult): Promise<void> {
        const feeAmount = new BigNumber(result.filledAmount)
            .multipliedBy(result.price)
            .multipliedBy(0.001)
            .toNumber();

        await this.balanceService.deductFees(result.userId, {
            asset: result.pair.split('/')[1],
            amount: feeAmount
        });

        result.fees = feeAmount;
    }

    private async updateTradeHistory(result: TradeResult): Promise<void> {
        await this.databaseService.insertTradeHistory(result);
        await this.metricsService.updateTradingMetrics(result);
    }

    private async notifyTradeExecution(result: TradeResult): Promise<void> {
        await this.notificationService.sendTradeNotification(
            result.userId,
            {
                type: result.type,
                pair: result.pair,
                side: result.side,
                amount: result.amount,
                price: result.price,
                status: result.status,
                timestamp: result.timestamp
            }
        );

        this.eventEmitter.emit('trade.executed', result);
    }

    private async handleTradeError(error: Error, params: TradeParams): Promise<void> {
        this.logger.error('Trade execution failed', {
            error,
            params
        });

        await this.metricsService.recordTradeError({
            error: error.message,
            pair: params.pair,
            type: params.type
        });

        if (error instanceof TradingError) {
            throw error;
        }

        throw new TradingError('Trade execution failed');
    }
}
