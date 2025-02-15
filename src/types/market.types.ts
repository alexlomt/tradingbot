import { Decimal } from 'decimal.js';

export enum OrderSide {
    BUY = 'BUY',
    SELL = 'SELL'
}

export enum OrderType {
    MARKET = 'MARKET',
    LIMIT = 'LIMIT',
    STOP_LOSS = 'STOP_LOSS',
    TAKE_PROFIT = 'TAKE_PROFIT',
    STOP_LIMIT = 'STOP_LIMIT',
    TRAILING_STOP = 'TRAILING_STOP'
}

export enum OrderStatus {
    PENDING = 'PENDING',
    OPEN = 'OPEN',
    FILLED = 'FILLED',
    PARTIALLY_FILLED = 'PARTIALLY_FILLED',
    CANCELLED = 'CANCELLED',
    REJECTED = 'REJECTED',
    EXPIRED = 'EXPIRED'
}

export enum CandleInterval {
    ONE_MINUTE = '1m',
    FIVE_MINUTES = '5m',
    FIFTEEN_MINUTES = '15m',
    THIRTY_MINUTES = '30m',
    ONE_HOUR = '1h',
    FOUR_HOURS = '4h',
    ONE_DAY = '1d',
    ONE_WEEK = '1w'
}

export interface MarketConfig {
    symbol: string;
    baseCurrency: string;
    quoteCurrency: string;
    minPrice: Decimal;
    maxPrice: Decimal;
    priceIncrement: Decimal;
    minSize: Decimal;
    maxSize: Decimal;
    sizeIncrement: Decimal;
    minNotional: Decimal;
    maxLeverage: number;
    makerFee: Decimal;
    takerFee: Decimal;
    isActive: boolean;
}

export interface OrderBook {
    bids: [number, number][]; // [price, size][]
    asks: [number, number][]; // [price, size][]
    timestamp: number;
    sequence: number;
    market: string;
}

export interface MarketDepth {
    bids: [number, number][]; // [price, cumulative size][]
    asks: [number, number][]; // [price, cumulative size][]
    timestamp: number;
}

export interface Trade {
    id: string;
    market: string;
    price: Decimal;
    size: Decimal;
    side: OrderSide;
    timestamp: number;
    takerOrderId: string;
    makerOrderId: string;
    liquidation: boolean;
}

export interface Candle {
    market: string;
    interval: CandleInterval;
    timestamp: number;
    open: Decimal;
    high: Decimal;
    low: Decimal;
    close: Decimal;
    volume: Decimal;
    vwap?: Decimal;
    trades?: number;
}

export interface MarketTicker {
    market: string;
    bid: Decimal;
    ask: Decimal;
    last: Decimal;
    volume24h: Decimal;
    quoteVolume24h: Decimal;
    priceChange24h: Decimal;
    priceChangePercent24h: Decimal;
    high24h: Decimal;
    low24h: Decimal;
    timestamp: number;
}

export interface LiquiditySnapshot {
    market: string;
    timestamp: number;
    bidLiquidity: Decimal;
    askLiquidity: Decimal;
    spreadPercent: Decimal;
    depth: {
        bids: {
            [price: string]: Decimal;
        };
        asks: {
            [price: string]: Decimal;
        };
    };
}

export interface MarketEvent {
    type: MarketEventType;
    market: string;
    timestamp: number;
    data: any;
}

export enum MarketEventType {
    TRADE = 'TRADE',
    ORDER_BOOK = 'ORDER_BOOK',
    TICKER = 'TICKER',
    CANDLE = 'CANDLE',
    MARKET_STATE = 'MARKET_STATE'
}

export interface OrderBookUpdate {
    market: string;
    timestamp: number;
    sequence: number;
    bids: [number, number][];
    asks: [number, number][];
    type: 'snapshot' | 'update';
}

export interface MarketState {
    market: string;
    status: MarketStatus;
    timestamp: number;
    reason?: string;
}

export enum MarketStatus {
    ACTIVE = 'ACTIVE',
    HALTED = 'HALTED',
    POST_ONLY = 'POST_ONLY',
    CANCEL_ONLY = 'CANCEL_ONLY',
    MAINTENANCE = 'MAINTENANCE'
}

export interface VolumeProfile {
    market: string;
    timestamp: number;
    interval: CandleInterval;
    profile: {
        price: Decimal;
        volume: Decimal;
        buyVolume: Decimal;
        sellVolume: Decimal;
        trades: number;
    }[];
}

export interface MarketMetrics {
    market: string;
    timestamp: number;
    volatility: {
        hourly: Decimal;
        daily: Decimal;
        weekly: Decimal;
    };
    liquidity: {
        bidDepth: Decimal;
        askDepth: Decimal;
        spreadPercent: Decimal;
        volumeProfile: VolumeProfile;
    };
    momentum: {
        rsi: Decimal;
        macd: {
            value: Decimal;
            signal: Decimal;
            histogram: Decimal;
        };
    };
}

export class MarketError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly market: string,
        public readonly details?: any
    ) {
        super(message);
        this.name = 'MarketError';
    }
}

export interface MarketSubscription {
    market: string;
    channels: MarketChannel[];
    callback: (event: MarketEvent) => void;
}

export enum MarketChannel {
    TRADES = 'trades',
    ORDER_BOOK = 'orderbook',
    TICKER = 'ticker',
    CANDLES = 'candles',
    MARKET_STATE = 'market_state'
}
