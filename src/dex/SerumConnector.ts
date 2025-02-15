import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { 
    Market, 
    OrderType as SerumOrderType,
    DexInstructions,
    TOKEN_PROGRAM_ID
} from '@project-serum/serum';
import { 
    PublicKey, 
    Keypair, 
    TransactionInstruction,
    SystemProgram
} from '@solana/web3.js';
import { SolanaService } from '../blockchain/solana/SolanaService';
import { MetricsService } from '../services/metrics/MetricsService';
import { CircuitBreakerService } from '../services/circuit-breaker/CircuitBreakerService';
import { RiskManagementService } from '../services/trading/RiskManagementService';
import { NotificationService } from '../services/notification/NotificationService';
import { 
    MarketConfig,
    OrderParams,
    OrderbookData,
    MarketState,
    SettlementParams,
    MarketFees
} from './types';
import { OrderSide } from '../types/trading.types';
import BigNumber from 'bignumber.js';

@Injectable()
export class SerumConnector implements OnModuleInit {
    private readonly logger = new Logger(SerumConnector.name);
    private readonly markets: Map<string, Market> = new Map();
    private readonly marketConfigs: Map<string, MarketConfig> = new Map();
    private readonly SERUM_DEX_PROGRAM_ID: PublicKey;

    constructor(
        private readonly configService: ConfigService,
        private readonly solanaService: SolanaService,
        private readonly metricsService: MetricsService,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly riskManagement: RiskManagementService,
        private readonly notificationService: NotificationService
    ) {
        this.SERUM_DEX_PROGRAM_ID = new PublicKey(
            this.configService.get('SERUM_DEX_PROGRAM_ID')
        );
    }

    async onModuleInit() {
        await this.loadMarketConfigs();
        await this.initializeMarkets();
        this.startMarketDataSubscription();
    }

    async placeOrder(params: OrderParams): Promise<string> {
        const market = await this.getMarket(params.marketId);
        const payer = await this.getTokenAccountForMarket(market, params.side);

        return this.circuitBreaker.executeFunction(
            'serum_place_order',
            async () => {
                const startTime = Date.now();

                try {
                    await this.validateOrderParameters(params);
                    const orderType = this.convertOrderType(params.type);
                    
                    const { transaction, signers } = await this.createOrderTransaction(
                        market,
                        payer,
                        params,
                        orderType
                    );

                    const result = await this.solanaService.sendTransaction(
                        transaction,
                        signers
                    );

                    await this.recordOrderMetrics(params, result.signature, startTime);
                    return result.signature;
                } catch (error) {
                    await this.handleOrderError(error, params);
                    throw error;
                }
            }
        );
    }

    async cancelOrder(marketId: string, orderId: string): Promise<string> {
        const market = await this.getMarket(marketId);
        
        return this.circuitBreaker.executeFunction(
            'serum_cancel_order',
            async () => {
                const instruction = await market.makeCancelOrderInstruction(orderId);
                const result = await this.solanaService.sendTransaction([instruction]);
                return result.signature;
            }
        );
    }

    async cancelAllOrders(marketId: string): Promise<string[]> {
        const market = await this.getMarket(marketId);
        const orders = await this.getOpenOrders(marketId);
        
        const instructions: TransactionInstruction[] = [];
        for (const order of orders) {
            instructions.push(
                await market.makeCancelOrderInstruction(order.orderId)
            );
        }

        const result = await this.solanaService.sendTransaction(instructions);
        return [result.signature];
    }

    async getOrderbook(marketId: string): Promise<OrderbookData> {
        const market = await this.getMarket(marketId);
        const [bids, asks] = await Promise.all([
            market.loadBids(),
            market.loadAsks()
        ]);

        return {
            marketId,
            bids: bids.getL2(20),
            asks: asks.getL2(20),
            timestamp: new Date()
        };
    }

    async getMarketState(marketId: string): Promise<MarketState> {
        const market = await this.getMarket(marketId);
        const [baseTotal, quoteTotal] = await Promise.all([
            market.getBaseTokenTotal(),
            market.getQuoteTokenTotal()
        ]);

        return {
            marketId,
            baseDecimals: market.baseDecimals,
            quoteDecimals: market.quoteDecimals,
            baseLotSize: market.baseLotSize,
            quoteLotSize: market.quoteLotSize,
            baseTokenTotal: baseTotal,
            quoteTokenTotal: quoteTotal,
            vaultSignerNonce: market.vaultSignerNonce,
            timestamp: new Date()
        };
    }

    async settleFunds(params: SettlementParams): Promise<string> {
        const market = await this.getMarket(params.marketId);
        const openOrders = await market.loadOrdersForOwner(
            this.solanaService.getPayer().publicKey
        );

        const instructions: TransactionInstruction[] = [];
        for (const orders of openOrders) {
            if (orders.baseTokenFree.gt(0) || orders.quoteTokenFree.gt(0)) {
                instructions.push(
                    await market.makeSettleFundsInstruction(
                        orders,
                        params.baseWallet,
                        params.quoteWallet
                    )
                );
            }
        }

        if (instructions.length === 0) {
            return '';
        }

        const result = await this.solanaService.sendTransaction(instructions);
        return result.signature;
    }

    private async loadMarketConfigs(): Promise<void> {
        const configs = this.configService.get('SERUM_MARKETS');
        for (const config of configs) {
            this.marketConfigs.set(config.marketId, {
                ...config,
                address: new PublicKey(config.address)
            });
        }
    }

