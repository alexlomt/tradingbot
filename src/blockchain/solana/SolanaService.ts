import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    SystemProgram,
    sendAndConfirmTransaction,
    TransactionInstruction,
    Commitment,
    VersionedTransaction,
    TransactionMessage,
    RpcResponseAndContext,
    SignatureResult
} from '@solana/web3.js';
import { Market, DexInstructions } from '@project-serum/serum';
import { TokenInstructions } from '@project-serum/serum';
import { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { MetricsService } from '../../services/metrics/MetricsService';
import { CircuitBreakerService } from '../../services/circuit-breaker/CircuitBreakerService';
import { NotificationService } from '../../services/notification/NotificationService';
import { 
    SolanaConfig, 
    TransactionResult,
    TokenAccountInfo,
    NetworkStatus
} from './types';

@Injectable()
export class SolanaService implements OnModuleInit {
    private readonly logger = new Logger(SolanaService.name);
    private connection: Connection;
    private payer: Keypair;
    private readonly commitment: Commitment = 'confirmed';
    private readonly maxRetries: number = 3;
    private readonly retryDelay: number = 1000;

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly notificationService: NotificationService
    ) {
        const config = this.loadConfig();
        this.initializeConnection(config);
        this.payer = this.loadKeypair(config);
    }

    async onModuleInit() {
        await this.validateConnection();
        await this.subscribeToSlots();
    }

    async sendTransaction(
        instructions: TransactionInstruction[],
        signers: Keypair[] = [],
        opts: { skipPreflight?: boolean } = {}
    ): Promise<TransactionResult> {
        return this.circuitBreaker.executeFunction(
            'solana_transaction',
            async () => {
                const startTime = Date.now();

                try {
                    const { blockhash, lastValidBlockHeight } = 
                        await this.connection.getLatestBlockhash(this.commitment);

                    const messageV0 = new TransactionMessage({
                        payerKey: this.payer.publicKey,
                        recentBlockhash: blockhash,
                        instructions
                    }).compileToV0Message();

                    const transaction = new VersionedTransaction(messageV0);
                    transaction.sign([this.payer, ...signers]);

                    const signature = await this.connection.sendTransaction(transaction, {
                        skipPreflight: opts.skipPreflight,
                        maxRetries: this.maxRetries,
                        preflightCommitment: this.commitment
                    });

                    const confirmation = await this.connection.confirmTransaction({
                        signature,
                        blockhash,
                        lastValidBlockHeight
                    });

                    if (confirmation.value.err) {
                        throw new Error(`Transaction failed: ${confirmation.value.err}`);
                    }

                    const duration = Date.now() - startTime;
                    await this.recordTransactionMetrics(signature, duration, true);

                    return {
                        signature,
                        confirmationStatus: confirmation.value,
                        duration
                    };
                } catch (error) {
                    await this.handleTransactionError(error, instructions);
                    throw error;
                }
            }
        );
    }

    async createTokenAccount(
        mint: PublicKey,
        owner: PublicKey,
        payer: Keypair = this.payer
    ): Promise<PublicKey> {
        const associatedTokenAddress = await Token.getAssociatedTokenAddress(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            mint,
            owner
        );

        const instruction = Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            mint,
            associatedTokenAddress,
            owner,
            payer.publicKey
        );

        await this.sendTransaction([instruction], [payer]);
        return associatedTokenAddress;
    }

    async getTokenAccountInfo(address: PublicKey): Promise<TokenAccountInfo> {
        const info = await this.connection.getAccountInfo(address);
        if (!info) {
            throw new Error(`Token account ${address.toBase58()} not found`);
        }

        const data = Buffer.from(info.data);
        const accountInfo = TokenInstructions.decodeTokenAccount(data);

        return {
            mint: accountInfo.mint,
            owner: accountInfo.owner,
            amount: accountInfo.amount,
            delegate: accountInfo.delegateOption ? accountInfo.delegate : null,
            state: accountInfo.state,
            isNative: accountInfo.isNativeOption,
            delegatedAmount: accountInfo.delegatedAmount,
            closeAuthority: accountInfo.closeAuthorityOption ? accountInfo.closeAuthority : null
        };
    }

    async getNetworkStatus(): Promise<NetworkStatus> {
        const [slotHeight, epoch, supply, performance] = await Promise.all([
            this.connection.getSlot(),
            this.connection.getEpochInfo(),
            this.connection.getSupply(),
            this.connection.getRecentPerformanceSamples(1)
        ]);

        return {
            slotHeight,
            epoch: epoch.epoch,
            absoluteSlot: epoch.absoluteSlot,
            blockHeight: epoch.blockHeight,
            transactionsPerSecond: performance[0]?.numTransactions || 0,
            totalSupply: supply.value.total,
            circulating: supply.value.circulating
        };
    }

    private loadConfig(): SolanaConfig {
        return {
            rpcEndpoint: this.configService.get<string>('SOLANA_RPC_ENDPOINT'),
            wsEndpoint: this.configService.get<string>('SOLANA_WS_ENDPOINT'),
            privateKey: this.configService.get<string>('SOLANA_PRIVATE_KEY'),
            commitment: this.configService.get<Commitment>('SOLANA_COMMITMENT', 'confirmed')
        };
    }

    private initializeConnection(config: SolanaConfig): void {
        this.connection = new Connection(config.rpcEndpoint, {
            commitment: config.commitment,
            wsEndpoint: config.wsEndpoint,
            confirmTransactionInitialTimeout: 60000
        });
    }

    private loadKeypair(config: SolanaConfig): Keypair {
        try {
            const privateKeyArray = JSON.parse(config.privateKey);
            return Keypair.fromSecretKey(new Uint8Array(privateKeyArray));
        } catch (error) {
            throw new Error('Invalid Solana private key configuration');
        }
    }

    private async validateConnection(): Promise<void> {
        try {
            const version = await this.connection.getVersion();
            this.logger.log(`Connected to Solana cluster version: ${version['solana-core']}`);
        } catch (error) {
            this.logger.error('Failed to connect to Solana cluster:', error);
            throw error;
        }
    }

    private async subscribeToSlots(): Promise<void> {
        this.connection.onSlotChange(slot => {
            this.metricsService.recordSolanaSlot({
                slot: slot.slot,
                timestamp: new Date(),
                parent: slot.parent,
                root: slot.root
            });
        });
    }

    private async recordTransactionMetrics(
        signature: string,
        duration: number,
        success: boolean
    ): Promise<void> {
        await this.metricsService.recordSolanaTransaction({
            signature,
            duration,
            success,
            timestamp: new Date()
        });
    }

    private async handleTransactionError(
        error: Error,
        instructions: TransactionInstruction[]
    ): Promise<void> {
        this.logger.error('Transaction failed:', error);

        await this.notificationService.sendSystemAlert({
            component: 'SolanaService',
            type: 'TRANSACTION_FAILED',
            error: error.message,
            instructions: instructions.map(i => i.programId.toBase58())
        });

        await this.metricsService.recordSolanaError({
            error: error.message,
            timestamp: new Date()
        });
    }

    async getProgramAccounts(
        programId: PublicKey,
        filters?: any[]
    ): Promise<{ pubkey: PublicKey; account: any }[]> {
        return this.circuitBreaker.executeFunction(
            'get_program_accounts',
            async () => {
                return this.connection.getProgramAccounts(programId, {
                    commitment: this.commitment,
                    filters,
                    encoding: 'base64'
                });
            }
        );
    }

    async getMultipleAccounts(
        publicKeys: PublicKey[]
    ): Promise<(Buffer | null)[]> {
        const accounts = await this.connection.getMultipleAccountsInfo(
            publicKeys,
            this.commitment
        );

        return accounts.map(account => account?.data || null);
    }
}
