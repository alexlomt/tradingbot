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
    GetKeyRotationStatusCommand,
    DescribeKeyCommand,
    ListAliasesCommand,
    DisableKeyCommand,
} from '@aws-sdk/client-kms';
import * as crypto from 'crypto';

@Injectable()
export class MasterKeyService implements OnModuleInit {
    private readonly kmsClient: KMSClient;
    private currentMasterKey: Buffer | null = null;
    private readonly keyAlias: string;
    private readonly region: string;
    private readonly backupEncryptionKey: Buffer;
    private lastRotationCheck: Date = new Date();
    private readonly rotationCheckInterval = 24 * 60 * 60 * 1000; // 24 hours
    private readonly keyMetadata = new Map<string, {
        createdAt: Date;
        lastRotated: Date;
        version: number;
        hash: string;
    }>();

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
        // Start periodic key rotation validation
        setInterval(() => this.validateKeyRotation(), this.rotationCheckInterval);
    }

    private async initializeMasterKey(): Promise<void> {
        try {
            const keyId = await this.getOrCreateKMSKey();
            await this.enableKeyRotation(keyId);
            await this.generateNewMasterKey(keyId);
            await this.verifyKeyIntegrity();
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
            const response = await this.kmsClient.send(new ListAliasesCommand({
                Limit: 100
            }));

            const alias = response.Aliases?.find(a => a.AliasName === `alias/${this.keyAlias}`);
            return alias?.TargetKeyId || null;
        } catch (error) {
            console.error('Error getting key ID from alias:', error);
            return null;
        }
    }

    private async createAlias(keyId: string): Promise<void> {
        try {
            await this.kmsClient.send(new CreateAliasCommand({
                AliasName: `alias/${this.keyAlias}`,
                TargetKeyId: keyId
            }));
        } catch (error) {
            console.error('Error creating alias:', error);
            throw new Error('Failed to create key alias');
        }
    }

    private async enableKeyRotation(keyId: string): Promise<void> {
        try {
            await this.kmsClient.send(new EnableKeyRotationCommand({
                KeyId: keyId
            }));
        } catch (error) {
            console.error('Error enabling key rotation:', error);
            throw new Error('Failed to enable key rotation');
        }
    }

    private async generateNewMasterKey(keyId: string): Promise<void> {
        try {
            const command = new GenerateDataKeyCommand({
                KeyId: keyId,
                KeySpec: 'AES_256'
            });

            const response = await this.kmsClient.send(command);
            if (!response.Plaintext || !response.CiphertextBlob) {
                throw new Error('Failed to generate data key');
            }

            this.currentMasterKey = Buffer.from(response.Plaintext);
            
            // Update key metadata
            this.keyMetadata.set(keyId, {
                createdAt: new Date(),
                lastRotated: new Date(),
                version: this.keyMetadata.get(keyId)?.version ?? 1,
                hash: this.calculateKeyHash(this.currentMasterKey)
            });

            // Securely store the encrypted key
            await this.storeEncryptedKey(Buffer.from(response.CiphertextBlob));
        } catch (error) {
            console.error('Error generating new master key:', error);
            throw new Error('Failed to generate new master key');
        }
    }

    private async validateKeyRotation(): Promise<void> {
        try {
            const keyId = await this.getKeyIdFromAlias();
            if (!keyId) throw new Error('Key ID not found');

            // Check KMS key rotation status
            const rotationStatusCommand = new GetKeyRotationStatusCommand({
                KeyId: keyId
            });
            const rotationStatus = await this.kmsClient.send(rotationStatusCommand);

            if (!rotationStatus.KeyRotationEnabled) {
                console.warn('Key rotation is not enabled for KMS key');
                await this.enableKeyRotation(keyId);
            }

            // Check key age
            const metadata = this.keyMetadata.get(keyId);
            if (!metadata) throw new Error('Key metadata not found');

            const keyAge = Date.now() - metadata.lastRotated.getTime();
            const maxKeyAge = 90 * 24 * 60 * 60 * 1000; // 90 days

            if (keyAge > maxKeyAge) {
                console.log('Key rotation needed due to age');
                await this.rotateKey(keyId);
            }

            // Verify key integrity
            await this.verifyKeyIntegrity();

        } catch (error) {
            console.error('Key rotation validation failed:', error);
            throw new Error('Failed to validate key rotation');
        }
    }

    private async verifyKeyIntegrity(): Promise<boolean> {
        try {
            if (!this.currentMasterKey) {
                throw new Error('Current master key is not initialized');
            }

            const keyId = await this.getKeyIdFromAlias();
            if (!keyId) throw new Error('Key ID not found');

            // 1. Verify key exists in KMS
            const describeKeyCommand = new DescribeKeyCommand({
                KeyId: keyId
            });
            const keyDescription = await this.kmsClient.send(describeKeyCommand);
            
            if (!keyDescription.KeyMetadata?.Enabled) {
                throw new Error('KMS key is disabled');
            }

            // 2. Verify key metadata
            const metadata = this.keyMetadata.get(keyId);
            if (!metadata) {
                throw new Error('Key metadata not found');
            }

            // 3. Verify key hash
            const currentHash = this.calculateKeyHash(this.currentMasterKey);
            if (currentHash !== metadata.hash) {
                throw new Error('Key hash mismatch');
            }

            // 4. Verify encryption/decryption functionality
            const testData = 'test-encryption-data';
            const encrypted = this.encrypt(testData);
            const decrypted = this.decrypt(encrypted);
            
            if (testData !== decrypted) {
                throw new Error('Encryption/decryption test failed');
            }

            return true;
        } catch (error) {
            console.error('Key integrity verification failed:', error);
            await this.handleKeyIntegrityFailure();
            return false;
        }
    }

    private async handleKeyIntegrityFailure(): Promise<void> {
        try {
            const keyId = await this.getKeyIdFromAlias();
            if (!keyId) throw new Error('Key ID not found');

            // Disable the compromised key
            await this.kmsClient.send(new DisableKeyCommand({
                KeyId: keyId
            }));

            // Generate new key
            await this.generateNewMasterKey(keyId);

            // Notify administrators
            await this.notifyKeyCompromise();
        } catch (error) {
            console.error('Failed to handle key integrity failure:', error);
            throw new Error('Key integrity recovery failed');
        }
    }

    private async rotateKey(keyId: string): Promise<void> {
        try {
            // Generate new key material
            await this.generateNewMasterKey(keyId);

            // Update key metadata
            const metadata = this.keyMetadata.get(keyId);
            if (metadata) {
                metadata.lastRotated = new Date();
                metadata.version += 1;
                this.keyMetadata.set(keyId, metadata);
            }

            console.log('Key rotation completed successfully');
        } catch (error) {
            console.error('Key rotation failed:', error);
            throw new Error('Failed to rotate key');
        }
    }

    private calculateKeyHash(key: Buffer): string {
        return crypto.createHash('sha256').update(key).digest('hex');
    }

    private async storeEncryptedKey(encryptedKey: Buffer): Promise<void> {
        // Implement secure storage of the encrypted key
        // This could be in a secure database or secure file system
        // For now, we're just storing in memory
        // TODO: Implement secure persistent storage
    }

    private async notifyKeyCompromise(): Promise<void> {
        // Implement notification system for security events
        // TODO: Implement proper notification system
        console.error('SECURITY ALERT: Key compromise detected');
    }

    // Public methods for encryption/decryption
    public encrypt(data: string): string {
        if (!this.currentMasterKey) {
            throw new Error('Master key not initialized');
        }

        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.currentMasterKey, iv);
        const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();

        // Combine IV, auth tag, and encrypted data
        return Buffer.concat([iv, authTag, encrypted]).toString('base64');
    }

    public decrypt(encryptedData: string): string {
        if (!this.currentMasterKey) {
            throw new Error('Master key not initialized');
        }

        const buffer = Buffer.from(encryptedData, 'base64');
        const iv = buffer.slice(0, 16);
        const authTag = buffer.slice(16, 32);
        const encrypted = buffer.slice(32);

        const decipher = crypto.createDecipheriv('aes-256-gcm', this.currentMasterKey, iv);
        decipher.setAuthTag(authTag);

        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    }
}
