import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    KMSClient,
    GenerateDataKeyCommand,
    DecryptCommand,
    CreateAliasCommand,
    UpdateAliasCommand,
    ScheduleKeyDeletionCommand,
    CreateKeyCommand,
    EnableKeyRotationCommand,
    TagResourceCommand,
} from '@aws-sdk/client-kms';
import * as crypto from 'crypto';

@Injectable()
export class MasterKeyService implements OnModuleInit {
    private readonly kmsClient: KMSClient;
    private currentMasterKey: Buffer | null = null;
    private readonly keyAlias: string;
    private readonly region: string;
    private readonly backupEncryptionKey: Buffer;

    constructor(private readonly configService: ConfigService) {
        this.region = this.configService.get<string>('AWS_REGION') || 'us-east-1';
        this.keyAlias = this.configService.get<string>('KMS_KEY_ALIAS') || 'trading-bot-master-key';
        
        // Backup encryption key for emergency recovery, stored in separate secure location
        const backupKey = this.configService.get<string>('BACKUP_ENCRYPTION_KEY');
        if (!backupKey) {
            throw new Error('Backup encryption key not configured');
        }
        this.backupEncryptionKey = Buffer.from(backupKey, 'hex');

        this.kmsClient = new KMSClient({ 
            region: this.region,
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID')!,
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY')!
            }
        });
    }

    async onModuleInit() {
        await this.initializeMasterKey();
    }

    private async initializeMasterKey(): Promise<void> {
        try {
            const keyId = await this.getOrCreateKMSKey();
            await this.enableKeyRotation(keyId);
            await this.generateNewMasterKey(keyId);
        } catch (error) {
            console.error('Failed to initialize master key:', error);
            throw new Error('Master key initialization failed');
        }
    }

    private async getOrCreateKMSKey(): Promise<string> {
        try {
            // Try to get existing key ID from alias
            const keyId = await this.getKeyIdFromAlias();
            if (keyId) return keyId;

            // Create new KMS key if none exists
            const createKeyCommand = new CreateKeyCommand({
                Description: 'Master key for trading bot wallet encryption',
                KeyUsage: 'ENCRYPT_DECRYPT',
                Origin: 'AWS_KMS',
                MultiRegion: true,
                Tags: [
                    {
                        TagKey: 'Application',
                        TagValue: 'TradingBot'
                    },
                    {
                        TagKey: 'Environment',
                        TagValue: this.configService.get<string>('NODE_ENV') || 'production'
                    }
                ]
            });

            const { KeyMetadata } = await this.kmsClient.send(createKeyCommand);
            if (!KeyMetadata?.KeyId) throw new Error('Failed to create KMS key');

            // Create alias for the new key
            await this.createAlias(KeyMetadata.KeyId);

            return KeyMetadata.KeyId;
        } catch (error) {
            console.error('Error in getOrCreateKMSKey:', error);
            throw new Error('Failed to get or create KMS key');
        }
    }

    private async getKeyIdFromAlias(): Promise<string | null> {
        try {
            const response = await this.kmsClient.send(new CreateAliasCommand({
                AliasName: `alias/${this.keyAlias}`,
                TargetKeyId: '' // This will fail if alias doesn't exist
            }));
            return response.TargetKeyId || null;
        } catch (error) {
            return null;
        }
    }

    private async createAlias(keyId: string): Promise<void> {
        const createAliasCommand = new CreateAliasCommand({
            AliasName: `alias/${this.keyAlias}`,
            TargetKeyId: keyId
        });
        await this.kmsClient.send(createAliasCommand);
    }

    private async enableKeyRotation(keyId: string): Promise<void> {
        const command = new EnableKeyRotationCommand({
            KeyId: keyId
        });
        await this.kmsClient.send(command);
    }

    private async generateNewMasterKey(keyId: string): Promise<void> {
        const command = new GenerateDataKeyCommand({
            KeyId: keyId,
            KeySpec: 'AES_256'
        });

        const response = await this.kmsClient.send(command);
        if (!response.Plaintext || !response.CiphertextBlob) {
            throw new Error('Failed to generate data key');
        }

        this.currentMasterKey = Buffer.from(response.Plaintext);

        // Create encrypted backup of the master key
        const backupEncrypted = this.createBackupKey(this.currentMasterKey);
        
        // Store encrypted backup in secure storage (implement based on your infrastructure)
        await this.storeBackupKey(backupEncrypted);
    }

    private createBackupKey(masterKey: Buffer): Buffer {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.backupEncryptionKey, iv);
        
        const encrypted = Buffer.concat([
            cipher.update(masterKey),
            cipher.final()
        ]);

        const authTag = cipher.getAuthTag();

        return Buffer.concat([iv, authTag, encrypted]);
    }

    private async storeBackupKey(encryptedBackup: Buffer): Promise<void> {
        // Implement secure storage of backup key
        // This could be a separate AWS KMS key, HSM, or other secure storage
        // For this implementation, we'll use AWS Secrets Manager
        // Implementation details would depend on your infrastructure
    }

    async getMasterKey(): Promise<Buffer> {
        if (!this.currentMasterKey) {
            throw new Error('Master key not initialized');
        }
        return this.currentMasterKey;
    }

    async rotateMasterKey(): Promise<void> {
        const keyId = await this.getOrCreateKMSKey();
        await this.generateNewMasterKey(keyId);
    }

    async emergencyKeyRecovery(): Promise<Buffer> {
        // Implement emergency key recovery process
        // This should include multiple approval steps and audit logging
        throw new Error('Emergency key recovery requires manual intervention');
    }

    async scheduleKeyDeletion(keyId: string, pendingWindowInDays: number = 7): Promise<void> {
        const command = new ScheduleKeyDeletionCommand({
            KeyId: keyId,
            PendingWindowInDays: pendingWindowInDays
        });
        await this.kmsClient.send(command);
    }
}
