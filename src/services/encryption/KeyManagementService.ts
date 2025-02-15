import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { 
    KMSClient, 
    GenerateDataKeyCommand, 
    EncryptCommand, 
    DecryptCommand 
} from '@aws-sdk/client-kms';
import { SECURITY_CONFIG } from '../../config/constants';
import { createHash, scrypt, randomBytes } from 'crypto';

const scryptAsync = promisify(scrypt);

@Injectable()
export class KeyManagementService implements OnModuleInit {
    private kmsClient: KMSClient;
    private masterKeyId: string;
    private masterKeyCache: {
        key: Buffer;
        expiresAt: number;
    } | null = null;

    constructor(private configService: ConfigService) {
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
        await this.rotateMasterKey();
    }

    async encryptPrivateKey(privateKey: string, userId: string): Promise<string> {
        const salt = randomBytes(SECURITY_CONFIG.SALT_LENGTH);
        const iv = randomBytes(SECURITY_CONFIG.IV_LENGTH);
        
        const masterKey = await this.getMasterKey();
        const derivedKey = await this.deriveKey(masterKey, salt, userId);

        const cipher = crypto.createCipheriv(
            SECURITY_CONFIG.ENCRYPTION_ALGORITHM, 
            derivedKey, 
            iv
        );

        const encryptedData = Buffer.concat([
            cipher.update(Buffer.from(privateKey, 'base64')),
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

        return Buffer.concat([
            finalData,
            checksum
        ]).toString('base64');
    }

    async decryptPrivateKey(encryptedData: string, userId: string): Promise<string> {
        const data = Buffer.from(encryptedData, 'base64');

        // Verify checksum
        const storedChecksum = data.slice(-32);
        const encryptedContent = data.slice(0, -32);
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

            return decrypted.toString('base64');
        } catch (error) {
            throw new Error('Decryption failed: Invalid key or corrupted data');
        }
    }

    private async getMasterKey(): Promise<Buffer> {
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

        this.masterKeyCache = {
            key: Buffer.from(response.Plaintext),
            expiresAt: Date.now() + 3600000 // 1 hour
        };

        return this.masterKeyCache.key;
    }

    private async deriveKey(masterKey: Buffer, salt: Buffer, userId: string): Promise<Buffer> {
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
                p: SECURITY_CONFIG.PARALLELISM
            }
        ) as Buffer;
    }

    private createChecksum(data: Buffer): Buffer {
        return createHash('sha256').update(data).digest();
    }

    private async rotateMasterKey(): Promise<void> {
        this.masterKeyCache = null;
        await this.getMasterKey();
    }

    async validatePrivateKey(privateKey: string): Promise<boolean> {
        try {
            const keyBuffer = Buffer.from(privateKey, 'base64');
            return keyBuffer.length === 64;
        } catch {
            return false;
        }
    }
}
