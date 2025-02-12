// src/utils/transaction.ts
import { 
    Connection, 
    PublicKey, 
    TransactionMessage, 
    VersionedTransaction,
    ComputeBudgetProgram
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { logger } from '../config/logger';

export class TransactionUtils {
    static async createAssociatedTokenAccount(
        connection: Connection,
        wallet: Keypair,
        mint: PublicKey
    ): Promise<PublicKey> {
        try {
            const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
            const accountInfo = await connection.getAccountInfo(ata);
            
            if (!accountInfo) {
                // Account doesn't exist, create it
                const instruction = createAssociatedTokenAccountIdempotentInstruction(
                    wallet.publicKey,
                    ata,
                    wallet.publicKey,
                    mint
                );

                const latestBlockhash = await connection.getLatestBlockhash();
                const messageV0 = new TransactionMessage({
                    payerKey: wallet.publicKey,
                    recentBlockhash: latestBlockhash.blockhash,
                    instructions: [instruction]
                }).compileToV0Message();

                const transaction = new VersionedTransaction(messageV0);
                transaction.sign([wallet]);

                await connection.sendTransaction(transaction);
            }

            return ata;
        } catch (error) {
            logger.error('Error creating associated token account:', error);
            throw error;
        }
    }

    static async estimateTransactionFee(
        connection: Connection,
        instructions: TransactionInstruction[],
        signers: Keypair[]
    ): Promise<number> {
        try {
            const latestBlockhash = await connection.getLatestBlockhash();
            const messageV0 = new TransactionMessage({
                payerKey: signers[0].publicKey,
                recentBlockhash: latestBlockhash.blockhash,
                instructions
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign(signers);

            const fee = await connection.getFeeForMessage(messageV0);
            return fee.value;
        } catch (error) {
            logger.error('Error estimating transaction fee:', error);
            throw error;
        }
    }
}
