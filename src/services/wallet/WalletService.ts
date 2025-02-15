import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as anchor from '@project-serum/anchor';
import { KeyManagementService } from '../encryption/KeyManagementService';
import { MarketService } from '../market/MarketService';
import { RedisService } from '../cache/RedisService';
import { Wallet } from '../../database/schemas/Wallet.schema';
import { SOLANA_NETWORK_CONFIG } from '../../config/constants';
import { WalletBalance, TokenBalance } from '../../types/wallet.types';

@Injectable()
export class WalletService implements OnModuleInit {
    private readonly logger = new Logger(WalletService.name);
    private connection: Connection;
    private provider: anchor.Provider;
    private balanceUpdateInterval: NodeJS.Timeout;

    constructor(
        @InjectModel(Wallet.name) private walletModel: Model<Wallet>,
        private keyManagementService: KeyManagementService,
        private marketService: MarketService,
        private redisService: RedisService,
        private configService: ConfigService
    ) {
        this.connection = new Connection(
            SOLANA_NETWORK_CONFIG.RPC_ENDPOINTS[0],
            SOLANA_NETWORK_CONFIG.COMMITMENT
        );
        this.provider = new anchor.Provider(
            this.connection,
            {} as any,
            { commitment: SOLANA_NETWORK_CONFIG.COMMITMENT }
        );
    }

    async onModuleInit() {
        this.startBalanceUpdateService();
    }

    private startBalanceUpdateService() {
        this.balanceUpdateInterval = setInterval(async () => {
            try {
                const activeWallets = await this.walletModel.find({ isActive: true });
                for (const wallet of activeWallets) {
                    await this.updateWalletBalances(wallet);
                }
            } catch (error) {
                this.logger.error('Failed to update wallet balances', error);
            }
        }, 30000); // Update every 30 seconds
    }

    async createWallet(userId: string, metadata?: { name?: string; tags?: string[] }): Promise<Wallet> {
        const keypair = Keypair.generate();
        const publicKey = keypair.publicKey.toString();
        const privateKey = Buffer.from(keypair.secretKey).toString('base64');

        const encryptedPrivateKey = await this.keyManagementService.encryptPrivateKey(
            privateKey,
            userId
        );

        const wallet = new this.walletModel({
            userId,
            publicKey,
            encryptedPrivateKey,
            origin: 'created',
            metadata: {
                ...metadata,
                createdAt: new Date(),
                lastBackup: new Date()
            },
            balances: {
                solana: 0,
                tokens: []
            },
            authorizedIps: [],
            isActive: true,
            lastUsed: new Date(),
            tradingVolume: 0,
            dailyTradeCount: 0,
            lastDailyReset: new Date()
        });

        await wallet.save();
        await this.createAssociatedTokenAccounts(keypair);
        await this.updateWalletBalances(wallet);

        return wallet;
    }

    async importWallet(
        userId: string, 
        privateKey: string, 
        metadata?: { name?: string; tags?: string[] }
    ): Promise<Wallet> {
        if (!this.keyManagementService.validatePrivateKey(privateKey)) {
            throw new Error('Invalid private key format');
        }

        const keypair = Keypair.fromSecretKey(
            Buffer.from(privateKey, 'base64')
        );

        const publicKey = keypair.publicKey.toString();
        const existingWallet = await this.walletModel.findOne({ 
            userId, 
            publicKey 
        });

        if (existingWallet) {
            throw new Error('Wallet already exists for this user');
        }

        const encryptedPrivateKey = await this.keyManagementService.encryptPrivateKey(
            privateKey,
            userId
        );

        const wallet = new this.walletModel({
            userId,
            publicKey,
            encryptedPrivateKey,
            origin: 'imported',
            metadata: {
                ...metadata,
                createdAt: new Date(),
                lastBackup: new Date()
            },
            balances: {
                solana: 0,
                tokens: []
            },
            authorizedIps: [],
            isActive: true,
            lastUsed: new Date(),
            tradingVolume: 0,
            dailyTradeCount: 0,
            lastDailyReset: new Date()
        });

        await wallet.save();
        await this.updateWalletBalances(wallet);

        return wallet;
    }

    private async createAssociatedTokenAccounts(keypair: Keypair) {
        const tokens = await this.marketService.getActiveTokens();
        
        for (const token of tokens) {
            try {
                const mint = new PublicKey(token.mintAddress);
                const tokenInstance = new Token(
                    this.connection,
                    mint,
                    TOKEN_PROGRAM_ID,
                    keypair
                );

                await tokenInstance.getOrCreateAssociatedAccountInfo(
                    keypair.publicKey
                );
            } catch (error) {
                this.logger.error(
                    `Failed to create associated token account for ${token.symbol}`,
                    error
                );
            }
        }
    }

    async updateWalletBalances(wallet: Wallet): Promise<void> {
        const publicKey = new PublicKey(wallet.publicKey);

        try {
            const solanaBalance = await this.connection.getBalance(publicKey);
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                publicKey,
                { programId: TOKEN_PROGRAM_ID }
            );

            const tokenBalances: TokenBalance[] = [];
            for (const { account, pubkey } of tokenAccounts.value) {
                const parsedInfo = account.data.parsed.info;
                const tokenBalance = {
                    mint: parsedInfo.mint,
                    balance: Number(parsedInfo.tokenAmount.amount),
                    decimals: parsedInfo.tokenAmount.decimals,
                    associatedTokenAddress: pubkey.toString()
                };

                const cacheKey = `balance:${wallet.publicKey}:${parsedInfo.mint}`;
                await this.redisService.set(cacheKey, JSON.stringify(tokenBalance), 300);
                tokenBalances.push(tokenBalance);
            }

            await this.walletModel.updateOne(
                { _id: wallet._id },
                { 
                    $set: { 
                        'balances.solana': solanaBalance,
                        'balances.tokens': tokenBalances,
                        'lastBalanceUpdate': new Date()
                    }
                }
            );
        } catch (error) {
            this.logger.error(
                `Failed to update balances for wallet ${wallet.publicKey}`,
                error
            );
        }
    }

    async getWalletBalances(userId: string, publicKey: string): Promise<WalletBalance> {
        const wallet = await this.walletModel.findOne({ 
            userId, 
            publicKey,
            isActive: true
        });

        if (!wallet) {
            throw new Error('Wallet not found');
        }

        const cachedBalances = await this.getCachedBalances(publicKey);
        if (cachedBalances) {
            return cachedBalances;
        }

        await this.updateWalletBalances(wallet);
        return wallet.balances;
    }

    private async getCachedBalances(publicKey: string): Promise<WalletBalance | null> {
        const solanaBalanceKey = `balance:${publicKey}:solana`;
        const solanaBalance = await this.redisService.get(solanaBalanceKey);

        if (!solanaBalance) {
            return null;
        }

        const tokenBalances: TokenBalance[] = [];
        const tokenKeys = await this.redisService.keys(`balance:${publicKey}:*`);
        
        for (const key of tokenKeys) {
            if (key !== solanaBalanceKey) {
                const tokenBalance = await this.redisService.get(key);
                if (tokenBalance) {
                    tokenBalances.push(JSON.parse(tokenBalance));
                }
            }
        }

        return {
            solana: Number(solanaBalance),
            tokens: tokenBalances
        };
    }

    async onDestroy() {
        if (this.balanceUpdateInterval) {
            clearInterval(this.balanceUpdateInterval);
        }
    }
}
