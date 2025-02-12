// src/utils/security.ts
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { KMS } from 'aws-sdk';
import { logger } from '../config/logger';

export class SecurityUtils {
    private static kms = new KMS({
        region: process.env.AWS_REGION
    });

    static async encryptWalletKey(privateKey: string): Promise<string> {
        try {
            const { CiphertextBlob } = await this.kms.encrypt({
                KeyId: process.env.AWS_KMS_KEY_ID!,
                Plaintext: Buffer.from(privateKey)
            }).promise();

            return CiphertextBlob!.toString('base64');
        } catch (error) {
            logger.error('Error encrypting wallet key:', error);
            throw new Error('Failed to encrypt wallet key');
        }
    }

    static async decryptWalletKey(encryptedKey: string): Promise<string> {
        try {
            const { Plaintext } = await this.kms.decrypt({
                CiphertextBlob: Buffer.from(encryptedKey, 'base64')
            }).promise();

            return Plaintext!.toString();
        } catch (error) {
            logger.error('Error decrypting wallet key:', error);
            throw new Error('Failed to decrypt wallet key');
        }
    }

    static generateRandomToken(length: number = 32): string {
        return randomBytes(length).toString('hex');
    }
}
