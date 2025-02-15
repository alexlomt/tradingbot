import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { Position } from '../../entities/Position.entity';
import { Trade } from '../../entities/Trade.entity';
import { OrderSide } from '../../types/market.types';
import { WebSocketService } from '../websocket/WebSocketService';
import { MarketDataCache } from '../market/MarketDataCache';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { WalletService } from '../wallet/WalletService';
import { BehaviorSubject, Observable } from 'rxjs';
import { Decimal } from 'decimal.js';

interface PositionRisk {
    unrealizedPnL: Decimal;
    realizedPnL: Decimal;
    marginUtilization: Decimal;
    liquidationPrice: Decimal;
    notionalValue: Decimal;
    leverage: Decimal;
}

@Injectable()
export class PositionTrackingService implements OnModuleInit {
    private readonly positionUpdates = new BehaviorSubject<Map<string, Position>>(new Map());
    private readonly riskUpdates = new BehaviorSubject<Map<string, PositionRisk>>(new Map());
    private readonly UPDATE_INTERVAL = 5000; // 5 seconds
    private readonly MAX_LEVERAGE = 10;
    private readonly LIQUIDATION_THRESHOLD = 0.8;
    private connection: Connection;
    private updateInterval: NodeJS.Timer;

    constructor(
        @InjectRepository(Position)
        private readonly positionRepository: Repository<Position>,
        @InjectRepository(Trade)
        private readonly tradeRepository: Repository<Trade>,
        private readonly configService: ConfigService,
        private readonly webSocketService: WebSocketService,
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
        await this.initializePositions();
        await this.startPositionUpdates();
        await this.subscribeToTradeUpdates();
    }

    private async initializePositions() {
        try {
            const positions = await this.positionRepository.find();
            const positionMap = new Map<string, Position>();
            const riskMap = new Map<string, PositionRisk>();

            for (const position of positions) {
                positionMap.set(position.market, position);
                const risk = await this.calculatePositionRisk(position);
                riskMap.set(position.market, risk);
            }

            this.positionUpdates.next(positionMap);
            this.riskUpdates.next(riskMap);

            await this.auditService.logSystemEvent({
                event: 'POSITIONS_INITIALIZED',
                details: {
                    positionCount: positions.length
                },
                severity: 'INFO'
            });
        } catch (error) {
            await this.handleError('initializePositions', error);
        }
    }

    private async startPositionUpdates() {
        this.updateInterval = setInterval(async () => {
            try {
                const positions = await this.positionRepository.find();
                for (const position of positions) {
                    await this.updatePositionRisk(position);
                }
            } catch (error) {
                await this.handleError('updatePositions', error);
            }
        }, this.UPDATE_INTERVAL);
    }

    private async subscribeToTradeUpdates() {
        this.webSocketService.subscribe('trades', async (trade: Trade) => {
            try {
                await this.updatePositionFromTrade(trade);
            } catch (error) {
                await this.handleError('tradeUpdate', error);
            }
        });
    }

    async updatePositionFromTrade(trade: Trade): Promise<void> {
        let position = await this.positionRepository.findOne({
            where: { market: trade.market }
        });

        if (!position) {
            position = new Position();
            position.market = trade.market;
            position.size = new Decimal(0);
            position.avgEntryPrice = new Decimal(0);
            position.unrealizedPnL = new Decimal(0);
            position.realizedPnL = new Decimal(0);
        }

        const oldSize = position.size;
        const oldAvgPrice = position.avgEntryPrice;

        if (trade.side === OrderSide.BUY) {
            position.size = position.size.plus(trade.size);
            position.avgEntryPrice = position.size.isZero() 
                ? new Decimal(0)
                : oldSize.mul(oldAvgPrice).plus(trade.size.mul(trade.price)).div(position.size);
        } else {
            const realizedPnL = trade.size.mul(trade.price.minus(position.avgEntryPrice));
            position.realizedPnL = position.realizedPnL.plus(realizedPnL);
            position.size = position.size.minus(trade.size);
            
            if (position.size.isZero()) {
                position.avgEntryPrice = new Decimal(0);
            }
        }

        position.lastUpdateTime = new Date();
        await this.positionRepository.save(position);

        const risk = await this.calculatePositionRisk(position);
        const positions = this.positionUpdates.getValue();
        const risks = this.riskUpdates.getValue();

        positions.set(position.market, position);
        risks.set(position.market, risk);

        this.positionUpdates.next(positions);
        this.riskUpdates.next(risks);

        await this.metricsService.recordPositionUpdate({
            market: position.market,
            size: position.size.toNumber(),
            unrealizedPnL: risk.unrealizedPnL.toNumber(),
            realizedPnL: position.realizedPnL.toNumber(),
            leverage: risk.leverage.toNumber()
        });
    }

