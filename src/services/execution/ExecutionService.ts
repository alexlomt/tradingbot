import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Market, OrderParams } from '@project-serum/serum';
import { 
    Token, 
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID 
} from '@solana/spl-token';
import { OrderManagementService } from '../order/OrderManagementService';
import { MarketDataCache } from '../market/MarketDataCache';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { WalletService } from '../wallet/WalletService';
import { OrderSide, OrderType, TimeInForce } from '../../types/order.types';
import { ExecutionStrategy } from '../../types/execution.types';
import { Decimal } from 'decimal.js';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { retry, timeout } from 'rxjs/operators';

interface ExecutionConfig {
    strategy: ExecutionStrategy;
    timeWindow: number;
    minOrderSize: Decimal;
    maxOrderSize: Decimal;
    priceImprovement: Decimal;
    urgency: number;
    maxSlippage: Decimal;
}

@Injectable()
export class ExecutionService implements OnModuleInit {
    private connection: Connection;
    private readonly executionConfigs: Map<string, ExecutionConfig> = new Map();
    private readonly activeExecutions = new Map<string, Subject<void>>();
    private readonly executionUpdates = new BehaviorSubject<Map<string, any>>(new Map());
    private readonly MAX_RETRIES = 3;
    private readonly EXECUTION_TIMEOUT = 30000;

    constructor(
        private readonly configService: ConfigService,
        private readonly orderManagement: OrderManagementService,
        private readonly marketDataCache: MarketDataCache,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService,
        private readonly walletService: WalletService
    ) {
        this.connection = new Connection(
            this.configService.get<string>('SOLANA_RPC_URL'),
            'confirmed'
        );
    }

    async onModuleInit() {
        await this.loadExecutionConfigs();
    }

    private async loadExecutionConfigs() {
        const configs = this.configService.get<Record<string, ExecutionConfig>>('EXECUTION_CONFIGS');
        
        for (const [market, config] of Object.entries(configs)) {
            this.executionConfigs.set(market, {
                ...config,
                minOrderSize: new Decimal(config.minOrderSize),
                maxOrderSize: new Decimal(config.maxOrderSize),
                priceImprovement: new Decimal(config.priceImprovement),
                maxSlippage: new Decimal(config.maxSlippage)
            });
        }
    }

    async executeOrder(
        market: string,
        side: OrderSide,
        size: Decimal,
        price: Decimal,
        type: OrderType,
        timeInForce: TimeInForce = TimeInForce.GTC
    ): Promise<string> {
        const config = this.executionConfigs.get(market);
        if (!config) {
            throw new Error(`No execution configuration found for market ${market}`);
        }

        try {
            const executionId = this.generateExecutionId();
            const execution$ = new Subject<void>();
            this.activeExecutions.set(executionId, execution$);

            await this.auditService.logSystemEvent({
                event: 'EXECUTION_STARTED',
                details: {
                    executionId,
                    market,
                    side,
                    size: size.toString(),
                    price: price.toString(),
                    type
                },
                severity: 'INFO'
            });

            const result = await this.executeWithStrategy(
                executionId,
                market,
                side,
                size,
                price,
                type,
                config
            );

            execution$.complete();
            this.activeExecutions.delete(executionId);

            return result;
        } catch (error) {
            await this.handleError('executeOrder', error);
            throw error;
        }
    }

    private async executeWithStrategy(
        executionId: string,
        market: string,
        side: OrderSide,
        size: Decimal,
        price: Decimal,
        type: OrderType,
        config: ExecutionConfig
    ): Promise<string> {
        switch (config.strategy) {
            case ExecutionStrategy.TWAP:
                return this.executeTWAP(executionId, market, side, size, price, config);
            case ExecutionStrategy.VWAP:
                return this.executeVWAP(executionId, market, side, size, price, config);
            case ExecutionStrategy.SMART:
                return this.executeSmartRoute(executionId, market, side, size, price, config);
            default:
                return this.executeImmediate(executionId, market, side, size, price, type);
        }
    }

    private async executeTWAP(
        executionId: string,
        market: string,
        side: OrderSide,
        totalSize: Decimal,
        price: Decimal,
        config: ExecutionConfig
    ): Promise<string> {
        const interval = config.timeWindow / Math.ceil(totalSize.div(config.maxOrderSize).toNumber());
        let remainingSize = totalSize;
        const orders: string[] = [];

        while (remainingSize.gt(0)) {
            const sliceSize = Decimal.min(remainingSize, config.maxOrderSize);
            const currentPrice = await this.calculateTWAPPrice(market, price, config);

            const orderId = await this.executeImmediate(
                executionId,
                market,
                side,
                sliceSize,
                currentPrice,
                OrderType.LIMIT
            );

            orders.push(orderId);
            remainingSize = remainingSize.minus(sliceSize);

            if (remainingSize.gt(0)) {
                await new Promise(resolve => setTimeout(resolve, interval));
            }
        }

        return orders.join(',');
    }

