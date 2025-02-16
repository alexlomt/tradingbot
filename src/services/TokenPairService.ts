import {
    Connection,
    PublicKey,
} from '@solana/web3.js';
import {
    Token,
    Currency,
    TokenAmount,
    ZERO
} from '@raydium-io/raydium-sdk';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Cache } from '../utils/Cache';
import { logger } from '../utils/logger';
import { RateLimiter } from '../utils/RateLimiter';
import { ErrorReporter } from '../utils/errorReporting';
import { BN } from 'bn.js';

export interface TokenPairConfig {
    wsol: {
        address: string;
        decimals: number;
    };
    usdc: {
        address: string;
        decimals: number;
    };
    defaultSlippage: number;
}

export class TokenPairService {
    private readonly tokenCache: Cache<string, Token>;
    private readonly balanceCache: Cache<string, TokenAmount>;
    private readonly rateLimiter: RateLimiter;
    public readonly WSOL: Token;
    public readonly USDC: Token;

    constructor(
        private readonly connection: Connection,
        private readonly config: TokenPairConfig,
        private readonly cacheDuration: number = 30000 // 30 seconds
    ) {
        this.tokenCache = new Cache<string, Token>(cacheDuration);
        this.balanceCache = new Cache<string, TokenAmount>(cacheDuration);
        this.rateLimiter = new RateLimiter({
            maxRequests: 30,
            timeWindow: 1000
        });

        this.WSOL = new Token(
            TOKEN_PROGRAM_ID,
            new PublicKey(config.wsol.address),
            config.wsol.decimals,
            'WSOL',
            'Wrapped SOL'
        );

        this.USDC = new Token(
            TOKEN_PROGRAM_ID,
            new PublicKey(config.usdc.address),
            config.usdc.decimals,
            'USDC',
            'USD Coin'
        );
    }

    async getTokenByMint(mint: PublicKey): Promise<Token> {
        const mintAddress = mint.toString();
        const cached = this.tokenCache.get(mintAddress);
        if (cached) return cached;

        try {
            await this.rateLimiter.checkLimit();
            
            const accountInfo = await this.connection.getAccountInfo(mint);
            if (!accountInfo) {
                throw new Error(`Token mint ${mintAddress} not found`);
            }

            const token = new Token(
                TOKEN_PROGRAM_ID,
                mint,
                accountInfo.data[0], // decimals
                '', // symbol will be fetched separately if needed
                '' // name will be fetched separately if needed
            );

            this.tokenCache.set(mintAddress, token);
            return token;
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'TokenPairService.getTokenByMint',
                mint: mintAddress
            });
            throw error;
        }
    }

    async getTokenBalance(
        token: Token,
        owner: PublicKey
    ): Promise<TokenAmount> {
        const cacheKey = `${token.mint.toString()}-${owner.toString()}`;
        const cached = this.balanceCache.get(cacheKey);
        if (cached) return cached;

        try {
            await this.rateLimiter.checkLimit();
            
            const balance = await this.connection.getTokenAccountBalance(owner);
            const amount = new TokenAmount(
                token,
                balance.value.amount,
                false
            );

            this.balanceCache.set(cacheKey, amount);
            return amount;
        } catch (error) {
            logger.error(`Error fetching token balance: ${error}`);
            return new TokenAmount(token, ZERO);
        }
    }

    calculateSlippage(
        amount: TokenAmount,
        slippagePercent: number = this.config.defaultSlippage
    ): TokenAmount {
        const slippageMultiplier = new BN(100 - slippagePercent);
        const amountWithSlippage = amount.raw
            .mul(slippageMultiplier)
            .div(new BN(100));
        
        return new TokenAmount(
            amount.token,
            amountWithSlippage,
            false
        );
    }

    isWSOL(token: Token): boolean {
        return token.mint.equals(this.WSOL.mint);
    }

    isUSDC(token: Token): boolean {
        return token.mint.equals(this.USDC.mint);
    }

    clearCache(): void {
        this.tokenCache.clear();
        this.balanceCache.clear();
    }
}
