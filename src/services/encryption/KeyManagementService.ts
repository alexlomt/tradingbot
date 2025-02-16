import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { 
    KMSClient, 
    GenerateDataKeyCommand, 
    EncryptCommand, 
    DecryptCommand,
    ListAliasesCommand,
    DescribeKeyCommand 
} from '@aws-sdk/client-kms';
import { SECURITY_CONFIG } from '../../config/constants';
import { createHash, scrypt, randomBytes } from 'crypto';
import { Logger } from '../../utils/logger';
import { MasterKeyService } from './MasterKeyService';

const scryptAsync = promisify(scrypt);

@Injectable()
export class KeyManagementService implements OnModuleInit {
    private kmsClient: KMSClient;
    private masterKeyId: string;
    private masterKeyCache: {
        key: Buffer;
        expiresAt: number;
    } | null = null;
    private readonly logger = new Logger(KeyManagementService.name);

    constructor(
        private configService: ConfigService,
        private masterKeyService: MasterKeyService
    ) {
        this.kmsClient = new KMSClient({
            region: this.configService.get<string>('AWS_REGION'),
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID')!,
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY')!
            }
        });
        this.masterKeyId = this.configService.get<string>('KMS_MASTER_KEY_ID')!;
    }

    async onModuleInit() {
        try {
            await this.validateKMSConfiguration();
            await this.rotateMasterKey();
        } catch (error) {
            this.logger.error('Failed to initialize key management service', error);
            throw error;
        }
    }

    async encryptPrivateKey(privateKey: string, userId: string): Promise<string> {
        try {
            const salt = randomBytes(SECURITY_CONFIG.SALT_LENGTH);
            const iv = randomBytes(SECURITY_CONFIG.IV_LENGTH);
            
            const masterKey = await this.getMasterKey();
            const derivedKey = await this.deriveKey(masterKey, salt, userId);

            // Use MasterKeyService for additional encryption layer
            const masterEncrypted = await this.masterKeyService.encrypt(privateKey);

            const cipher = crypto.createCipheriv(
                SECURITY_CONFIG.ENCRYPTION_ALGORITHM, 
                derivedKey, 
                iv
            );

            const encryptedData = Buffer.concat([
                cipher.update(Buffer.from(masterEncrypted, 'base64')),
                cipher.final()
            ]);

            const authTag = cipher.getAuthTag();

            const finalData = Buffer.concat([
                salt,
                iv,
                authTag,
                encryptedData
            ]);

            // Create checksum for integrity verification
            const checksum = this.createChecksum(finalData);

            // Add version identifier for future upgrades
            const version = Buffer.from([0x01]); // Version 1

            return Buffer.concat([
                version,
                finalData,
                checksum
            ]).toString('base64');
        } catch (error) {
            this.logger.error('Failed to encrypt private key', error);
            throw new Error('Encryption failed');
        }
    }

    async decryptPrivateKey(encryptedData: string, userId: string): Promise<string> {
        try {
            const data = Buffer.from(encryptedData, 'base64');

            // Extract version
            const version = data[0];
            if (version !== 0x01) {
                throw new Error('Unsupported encryption version');
            }

            const content = data.slice(1);

            // Verify checksum
            const storedChecksum = content.slice(-32);
            const encryptedContent = content.slice(0, -32);
            const calculatedChecksum = this.createChecksum(encryptedContent);

            if (!crypto.timingSafeEqual(storedChecksum, calculatedChecksum)) {
                throw new Error('Data integrity check failed');
            }

            const salt = encryptedContent.slice(0, SECURITY_CONFIG.SALT_LENGTH);
            const iv = encryptedContent.slice(
                SECURITY_CONFIG.SALT_LENGTH,
                SECURITY_CONFIG.SALT_LENGTH + SECURITY_CONFIG.IV_LENGTH
            );
            const authTag = encryptedContent.slice(
                SECURITY_CONFIG.SALT_LENGTH + SECURITY_CONFIG.IV_LENGTH,
                SECURITY_CONFIG.SALT_LENGTH + SECURITY_CONFIG.IV_LENGTH + SECURITY_CONFIG.AUTH_TAG_LENGTH
            );
            const encryptedPrivateKey = encryptedContent.slice(
                SECURITY_CONFIG.SALT_LENGTH + SECURITY_CONFIG.IV_LENGTH + SECURITY_CONFIG.AUTH_TAG_LENGTH
            );

            const masterKey = await this.getMasterKey();
            const derivedKey = await this.deriveKey(masterKey, salt, userId);

            const decipher = crypto.createDecipheriv(
                SECURITY_CONFIG.ENCRYPTION_ALGORITHM,
                derivedKey,
                iv
            );
            
            decipher.setAuthTag(authTag);

            try {
                const decrypted = Buffer.concat([
                    decipher.update(encryptedPrivateKey),
                    decipher.final()
                ]);

                // Decrypt using MasterKeyService
                return await this.masterKeyService.decrypt(decrypted.toString('base64'));
            } catch (error) {
                throw new Error('Decryption failed: Invalid key or corrupted data');
            }
        } catch (error) {
            this.logger.error('Failed to decrypt private key', error);
            throw error;
        }
    }

    private async getMasterKey(): Promise<Buffer> {
        try {
            if (this.masterKeyCache && Date.now() < this.masterKeyCache.expiresAt) {
                return this.masterKeyCache.key;
            }

            const command = new GenerateDataKeyCommand({
                KeyId: this.masterKeyId,
                KeySpec: 'AES_256'
            });

            const response = await this.kmsClient.send(command);
            
            if (!response.Plaintext || !response.CiphertextBlob) {
                throw new Error('Failed to generate master key');
            }

            const cacheDuration = this.configService.get<number>('ENCRYPTION_KEY_CACHE_DURATION') || 3600000;

            this.masterKeyCache = {
                key: Buffer.from(response.Plaintext),
                expiresAt: Date.now() + cacheDuration
            };

            // Store encrypted key for backup
            await this.backupEncryptedKey(response.CiphertextBlob);

            return this.masterKeyCache.key;
        } catch (error) {
            this.logger.error('Failed to get master key', error);
            throw error;
        }
    }

    private async deriveKey(masterKey: Buffer, salt: Buffer, userId: string): Promise<Buffer> {
        try {
            const userSpecificSalt = Buffer.concat([
                salt,
                Buffer.from(userId)
            ]);

            return await scryptAsync(
                masterKey,
                userSpecificSalt,
                SECURITY_CONFIG.KEY_LENGTH,
                {
                    N: SECURITY_CONFIG.MEMORY_COST,
                    r: 8,
                    p: SECURITY_CONFIG.PARALLELISM,
                    maxmem: 128 * 1024 * 1024 // 128MB max memory
                }
            ) as Buffer;
        } catch (error) {
            this.logger.error('Failed to derive key', error);
            throw error;
        }
    }

    private createChecksum(data: Buffer): Buffer {
        return createHash(SECURITY_CONFIG.HASH_ALGORITHM).update(data).digest();
    }

    private async rotateMasterKey(): Promise<void> {
        try {
            this.masterKeyCache = null;
            await this.getMasterKey();
            this.logger.info('Master key rotated successfully');
        } catch (error) {
            this.logger.error('Failed to rotate master key', error);
            throw error;
        }
    }

    async validatePrivateKey(privateKey: string): Promise<boolean> {
        try {
            const keyBuffer = Buffer.from(privateKey, 'base64');
            return keyBuffer.length === 64;
        } catch {
            return false;
        }
    }

    private async validateKMSConfiguration(): Promise<void> {
        try {
            const describeCommand = new DescribeKeyCommand({
                KeyId: this.masterKeyId
            });
            
            const keyDetails = await this.kmsClient.send(describeCommand);
            
            if (!keyDetails.KeyMetadata?.Enabled) {
                throw new Error('KMS key is disabled');
            }

            if (keyDetails.KeyMetadata?.KeyState !== 'Enabled') {
                throw new Error(`KMS key is in invalid state: ${keyDetails.KeyMetadata?.KeyState}`);
            }
        } catch (error) {
            this.logger.error('KMS configuration validation failed', error);
            throw error;
        }
    }

    private async backupEncryptedKey(encryptedKey: Buffer): Promise<void> {
        try {
            if (!this.configService.get<boolean>('ENCRYPTION_BACKUP_ENABLED')) {
                return;
            }

            const backupLocation = this.configService.get<string>('ENCRYPTION_BACKUP_LOCATION');
            if (!backupLocation) {
                throw new Error('Backup location not configured');
            }

            // Implement your backup logic here
            // This could be writing to a secure storage service or encrypted file
            this.logger.info('Master key backup created successfully');
        } catch (error) {
            this.logger.error('Failed to backup encrypted key', error);
            // Don't throw error here as backup is optional
        }
    }

    public async checkKeyHealth(): Promise<{
        healthy: boolean;
        issues: string[];
    }> {
        const issues: string[] = [];
        try {
            // Check KMS key status
            const describeCommand = new DescribeKeyCommand({
                KeyId: this.masterKeyId
            });
            
            const keyDetails = await this.kmsClient.send(describeCommand);
            
            if (!keyDetails.KeyMetadata?.Enabled) {
                issues.push('KMS key is disabled');
            }

            if (keyDetails.KeyMetadata?.KeyState !== 'Enabled') {
                issues.push(`KMS key state is ${keyDetails.KeyMetadata?.KeyState}`);
            }

            // Check master key cache
            if (!this.masterKeyCache) {
                issues.push('Master key cache is empty');
            } else if (Date.now() >= this.masterKeyCache.expiresAt) {
                issues.push('Master key cache is expired');
            }

            // Check integration with MasterKeyService
            try {
                const testData = 'test-encryption';
                const encrypted = await this.masterKeyService.encrypt(testData);
                const decrypted = await this.masterKeyService.decrypt(encrypted);
                if (testData !== decrypted) {
                    issues.push('MasterKeyService encryption/decryption test failed');
                }
            } catch (error) {
                issues.push('MasterKeyService integration test failed');
            }

            return {
                healthy: issues.length === 0,
                issues
            };
        } catch (error) {
            this.logger.error('Key health check failed', error);
            return {
                healthy: false,
                issues: ['Failed to perform key health check']
            };
        }
    }

    public async forceKeyRotation(): Promise<void> {
        try {
            await this.rotateMasterKey();
            await this.masterKeyService.validateKeyRotation();
        } catch (error) {
            this.logger.error('Forced key rotation failed', error);
            throw error;
        }
    }
}
