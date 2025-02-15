import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Wallet, WalletDocument } from '../../database/schemas/Wallet.schema';
import { KeyManagementService } from '../encryption/KeyManagementService';
import { ConfigService } from '@nestjs/config';
import { Connection } from '@solana/web3.js';
import { createHash } from 'crypto';
import * as bs58 from 'bs58';

@Injectable()
export class WalletService {
    private readonly solanaConnection: Connection;

    constructor(
        @InjectModel(Wallet.name) private walletModel: Model<WalletDocument>,
        private readonly keyManagementService: KeyManagementService,
        private readonly configService: ConfigService
    ) {
        this.solanaConnection = new Connection(
            this.configService.get<string>('SOLANA_RPC_URL')!,
            'confirmed'
        );
    }

    async createWallet(userId: string, metadata?: { name?: string; tags?: string[] }): Promise<Wallet> {
        const activeWallets = await this.getActiveWalletsCount(userId);
        const maxWallets = this.configService.get<number>('MAX_WALLETS_PER_USER') || 3;
        
        if (activeWallets >= maxWallets) {
            throw new BadRequestException(`Maximum number of active wallets (${maxWallets}) reached`);
        }

        const { publicKey, privateKey } = await this.keyManagementService.generateWallet();
        const encryptedPrivateKey = await this.keyManagementService.encryptPrivateKey(privateKey, userId);

        const wallet = new this.walletModel({
            userId,
            publicKey,
            encryptedPrivateKey,
            origin: 'created',
            metadata: {
                ...metadata,
                createdFrom: 'platform'
            },
            lastDailyReset: new Date()
        });

        try {
            return await wallet.save();
        } catch (error) {
            if (error.code === 11000) { // Duplicate key error
                throw new ConflictException('Wallet already exists');
            }
            throw error;
        }
    }

    async importWallet(
        userId: string, 
        privateKey: string, 
        metadata?: { name?: string; tags?: string[] }
    ): Promise<Wallet> {
        if (!this.keyManagementService.validatePrivateKey(privateKey)) {
            throw new BadRequestException('Invalid private key');
        }

        const activeWallets = await this.getActiveWalletsCount(userId);
        const maxWallets = this.configService.get<number>('MAX_WALLETS_PER_USER') || 3;
        
        if (activeWallets >= maxWallets) {
            throw new BadRequestException(`Maximum number of active wallets (${maxWallets}) reached`);
        }

        const web3 = require('@solana/web3.js');
        const keypair = web3.Keypair.fromSecretKey(Buffer.from(privateKey, 'base64'));
        const publicKey = keypair.publicKey.toString();

        // Check if wallet already exists
        const existingWallet = await this.walletModel.findOne({ 
            userId, 
            publicKey 
        });

        if (existingWallet) {
            throw new ConflictException('Wallet already imported');
        }

        const encryptedPrivateKey = await this.keyManagementService.encryptPrivateKey(privateKey, userId);

        const wallet = new this.walletModel({
            userId,
            publicKey,
            encryptedPrivateKey,
            origin: 'imported',
            metadata: {
                ...metadata,
                createdFrom: 'import'
            },
            lastDailyReset: new Date()
        });

        return await wallet.save();
    }

    async getWallet(userId: string, publicKey: string): Promise<Wallet> {
        const wallet = await this.walletModel.findOne({ 
            userId, 
            publicKey,
            isActive: true 
        });

        if (!wallet) {
            throw new NotFoundException('Wallet not found');
        }

        return wallet;
    }

    async getWalletPrivateKey(userId: string, publicKey: string): Promise<string> {
        const wallet = await this.getWallet(userId, publicKey);
        return this.keyManagementService.decryptPrivateKey(wallet.encryptedPrivateKey, userId);
    }

    async deactivateWallet(userId: string, publicKey: string): Promise<void> {
        const result = await this.walletModel.updateOne(
            { userId, publicKey, isActive: true },
            { 
                $set: { 
                    isActive: false,
                    lastUsed: new Date()
                } 
            }
        );

        if (result.modifiedCount === 0) {
            throw new NotFoundException('Active wallet not found');
        }
    }

    async updateWalletMetadata(
        userId: string, 
        publicKey: string, 
        metadata: { name?: string; tags?: string[] }
    ): Promise<Wallet> {
        const wallet = await this.getWallet(userId, publicKey);
        wallet.metadata = { ...wallet.metadata, ...metadata };
        return await wallet.save();
    }

    async resetDailyLimits(): Promise<void> {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        await this.walletModel.updateMany(
            { lastDailyReset: { $lt: yesterday } },
            { 
                $set: { 
                    dailyTradeCount: 0,
                    lastDailyReset: new Date()
                } 
            }
        );
    }

    private async getActiveWalletsCount(userId: string): Promise<number> {
        return await this.walletModel.countDocuments({ 
            userId, 
            isActive: true 
        });
    }

    async validateWalletAccess(userId: string, publicKey: string, clientIp: string): Promise<boolean> {
        const wallet = await this.getWallet(userId, publicKey);
        
        if (!wallet.authorizedIps.includes(clientIp)) {
            // Log unauthorized access attempt
            console.warn(`Unauthorized wallet access attempt from IP ${clientIp} for wallet ${publicKey}`);
            return false;
        }

        return true;
    }

    async authorizeIp(userId: string, publicKey: string, ip: string): Promise<void> {
        const wallet = await this.getWallet(userId, publicKey);
        
        if (!wallet.authorizedIps.includes(ip)) {
            wallet.authorizedIps.push(ip);
            await wallet.save();
        }
    }
}