    private async initializeMarkets(): Promise<void> {
        for (const [marketId, config] of this.marketConfigs) {
            try {
                const market = await Market.load(
                    this.solanaService.getConnection(),
                    config.address,
                    {},
                    this.SERUM_DEX_PROGRAM_ID
                );
                this.markets.set(marketId, market);
                
                await this.validateMarket(market, config);
            } catch (error) {
                this.logger.error(`Failed to initialize market ${marketId}:`, error);
                await this.notificationService.sendSystemAlert({
                    component: 'SerumConnector',
                    type: 'MARKET_INIT_FAILED',
                    marketId,
                    error: error.message
                });
            }
        }
    }

    private async validateMarket(
        market: Market,
        config: MarketConfig
    ): Promise<void> {
        const state = await market.loadAsks();
        if (!state) {
            throw new Error(`Invalid market state for ${config.marketId}`);
        }

        // Validate market permissions
        const owner = this.solanaService.getPayer().publicKey;
        const openOrders = await market.findOpenOrdersAccountsForOwner(
            this.solanaService.getConnection(),
            owner
        );

        if (openOrders.length === 0) {
            await this.createOpenOrdersAccount(market);
        }
    }

    private async createOpenOrdersAccount(market: Market): Promise<void> {
        const owner = this.solanaService.getPayer();
        const instruction = await market.makeCreateOpenOrdersAccountInstruction(
            owner.publicKey
        );
        
        await this.solanaService.sendTransaction([instruction], [owner]);
    }

    private async getMarket(marketId: string): Promise<Market> {
        const market = this.markets.get(marketId);
        if (!market) {
            throw new Error(`Market ${marketId} not found`);
        }
        return market;
    }

    private async validateOrderParameters(params: OrderParams): Promise<void> {
        const market = await this.getMarket(params.marketId);
        
        // Validate lot size
        const quantity = new BigNumber(params.quantity);
        const lotSize = new BigNumber(market.baseLotSize.toString());
        if (!quantity.modulo(lotSize).isZero()) {
            throw new Error(`Invalid lot size. Must be multiple of ${lotSize}`);
        }

        // Validate price tick size
        const price = new BigNumber(params.price);
        const tickSize = new BigNumber(market.tickSize);
        if (!price.modulo(tickSize).isZero()) {
            throw new Error(`Invalid price. Must be multiple of ${tickSize}`);
        }

        // Risk validation
        await this.riskManagement.validateOrder({
            ...params,
            market: market.address.toString()
        });
    }

    private convertOrderType(type: string): SerumOrderType {
        switch (type.toUpperCase()) {
            case 'LIMIT':
                return 'limit';
            case 'IOC':
                return 'ioc';
            case 'POST_ONLY':
                return 'postOnly';
            default:
                throw new Error(`Unsupported order type: ${type}`);
        }
    }

    private async createOrderTransaction(
        market: Market,
        payer: PublicKey,
        params: OrderParams,
        orderType: SerumOrderType
    ): Promise<{ transaction: TransactionInstruction[]; signers: Keypair[] }> {
        const owner = this.solanaService.getPayer();
        const transaction: TransactionInstruction[] = [];
        const signers: Keypair[] = [owner];

        // Add order instruction
        transaction.push(
            await market.makePlaceOrderInstruction({
                owner: owner.publicKey,
                payer,
                side: params.side === OrderSide.BUY ? 'buy' : 'sell',
                price: params.price,
                size: params.quantity,
                orderType,
                clientId: params.clientOrderId
            })
        );

        // Add settlement instruction if requested
        if (params.postOnly) {
            const settlementInstructions = await market.makeSettleFundsInstruction(
                await market.findOpenOrdersAccountsForOwner(
                    this.solanaService.getConnection(),
                    owner.publicKey
                )[0],
                payer,
                payer
            );
            transaction.push(settlementInstructions);
        }

        return { transaction, signers };
    }

    private async getTokenAccountForMarket(
        market: Market,
        side: OrderSide
    ): Promise<PublicKey> {
        const owner = this.solanaService.getPayer().publicKey;
        const mint = side === OrderSide.BUY 
            ? market.quoteMintAddress 
            : market.baseMintAddress;

        return await this.solanaService.createTokenAccount(
            mint,
            owner
        );
    }

    private async recordOrderMetrics(
        params: OrderParams,
        signature: string,
        startTime: number
    ): Promise<void> {
        const duration = Date.now() - startTime;
        await this.metricsService.recordSerumOrder({
            marketId: params.marketId,
            side: params.side,
            type: params.type,
            price: params.price,
            quantity: params.quantity,
            signature,
            duration,
            timestamp: new Date()
        });
    }

    private async handleOrderError(
        error: Error,
        params: OrderParams
    ): Promise<void> {
        await this.notificationService.sendSystemAlert({
            component: 'SerumConnector',
            type: 'ORDER_FAILED',
            marketId: params.marketId,
            orderParams: params,
            error: error.message
        });

        await this.metricsService.recordSerumError({
            marketId: params.marketId,
            operation: 'placeOrder',
            error: error.message,
            timestamp: new Date()
        });
    }

    private startMarketDataSubscription(): void {
        for (const [marketId, market] of this.markets) {
            this.subscribeToMarketData(marketId, market);
        }
    }

    private async subscribeToMarketData(
        marketId: string,
        market: Market
    ): Promise<void> {
        const connection = this.solanaService.getConnection();
        
        connection.onAccountChange(
            market.bidsAddress,
            () => this.handleOrderBookUpdate(marketId),
            'processed'
        );

        connection.onAccountChange(
            market.asksAddress,
            () => this.handleOrderBookUpdate(marketId),
            'processed'
        );
    }

    private async handleOrderBookUpdate(marketId: string): Promise<void> {
        try {
            const orderbook = await this.getOrderbook(marketId);
            this.eventEmitter.emit('orderbook.updated', orderbook);
        } catch (error) {
            this.logger.error(`Failed to handle orderbook update for ${marketId}:`, error);
        }
    }
}
