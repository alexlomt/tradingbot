import { ApiProperty } from '@nestjs/swagger';
import { OrderType, OrderSide, TimeInForce } from '../dto/trading.dto';

export class TokenInfo {
    @ApiProperty()
    address: string;

    @ApiProperty()
    symbol: string;

    @ApiProperty()
    decimals: number;

    @ApiProperty()
    price: number;

    @ApiProperty()
    priceChange24h: number;
}

export class TradeRoute {
    @ApiProperty()
    pools: string[];

    @ApiProperty()
    path: string[];

    @ApiProperty()
    expectedOutput: number;

    @ApiProperty()
    priceImpact: number;

    @ApiProperty()
    minimumOutput: number;
}

export class TradeResultResponse {
    @ApiProperty()
    success: boolean;

    @ApiProperty()
    transactionHash: string;

    @ApiProperty()
    inputAmount: number;

    @ApiProperty()
    outputAmount: number;

    @ApiProperty()
    executionPrice: number;

    @ApiProperty()
    priceImpact: number;

    @ApiProperty()
    fee: {
        amount: number;
        token: string;
    };

    @ApiProperty()
    route: TradeRoute;

    @ApiProperty()
    timestamp: Date;

    @ApiProperty()
    blockNumber: number;
}

export class OrderBookEntry {
    @ApiProperty()
    price: number;

    @ApiProperty()
    size: number;

    @ApiProperty()
    total: number;
}

export class OrderBookResponse {
    @ApiProperty({ type: [OrderBookEntry] })
    bids: OrderBookEntry[];

    @ApiProperty({ type: [OrderBookEntry] })
    asks: OrderBookEntry[];

    @ApiProperty()
    timestamp: Date;
}

export class TradeHistoryEntry {
    @ApiProperty()
    id: string;

    @ApiProperty({ enum: OrderType })
    type: OrderType;

    @ApiProperty({ enum: OrderSide })
    side: OrderSide;

    @ApiProperty({ enum: TimeInForce })
    timeInForce: TimeInForce;

    @ApiProperty()
    inputToken: TokenInfo;

    @ApiProperty()
    outputToken: TokenInfo;

    @ApiProperty()
    amount: number;

    @ApiProperty()
    price: number;

    @ApiProperty()
    value: number;

    @ApiProperty()
    fee: number;

    @ApiProperty()
    timestamp: Date;

    @ApiProperty()
    status: 'COMPLETED' | 'FAILED' | 'PENDING';

    @ApiProperty()
    transactionHash: string;
}

export class TradeHistoryResponse {
    @ApiProperty({ type: [TradeHistoryEntry] })
    trades: TradeHistoryEntry[];

    @ApiProperty()
    total: number;

    @ApiProperty()
    totalVolume: number;

    @ApiProperty()
    pagination: {
        limit: number;
        offset: number;
        hasMore: boolean;
    };
}

export class MarketDataResponse {
    @ApiProperty()
    price: number;

    @ApiProperty()
    priceChange24h: number;

    @ApiProperty()
    volume24h: number;

    @ApiProperty()
    liquidity: {
        total: number;
        token0: number;
        token1: number;
    };

    @ApiProperty()
    orderbook: OrderBookResponse;

    @ApiProperty()
    timestamp: Date;
}