    private async calculatePositionRisk(position: Position): Promise<PositionRisk> {
        const marketPrice = await this.marketDataCache.getLastPrice(position.market);
        const unrealizedPnL = position.size.mul(marketPrice.minus(position.avgEntryPrice));
        const notionalValue = position.size.mul(marketPrice);
        
        const collateral = await this.walletService.getCollateralBalance();
        const leverage = notionalValue.div(collateral);
        
        const marginUtilization = leverage.div(this.MAX_LEVERAGE);
        const liquidationPrice = this.calculateLiquidationPrice(
            position,
            collateral,
            marginUtilization
        );

        return {
            unrealizedPnL,
            realizedPnL: position.realizedPnL,
            marginUtilization,
            liquidationPrice,
            notionalValue,
            leverage
        };
    }

    private calculateLiquidationPrice(
        position: Position,
        collateral: Decimal,
        marginUtilization: Decimal
    ): Decimal {
        if (position.size.isZero()) {
            return new Decimal(0);
        }

        const maintenanceMargin = collateral.mul(this.LIQUIDATION_THRESHOLD);
        const liquidationPriceDelta = maintenanceMargin.div(position.size.abs());
        
        return position.size.isPositive()
            ? position.avgEntryPrice.minus(liquidationPriceDelta)
            : position.avgEntryPrice.plus(liquidationPriceDelta);
    }

    async getPositions(): Promise<Map<string, Position>> {
        return this.positionUpdates.getValue();
    }

    getPositionUpdates(): Observable<Map<string, Position>> {
        return this.positionUpdates.asObservable();
    }

    getRiskUpdates(): Observable<Map<string, PositionRisk>> {
        return this.riskUpdates.asObservable();
    }

    async closePosition(market: string): Promise<boolean> {
        const position = await this.positionRepository.findOne({
            where: { market }
        });

        if (!position || position.size.isZero()) {
            return false;
        }

        // Market sell/buy the entire position
        const orderService = await import('../order/OrderManagementService');
        await orderService.OrderManagementService.prototype.createOrder({
            market,
            side: position.size.isPositive() ? OrderSide.SELL : OrderSide.BUY,
            size: position.size.abs(),
            type: 'MARKET',
            reduceOnly: true
        });

        return true;
    }

    private async updatePositionRisk(position: Position) {
        try {
            const risk = await this.calculatePositionRisk(position);
            
            // Check for liquidation risk
            if (risk.marginUtilization.gte(this.LIQUIDATION_THRESHOLD)) {
                await this.handleLiquidationRisk(position, risk);
            }

            const risks = this.riskUpdates.getValue();
            risks.set(position.market, risk);
            this.riskUpdates.next(risks);

        } catch (error) {
            await this.handleError('updatePositionRisk', error);
        }
    }

    private async handleLiquidationRisk(
        position: Position,
        risk: PositionRisk
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'LIQUIDATION_RISK',
            details: {
                market: position.market,
                size: position.size.toString(),
                marginUtilization: risk.marginUtilization.toString(),
                liquidationPrice: risk.liquidationPrice.toString()
            },
            severity: 'WARNING'
        });

        // Auto-close position if enabled
        if (this.configService.get<boolean>('AUTO_LIQUIDATION_PROTECTION')) {
            await this.closePosition(position.market);
        }
    }

    private async handleError(
        operation: string,
        error: Error
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'POSITION_TRACKING_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('position_tracking');
    }
}
