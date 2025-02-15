import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { Market, OpenOrders } from '@project-serum/serum';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { WebSocketService } from '../websocket/WebSocketService';
import { MarketDataCache } from '../market/MarketDataCache';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { RiskManagementService } from '../risk/RiskManagementService';
import { WalletService } from '../wallet/WalletService';
import { Order } from '../../entities/Order.entity';
import { Position } from '../../entities/Position.entity';
import { Trade } from '../../entities/Trade.entity';
import { OrderSide, OrderType, OrderStatus } from '../../types/market.types';
import { Decimal } from 'decimal.js';
import { BehaviorSubject, Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class OrderManagementService implements OnModuleInit {
    private readonly orderUpdates = new BehaviorSubject<Order[]>([]);
    private readonly MAX_ORDER_RETRIES = 3;
    private readonly ORDER_TIMEOUT = 30000;
    private readonly pendingOrders: Map<string, NodeJS.Timeout> = new Map();
    private connection: Connection;
    private markets: Map<string, Market> = new Map();

    constructor(
        @InjectRepository(Order)
        private readonly orderRepository: Repository<Order>,
        @InjectRepository(Position)
        private readonly positionRepository: Repository<Position>,
        @InjectRepository(Trade)
        private readonly tradeRepository: Repository<Trade>,
        private readonly configService: ConfigService,
        private readonly webSocketService: WebSocketService,
        private readonly marketDataCache: MarketDataCache,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService,
        private readonly riskManagement: RiskManagementService,
        private readonly walletService: WalletService
    ) {
        this.connection = new Connection(
            this.configService.get<string>('SOLANA_RPC_URL'),
            'confirmed'
        );
    }

    async onModuleInit() {
        await this.initializeMarkets();
        await this.initializeWebSocketSubscriptions();
        await this.reconcileOrders();
    }

    private async initializeMarkets() {
        const marketConfigs = this.configService.get('SERUM_MARKETS');
        
        for (const config of marketConfigs) {
            const marketAddress = new PublicKey(config.address);
            const programId = new PublicKey(config.programId);
            
            const market = await Market.load(
                this.connection,
                marketAddress,
                {},
                programId
            );
            
            this.markets.set(config.symbol, market);
            await this.auditService.logSystemEvent({
                event: 'MARKET_INITIALIZED',
                details: {
                    market: config.symbol,
                    address: config.address
                },
                severity: 'INFO'
            });
        }
    }

    private async initializeWebSocketSubscriptions() {
        await this.webSocketService.subscribe('fills', this.handleFillEvent.bind(this));
        await this.webSocketService.subscribe('orderbook', this.handleOrderBookEvent.bind(this));
    }

    async createOrder(request: OrderRequest): Promise<Order> {
        await this.validateOrderRequest(request);
        await this.riskManagement.validateOrderRisk(request);

        return await this.orderRepository.manager.transaction(async (manager) => {
            const order = await this.createOrderEntity(request, manager);
            
            try {
                const market = this.markets.get(request.market);
                if (!market) {
                    throw new Error(`Market not found: ${request.market}`);
                }

                const wallet = await this.walletService.getWallet();
                const payer = await this.getTokenAccountForMarket(market, request.side);
                
                let transaction = new Transaction();
                
                // Create OpenOrders account if needed
                const openOrders = await this.getOpenOrdersAccount(market, wallet.publicKey);
                if (!openOrders) {
                    transaction.add(
                        await market.makeCreateOpenOrdersAccountTransaction(wallet.publicKey)
                    );
                }

                // Add order placement instruction
                transaction.add(
                    await market.makePlaceOrderTransaction(this.connection, {
                        owner: wallet.publicKey,
                        payer,
                        side: request.side === OrderSide.BUY ? 'buy' : 'sell',
                        price: request.price.toNumber(),
                        size: request.size.toNumber(),
                        orderType: request.type === OrderType.LIMIT ? 'limit' : 'ioc',
                        clientId: parseInt(order.clientOrderId)
                    })
                );

                // Sign and send transaction
                transaction = await this.walletService.signTransaction(transaction);
                const signature = await this.connection.sendRawTransaction(
                    transaction.serialize(),
                    { skipPreflight: false }
                );
                
                await this.connection.confirmTransaction(signature, 'confirmed');

                order.exchangeOrderId = signature;
                await manager.save(Order, order);
                
                await this.auditService.logSystemEvent({
                    event: 'ORDER_PLACED',
                    details: {
                        orderId: order.id,
                        market: request.market,
                        signature
                    },
                    severity: 'INFO'
                });

                return order;
            } catch (error) {
                await this.handleError('createOrder', error, request);
                throw error;
            }
        });
    }

    async cancelOrder(orderId: string): Promise<boolean> {
        const order = await this.orderRepository.findOne({ where: { id: orderId } });
        if (!order) {
            throw new Error(`Order ${orderId} not found`);
        }

        try {
            const market = this.markets.get(order.market);
            const wallet = await this.walletService.getWallet();
            
            const openOrders = await this.getOpenOrdersAccount(market, wallet.publicKey);
            if (!openOrders) {
                throw new Error('OpenOrders account not found');
            }

            const transaction = new Transaction();
            transaction.add(
                await market.makeCancelOrderTransaction(this.connection, wallet.publicKey, openOrders, order)
            );

            const signature = await this.walletService.sendTransaction(transaction);
            await this.connection.confirmTransaction(signature, 'confirmed');

            order.status = OrderStatus.CANCELLED;
            await this.orderRepository.save(order);

            await this.auditService.logSystemEvent({
                event: 'ORDER_CANCELLED',
                details: { orderId, signature },
                severity: 'INFO'
            });

            return true;
        } catch (error) {
            await this.handleError('cancelOrder', error, { orderId });
            throw error;
        }
    }

    private async getTokenAccountForMarket(market: Market, side: OrderSide): Promise<PublicKey> {
        const wallet = await this.walletService.getWallet();
        const mint = side === OrderSide.BUY ? market.quoteMintAddress : market.baseMintAddress;
        
        const tokenAccount = await Token.getAssociatedTokenAddress(
            TOKEN_PROGRAM_ID,
            mint,
            wallet.publicKey
        );

        const accountInfo = await this.connection.getAccountInfo(tokenAccount);
        if (!accountInfo) {
            throw new Error('Token account not found');
        }

        return tokenAccount;
    }

    private async getOpenOrdersAccount(market: Market, owner: PublicKey): Promise<OpenOrders | null> {
        const openOrdersAccounts = await market.findOpenOrdersAccountsForOwner(
            this.connection,
            owner
        );
        return openOrdersAccounts[0] || null;
    }

    private async handleFillEvent(event: any) {
        try {
            const order = await this.orderRepository.findOne({
                where: { exchangeOrderId: event.orderId }
            });

            if (!order) return;

            const trade = new Trade();
            trade.orderId = order.id;
            trade.price = new Decimal(event.price);
            trade.size = new Decimal(event.size);
            trade.side = order.side;
            trade.market = order.market;
            trade.timestamp = new Date(event.timestamp);
            
            await this.tradeRepository.save(trade);
            
            // Update order status
            order.filledSize = new Decimal(order.filledSize || 0).plus(trade.size);
            order.status = order.filledSize.equals(order.size) 
                ? OrderStatus.FILLED 
                : OrderStatus.PARTIALLY_FILLED;
            
            await this.orderRepository.save(order);
            
            // Update position
            await this.updatePosition(trade);
            
            // Emit metrics
            await this.metricsService.recordTrade(trade);
        } catch (error) {
            await this.handleError('handleFillEvent', error, event);
        }
    }

    private async updatePosition(trade: Trade) {
        let position = await this.positionRepository.findOne({
            where: { market: trade.market }
        });

        if (!position) {
            position = new Position();
            position.market = trade.market;
            position.size = new Decimal(0);
            position.avgEntryPrice = new Decimal(0);
        }

        if (trade.side === OrderSide.BUY) {
            position.size = position.size.plus(trade.size);
        } else {
            position.size = position.size.minus(trade.size);
        }

        // Update average entry price
        const totalValue = position.size.mul(position.avgEntryPrice || 0)
            .plus(trade.side === OrderSide.BUY ? trade.size.mul(trade.price) : trade.size.mul(trade.price).neg());
        
        position.avgEntryPrice = position.size.isZero() 
            ? new Decimal(0) 
            : totalValue.div(position.size);

        await this.positionRepository.save(position);
    }

    private async handleError(
        operation: string,
        error: Error,
        context?: any
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'ORDER_MANAGEMENT_ERROR',
            details: {
                operation,
                error: error.message,
                context
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementOrderError(operation);
    }
}
