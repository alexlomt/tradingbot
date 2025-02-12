import { z } from 'zod';

export const createBotSchema = z.object({
    body: z.object({
        name: z.string().min(1, 'Bot name is required').max(100),
        walletPrivateKey: z.string().min(1, 'Wallet private key is required'),
        rpcEndpoint: z.string().url('Invalid RPC endpoint URL'),
        rpcWebsocketEndpoint: z.string().url('Invalid WebSocket endpoint URL'),
        commitmentLevel: z.enum(['processed', 'confirmed', 'finalized']),
        quoteMint: z.enum(['WSOL', 'USDC']),
        quoteAmount: z.string().regex(/^\d*\.?\d+$/, 'Invalid quote amount'),
        buySlippage: z.number().min(0).max(100),
        sellSlippage: z.number().min(0).max(100),
        takeProfit: z.number().min(0),
        stopLoss: z.number().min(0),
        autoSell: z.boolean(),
        transactionExecutor: z.enum(['default', 'warp', 'jito']),
        customFee: z.string().regex(/^\d*\.?\d+$/).optional(),
        minPoolSize: z.number().min(0),
        maxPoolSize: z.number().min(0),
        checkIfMutable: z.boolean(),
        checkIfSocials: z.boolean(),
        checkIfMintIsRenounced: z.boolean(),
        checkIfFreezable: z.boolean(),
        checkIfBurned: z.boolean()
    })
});

export const updateBotSchema = createBotSchema.partial();