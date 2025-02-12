// src/utils/wallet.ts
import { Keypair } from '@solana/web3.js';
import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import bs58 from 'bs58';
import { logger } from '../config/logger';

export class WalletUtils {
    static getWallet(privateKey: string): Keypair {
        try {
            // Handle binary format
            if (privateKey.startsWith('[')) {
                const raw = new Uint8Array(JSON.parse(privateKey));
                return Keypair.fromSecretKey(raw);
            }

            // Handle mnemonic
            if (privateKey.split(' ').length > 1) {
                const seed = mnemonicToSeedSync(privateKey, '');
                const path = `m/44'/501'/0'/0'`;
                return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
            }

            // Handle base58
            return Keypair.fromSecretKey(bs58.decode(privateKey));
        } catch (error) {
            logger.error('Error creating wallet:', error);
            throw new Error('Invalid wallet private key');
        }
    }

    static async validateWallet(wallet: Keypair, connection: Connection): Promise<boolean> {
        try {
            const balance = await connection.getBalance(wallet.publicKey);
            return balance > 0;
        } catch (error) {
            logger.error('Error validating wallet:', error);
            return false;
        }
    }
}
