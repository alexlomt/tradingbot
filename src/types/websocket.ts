// src/types/websocket.ts
export type WebSocketMessageType = 
    | 'botUpdate'
    | 'tradeExecution'
    | 'filterResult'
    | 'error';

export interface WebSocketMessage {
    type: WebSocketMessageType;
    data: any;
    timestamp: Date;
}

export interface TradeUpdate {
    botId: string;
    type: 'buy' | 'sell';
    tokenMint: string;
    amount: number;
    price: number;
    signature?: string;
    status: 'starting' | 'completed' | 'failed';
    error?: string;
}

export interface FilterUpdate {
    botId: string;
    tokenMint: string;
    results: {
        filter: string;
        passed: boolean;
        message?: string;
    }[];
}
