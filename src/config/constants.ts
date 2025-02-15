export const SUBSCRIPTION_TIERS = {
    BASIC: {
        id: 'basic',
        name: 'BASIC',
        price: 49.99,
        limits: {
            maxTradeAmount: 50,
            maxDailyTrades: 1
        }
    },
    PREMIUM: {
        id: 'premium',
        name: 'PREMIUM',
        price: 149.99,
        limits: {
            maxTradeAmount: 200,
            maxDailyTrades: 3
        }
    },
    UNLIMITED: {
        id: 'unlimited',
        name: 'UNLIMITED',
        price: 999.99,
        limits: {
            maxTradeAmount: Infinity,
            maxDailyTrades: Infinity
        }
    },
    TRIAL: {
        id: 'trial',
        name: 'TRIAL',
        price: 0,
        limits: {
            maxTradeAmount: 50,
            maxDailyTrades: 1
        },
        duration: 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
    }
};

export const SOLANA_NETWORK_CONFIG = {
    RPC_ENDPOINTS: [
        'https://api.mainnet-beta.solana.com',
        'https://solana-api.projectserum.com',
        'https://rpc.ankr.com/solana'
    ],
    WSS_ENDPOINTS: [
        'wss://api.mainnet-beta.solana.com',
        'wss://solana-api.projectserum.com'
    ],
    COMMITMENT: 'confirmed' as const,
    TX_TIMEOUT: 30000, // 30 seconds
    RETRY_ATTEMPTS: 3
};

export const SECURITY_CONFIG = {
    ENCRYPTION_ALGORITHM: 'aes-256-gcm',
    KEY_LENGTH: 32,
    IV_LENGTH: 12,
    AUTH_TAG_LENGTH: 16,
    SALT_LENGTH: 32,
    ITERATIONS: 100000,
    MEMORY_COST: 4096,
    PARALLELISM: 1
};

export const RATE_LIMITS = {
    TRADE_REQUESTS: {
        windowMs: 60 * 1000, // 1 minute
        max: 10
    },
    WALLET_CREATION: {
        windowMs: 24 * 60 * 60 * 1000, // 24 hours
        max: 3
    }
};

export const ERROR_CODES = {
    INSUFFICIENT_FUNDS: 'E001',
    TRADE_LIMIT_EXCEEDED: 'E002',
    INVALID_WALLET: 'E003',
    SUBSCRIPTION_EXPIRED: 'E004',
    NETWORK_ERROR: 'E005',
    SLIPPAGE_EXCEEDED: 'E006'
};

export const PROGRAM_IDS = {
    TOKEN_PROGRAM: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    ASSOCIATED_TOKEN_PROGRAM: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    COMPUTE_BUDGET_PROGRAM: new PublicKey('ComputeBudget111111111111111111111111111111'),
    LOOKUP_TABLE_PROGRAM: new PublicKey('AddressLookupTab1e1111111111111111111111111')
};
