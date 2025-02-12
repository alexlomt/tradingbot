import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MintLayout } from '@solana/spl-token';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../../config/logger';

interface FilterResult {
    passed: boolean;
    message?: string;
}

interface FilterConfig {
    checkIfMutable: boolean;
    checkIfSocials: boolean;
    checkIfMintIsRenounced: boolean;
    checkIfFreezable: boolean;
    checkIfBurned: boolean;
    minPoolSize: TokenAmount;
    maxPoolSize: TokenAmount;
    quoteToken: Token;
    filterCheckInterval: number;
    filterCheckDuration: number;
    consecutiveFilterMatches: number;
}

export class FilterChain {
    private metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>;

    constructor(
        private readonly connection: Connection,
        private readonly config: FilterConfig
    ) {
        this.metadataSerializer = this.getMetadataSerializer();
    }

    async executeFilterChain(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult[]> {
        const results: FilterResult[] = [];

        // Execute all configured filters
        if (this.config.checkIfBurned) {
            results.push(await this.checkLPBurn(poolKeys));
        }

        if (this.config.checkIfMutable || this.config.checkIfSocials) {
            results.push(await this.checkMetadata(poolKeys));
        }

        if (this.config.checkIfMintIsRenounced || this.config.checkIfFreezable) {
            results.push(await this.checkMintAuthority(poolKeys));
        }

        if (!this.config.minPoolSize.isZero() || !this.config.maxPoolSize.isZero()) {
            results.push(await this.checkPoolSize(poolKeys));
        }

        return results;
    }

    private async checkLPBurn(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
        try {
            const amount = await this.connection.getTokenSupply(
                poolKeys.lpMint,
                this.connection.commitment
            );
            const burned = amount.value.uiAmount === 0;
            return {
                passed: burned,
                message: burned ? undefined : "Creator didn't burn LP tokens"
            };
        } catch (error) {
            if (error.code === -32602) {
                return { passed: true };
            }
            logger.error('LP burn check failed:', error);
            return {
                passed: false,
                message: 'Failed to verify LP burn status'
            };
        }
    }

    private async checkMetadata(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
        try {
            const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
            const metadataAccount = await this.connection.getAccountInfo(
                metadataPDA.publicKey,
                this.connection.commitment
            );

            if (!metadataAccount?.data) {
                return {
                    passed: false,
                    message: 'Failed to fetch metadata'
                };
            }

            const metadata = this.metadataSerializer.deserialize(metadataAccount.data)[0];

            // Check mutability if configured
            if (this.config.checkIfMutable && metadata.isMutable) {
                return {
                    passed: false,
                    message: 'Token metadata is mutable'
                };
            }

            // Check socials if configured
            if (this.config.checkIfSocials) {
                const hasSocials = await this.verifySocials(metadata);
                if (!hasSocials) {
                    return {
                        passed: false,
                        message: 'No social links found'
                    };
                }
            }

            return { passed: true };
        } catch (error) {
            logger.error('Metadata check failed:', error);
            return {
                passed: false,
                message: 'Failed to verify metadata'
            };
        }
    }

    private async checkMintAuthority(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
        try {
            const accountInfo = await this.connection.getAccountInfo(
                poolKeys.baseMint,
                this.connection.commitment
            );

            if (!accountInfo?.data) {
                return {
                    passed: false,
                    message: 'Failed to fetch mint info'
                };
            }

            const mintInfo = MintLayout.decode(accountInfo.data);

            // Check mint authority if configured
            if (this.config.checkIfMintIsRenounced && mintInfo.mintAuthorityOption !== 0) {
                return {
                    passed: false,
                    message: 'Mint authority not renounced'
                };
            }

            // Check freeze authority if configured
            if (this.config.checkIfFreezable && mintInfo.freezeAuthorityOption !== 0) {
                return {
                    passed: false,
                    message: 'Token is freezable'
                };
            }

            return { passed: true };
        } catch (error) {
            logger.error('Mint authority check failed:', error);
            return {
                passed: false,
                message: 'Failed to verify mint authorities'
            };
        }
    }

    private async checkPoolSize(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
        try {
            const balance = await this.connection.getTokenAccountBalance(
                poolKeys.quoteVault,
                this.connection.commitment
            );
            const poolSize = new TokenAmount(
                this.config.quoteToken,
                balance.value.amount,
                false
            );

            if (!this.config.minPoolSize.isZero() && poolSize.lt(this.config.minPoolSize)) {
                return {
                    passed: false,
                    message: `Pool size ${poolSize.toFixed()} below minimum ${this.config.minPoolSize.toFixed()}`
                };
            }

            if (!this.config.maxPoolSize.isZero() && poolSize.gt(this.config.maxPoolSize)) {
                return {
                    passed: false,
                    message: `Pool size ${poolSize.toFixed()} above maximum ${this.config.maxPoolSize.toFixed()}`
                };
            }

            return { passed: true };
        } catch (error) {
            logger.error('Pool size check failed:', error);
            return {
                passed: false,
                message: 'Failed to verify pool size'
            };
        }
    }

    private async verifySocials(metadata: MetadataAccountData): Promise<boolean> {
        try {
            const response = await fetch(metadata.uri);
            const data = await response.json();
            return Object.values(data?.extensions ?? {}).some(
                (value: any) => value !== null && value.length > 0
            );
        } catch {
            return false;
        }
    }

    private getMetadataSerializer(): Serializer<MetadataAccountDataArgs, MetadataAccountData> {
        return getMetadataAccountDataSerializer(); // From @metaplex-foundation/mpl-token-metadata
    }
}