    private async executeVWAP(
        executionId: string,
        market: string,
        side: OrderSide,
        totalSize: Decimal,
        price: Decimal,
        config: ExecutionConfig
    ): Promise<string> {
        const volumeProfile = await this.marketDataCache.getVolumeProfile(market);
        let remainingSize = totalSize;
        const orders: string[] = [];

        for (const [time, volume] of volumeProfile) {
            if (remainingSize.lte(0)) break;

            const proportion = new Decimal(volume).div(volumeProfile.reduce((a, b) => a + b[1], 0));
            const sliceSize = Decimal.min(totalSize.mul(proportion), remainingSize);
            
            if (sliceSize.lt(config.minOrderSize)) continue;

            const currentPrice = await this.calculateVWAPPrice(market, price, config);

            const orderId = await this.executeImmediate(
                executionId,
                market,
                side,
                sliceSize,
                currentPrice,
                OrderType.LIMIT
            );

            orders.push(orderId);
            remainingSize = remainingSize.minus(sliceSize);

            await this.waitForNextVolumeSlice(time);
        }

        return orders.join(',');
    }

    private async executeSmartRoute(
        executionId: string,
        market: string,
        side: OrderSide,
        size: Decimal,
        price: Decimal,
        config: ExecutionConfig
    ): Promise<string> {
        const orderbook = await this.marketDataCache.getOrderBook(market);
        const liquidityProfile = this.analyzeLiquidity(orderbook, side);
        const execPlan = this.createExecutionPlan(size, price, liquidityProfile, config);

        const orders: string[] = [];
        for (const slice of execPlan) {
            const orderId = await this.executeImmediate(
                executionId,
                market,
                side,
                slice.size,
                slice.price,
                slice.type
            );
            orders.push(orderId);

            if (slice.delay) {
                await new Promise(resolve => setTimeout(resolve, slice.delay));
            }
        }

        return orders.join(',');
    }

    private async executeImmediate(
        executionId: string,
        market: string,
        side: OrderSide,
        size: Decimal,
        price: Decimal,
        type: OrderType
    ): Promise<string> {
        const wallet = await this.walletService.getWallet();
        const marketInstance = await this.getMarketInstance(market);
        const payer = await this.getOrCreateAssociatedTokenAccount(market, side);

        const orderParams: OrderParams = {
            owner: wallet.publicKey,
            payer,
            side: side === OrderSide.BUY ? 'buy' : 'sell',
            price: price.toNumber(),
            size: size.toNumber(),
            orderType: type === OrderType.LIMIT ? 'limit' : 'ioc',
            clientId: parseInt(executionId.slice(0, 8), 16)
        };

        const transaction = new Transaction();
        transaction.add(
            await marketInstance.makePlaceOrderInstruction(orderParams)
        );

        const txid = await this.sendAndConfirmTransaction(transaction);
        
        await this.metricsService.recordExecution({
            executionId,
            market,
            side,
            size: size.toString(),
            price: price.toString(),
            type,
            txid
        });

        return txid;
    }

    private async getMarketInstance(market: string): Promise<Market> {
        const marketAddress = new PublicKey(market);
        return await Market.load(
            this.connection,
            marketAddress,
            {},
            this.configService.get('SERUM_PROGRAM_ID')
        );
    }

    private async getOrCreateAssociatedTokenAccount(
        market: string,
        side: OrderSide
    ): Promise<PublicKey> {
        const wallet = await this.walletService.getWallet();
        const marketInstance = await this.getMarketInstance(market);
        const mintAddress = side === OrderSide.BUY ? 
            marketInstance.quoteMintAddress :
            marketInstance.baseMintAddress;

        const associatedToken = await Token.getAssociatedTokenAddress(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            mintAddress,
            wallet.publicKey
        );

        const account = await this.connection.getAccountInfo(associatedToken);
        if (!account) {
            const transaction = new Transaction().add(
                Token.createAssociatedTokenAccountInstruction(
                    ASSOCIATED_TOKEN_PROGRAM_ID,
                    TOKEN_PROGRAM_ID,
                    mintAddress,
                    associatedToken,
                    wallet.publicKey,
                    wallet.publicKey
                )
            );
            await this.sendAndConfirmTransaction(transaction);
        }

        return associatedToken;
    }

    private async sendAndConfirmTransaction(
        transaction: Transaction
    ): Promise<string> {
        const wallet = await this.walletService.getWallet();
        transaction = await this.walletService.signTransaction(transaction);
        
        const signature = await this.connection.sendRawTransaction(
            transaction.serialize(),
            { skipPreflight: false }
        );

        await this.connection.confirmTransaction(signature, 'confirmed');
        return signature;
    }

    private generateExecutionId(): string {
        return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    getExecutionUpdates(): Observable<Map<string, any>> {
        return this.executionUpdates.asObservable();
    }

    private async handleError(
        operation: string,
        error: Error
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'EXECUTION_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('execution');
    }
}
