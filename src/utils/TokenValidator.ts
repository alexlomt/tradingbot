import {
    Connection,
    PublicKey,
} from '@solana/web3.js';
import {
    Token,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Cache } from './Cache';
import { logger } from './logger';
import { ErrorReporter } from './errorReporting';
import { RateLimiter } from './RateLimiter';

interface TokenMetadata {
    freezeAuthority: PublicKey | null;
    mintAuthority: PublicKey | null;
    supply: bigint;
    decimals: number;
    isInitialized: boolean;
    lastChecked: Date;
}

export class TokenValidator {
    private readonly metadataCache: Cache<string, TokenMetadata>;
    private readonly blacklistedTokens: Set<string>;
    private readonly rateLimiter: RateLimiter;

    constructor(
        private readonly connection: Connection,
        private readonly cacheDuration: number = 3600000 // 1 hour
    ) {
        this.metadataCache = new Cache<string, TokenMetadata>(cacheDuration);
        this.blacklistedTokens = new Set<string>();
        this.rateLimiter = new RateLimiter({
            maxRequests: 30,
            timeWindow: 1000
        });
    }

    async validateToken(
        token: Token,
        userId: string
    ): Promise<boolean> {
        try {
            if (this.blacklistedTokens.has(token.mint.toString())) {
                logger.warn(`Token ${token.mint} is blacklisted`);
                return false;
            }

            await this.rateLimiter.checkLimit();
            
            const metadata = await this.getTokenMetadata(token.mint);
            if (!metadata) return false;

            const validations = await Promise.all([
                this.validateTokenMetadata(metadata),
                this.validateTokenProgram(token.mint),
                this.validateSupply(metadata),
                this.checkTokenHistory(token.mint),
                this.validatePermissions(metadata, userId)
            ]);

            return validations.every(v => v);
        } catch (error) {
            ErrorReporter.reportError(error, {
                context: 'TokenValidator.validateToken',
                token: token.mint.toString(),
                userId
            });
            return false;
        }
    }

    private async getTokenMetadata(mint: PublicKey): Promise<TokenMetadata | null> {
        const cached = this.metadataCache.get(mint.toString());
        if (cached) return cached;

        try {
            await this.rateLimiter.checkLimit();
            
            const account = await this.connection.getAccountInfo(mint);
            if (!account || account.owner.toString() !== TOKEN_PROGRAM_ID.toString()) {
                return null;
            }

            const token = new Token(
                this.connection,
                mint,
                TOKEN_PROGRAM_ID,
                { publicKey: mint, secretKey: new Uint8Array(0) }
            );

            const [freezeAuthority, mintAuthority] = await Promise.all([
                token.getFreezeAuthority(),
                token.getMintAuthority()
            ]);

            const mintInfo = await token.getMintInfo();

            const metadata: TokenMetadata = {
                freezeAuthority,
                mintAuthority,
                supply: mintInfo.supply,
                decimals: mintInfo.decimals,
                isInitialized: mintInfo.isInitialized,
                lastChecked: new Date()
            };

            this.metadataCache.set(mint.toString(), metadata);
            return metadata;
        } catch (error) {
            logger.error(`Error fetching token metadata for ${mint}:`, error);
            return null;
        }
    }

    private async validateTokenMetadata(metadata: TokenMetadata): Promise<boolean> {
        if (!metadata.isInitialized) {
            logger.warn('Token is not initialized');
            return false;
        }

        if (metadata.decimals > 18) {
            logger.warn('Token decimals exceeds reasonable limit');
            return false;
        }

        return true;
    }

    private async validateTokenProgram(mint: PublicKey): Promise<boolean> {
        try {
            await this.rateLimiter.checkLimit();
            
            const account = await this.connection.getAccountInfo(mint);
            return account?.owner.equals(TOKEN_PROGRAM_ID) || false;
        } catch (error) {
            logger.error('Error validating token program:', error);
            return false;
        }
    }

    private async validateSupply(metadata: TokenMetadata): Promise<boolean> {
        // Check if supply is reasonable (not too high to prevent inflation attacks)
        const MAX_REASONABLE_SUPPLY = BigInt('1000000000000000000000000000'); // 1 quadrillion
        return metadata.supply <= MAX_REASONABLE_SUPPLY;
    }

    private async checkTokenHistory(mint: PublicKey): Promise<boolean> {
        try {
            await this.rateLimiter.checkLimit();
            
            // Check recent token transfers or other relevant history
            const signatures = await this.connection.getSignaturesForAddress(
                mint,
                { limit: 10 }
            );

            // Validate that the token has some transaction history
            return signatures.length > 0;
        } catch (error) {
            logger.error('Error checking token history:', error);
            return false;
        }
    }

    private async validatePermissions(
        metadata: TokenMetadata,
        userId: string
    ): Promise<boolean> {
        // Additional permission checks based on user subscription level
        return true; // Implement based on subscription requirements
    }

    public blacklistToken(mint: string): void {
        this.blacklistedTokens.add(mint);
        this.metadataCache.delete(mint);
    }

    public removeFromBlacklist(mint: string): void {
        this.blacklistedTokens.delete(mint);
    }

    public clearCache(): void {
        this.metadataCache.clear();
    }
}
