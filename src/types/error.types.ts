export enum ErrorCode {
    // HTTP Status code based errors
    BAD_REQUEST = 400,
    UNAUTHORIZED = 401,
    FORBIDDEN = 403,
    NOT_FOUND = 404,
    CONFLICT = 409,
    INTERNAL_SERVER_ERROR = 500,
    SERVICE_UNAVAILABLE = 503,

    // Custom error codes
    VALIDATION_ERROR = 40001,
    RATE_LIMIT_EXCEEDED = 40002,
    INSUFFICIENT_FUNDS = 40003,
    INVALID_SIGNATURE = 40004,
    BLOCKCHAIN_ERROR = 50001,
    MARKET_UNAVAILABLE = 50002,
    ORDER_FAILED = 50003,
    TRADING_SUSPENDED = 50004
}

export interface ErrorResponse {
    status: number;
    error: string;
    message: string;
    details?: any;
    timestamp: string;
}
