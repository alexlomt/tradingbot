import { PublicKey } from '@solana/web3.js';
import { Token } from '@raydium-io/raydium-sdk';
import { SnipeListEntry } from '../../types/trading.types';
import { TokenPairService } from '../token/TokenPairService';
import { MarketDataService } from '../market/MarketDataService';
import { ConfigService } from '../config/ConfigService';
import { Redis } from 'ioredis';
import { logger } from '../../utils/logger';
import { ErrorReporter } from '../../utils/errorReporting';
import { PerformanceMonitor } from '../../utils/performance';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

interface SnipeListConfig {
    maxEntries: number;
    autoRemoveAfterDays: number;
    persistToFile: boolean;
    syncInterval: number;
    backupInterval: number;
}

export class SnipeListService extends EventEmitter {
    private readonly snipeList: Map<string, SnipeListEntry>;
    private readonly redis?: Redis;
    private readonly performanceMonitor: PerformanceMonitor;
    private readonly config: SnipeListConfig;
    private readonly dataDir: string;
    private readonly snipeListFile: string;
    private readonly backupDir: string;

    private syncTimeout?: NodeJS.Timeout;
    private backupTimeout?: NodeJS.Timeout;

    constructor(
        private readonly tokenPairService: TokenPairService,
        private readonly marketDataService: MarketDataService,
        private readonly configService: ConfigService
    ) {
        super();
        this.snipeList = new Map();
        this.performanceMonitor = new PerformanceMonitor();

        // Initialize configuration
        this.config = {
            maxEntries: parseInt(configService.get('SNIPE_LIST_MAX_ENTRIES') || '1000'),
            autoRemoveAfterDays: parseInt(configService.get('SNIPE_LIST_AUTO_REMOVE_DAYS') || '30'),
            persistToFile: configService.get('SNIPE_LIST_PERSIST') === 'true',
            syncInterval: parseInt(configService.get('SNIPE_LIST_SYNC_INTERVAL') || '300000'),
            backupInterval: parseInt(configService.get('SNIPE_LIST_BACKUP_INTERVAL') || '3600000')
        };

        // Initialize directories and files
        this.dataDir = path.join(process.cwd(), 'data');
        this.snipeListFile = path.join(this.dataDir, 'snipe-list.json');
        this.backupDir = path.join(this.dataDir, 'backups');

        // Ensure directories exist
        this.initializeDirectories();

        // Initialize Redis if enabled
        if (configService.get('REDIS_ENABLED') === 'true') {
            this.redis = new Redis({
                host: configService.get('REDIS_HOST'),
                port: parseInt(configService.get('REDIS_PORT') || '6379'),
                password: configService.get('REDIS_PASSWORD'),
                retryStrategy: (times: number) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            });

            this.redis.on('error', (error) => {
                logger.error('Redis connection error:', error);
                ErrorReporter.reportError(error, {
                    context: 'SnipeListService.redis',
                    service: 'Redis'
                });
            });
        }

        // Initialize service
        this.initialize();
    }

    async initialize(): Promise<void> {
        try {
            // Load existing snipe list
            await this.loadSnipeList();

            // Start sync and backup intervals
            if (this.config.syncInterval > 0) {
                this.syncTimeout = setInterval(
                    () => this.syncSnipeList(),
                    this.config.syncInterval
                );
            }

            if (this.config.backupInterval > 0) {
                this.backupTimeout = setInterval(
                    () => this.createBackup(),
                    this.config.backupInterval
                );
            }

            // Initial sync
            await this.syncSnipeList();
            
            logger.info('SnipeListService initialized successfully');
        } catch (error) {
            logger.error('Error initializing SnipeListService:', error);
            ErrorReporter.reportError(error, {
                context: 'SnipeListService.initialize'
            });
        }
    }

    async addToSnipeList(
        mint: PublicKey,
        metadata?: Record<string, any>
    ): Promise<boolean> {
        const timer = this.performanceMonitor.startTimer('addToSnipeList');

        try {
            if (this.snipeList.size >= this.config.maxEntries) {
                throw new Error('Snipe list has reached maximum capacity');
            }

            const mintStr = mint.toString();
            if (this.snipeList.has(mintStr)) {
                return false;
            }

            const token = await this.tokenPairService.getTokenByMint(mint);
            if (!token) {
                throw new Error('Invalid token mint');
            }

            const entry: SnipeListEntry = {
                mint: mint,
                symbol: token.symbol,
                addedAt: Date.now(),
                metadata: metadata || {}
            };

            this.snipeList.set(mintStr, entry);
            await this.persistEntry(entry);

            this.emit('snipelist:added', entry);
            return true;

        } catch (error) {
            logger.error('Error adding to snipe list:', error);
            ErrorReporter.reportError(error, {
                context: 'SnipeListService.addToSnipeList',
                mint: mint.toString()
            });
            return false;
        } finally {
            this.performanceMonitor.endTimer('addToSnipeList', timer);
        }
    }

    async removeFromSnipeList(mint: PublicKey): Promise<boolean> {
        const mintStr = mint.toString();
        const removed = this.snipeList.delete(mintStr);

        if (removed) {
            await this.removeEntry(mintStr);
            this.emit('snipelist:removed', { mint: mintStr });
        }

        return removed;
    }

    isTokenInSnipeList(mint: PublicKey): boolean {
        return this.snipeList.has(mint.toString());
    }

    getSnipeList(): SnipeListEntry[] {
        return Array.from(this.snipeList.values());
    }

    private async persistEntry(entry: SnipeListEntry): Promise<void> {
        if (this.redis) {
            try {
                await this.redis.hset(
                    'snipelist:entries',
                    entry.mint.toString(),
                    JSON.stringify(entry)
                );
            } catch (error) {
                logger.error('Redis persist error:', error);
            }
        }

        if (this.config.persistToFile) {
            await this.saveSnipeList();
        }
    }

    private async removeEntry(mintStr: string): Promise<void> {
        if (this.redis) {
            try {
                await this.redis.hdel('snipelist:entries', mintStr);
            } catch (error) {
                logger.error('Redis remove error:', error);
            }
        }

        if (this.config.persistToFile) {
            await this.saveSnipeList();
        }
    }

    private async loadSnipeList(): Promise<void> {
        try {
            // Try loading from Redis first
            if (this.redis) {
                const entries = await this.redis.hgetall('snipelist:entries');
                for (const [mint, entryStr] of Object.entries(entries)) {
                    const entry = JSON.parse(entryStr);
                    this.snipeList.set(mint, {
                        ...entry,
                        mint: new PublicKey(entry.mint)
                    });
                }
            }

            // Fall back to file if Redis is empty or disabled
            if (this.snipeList.size === 0 && this.config.persistToFile) {
                if (fs.existsSync(this.snipeListFile)) {
                    const data = JSON.parse(fs.readFileSync(this.snipeListFile, 'utf-8'));
                    for (const entry of data) {
                        this.snipeList.set(entry.mint, {
                            ...entry,
                            mint: new PublicKey(entry.mint)
                        });
                    }
                }
            }
        } catch (error) {
            logger.error('Error loading snipe list:', error);
            ErrorReporter.reportError(error, {
                context: 'SnipeListService.loadSnipeList'
            });
        }
    }

    private async saveSnipeList(): Promise<void> {
        if (!this.config.persistToFile) return;

        try {
            const data = Array.from(this.snipeList.values()).map(entry => ({
                ...entry,
                mint: entry.mint.toString()
            }));

            fs.writeFileSync(
                this.snipeListFile,
                JSON.stringify(data, null, 2)
            );
        } catch (error) {
            logger.error('Error saving snipe list:', error);
            ErrorReporter.reportError(error, {
                context: 'SnipeListService.saveSnipeList'
            });
        }
    }

    private async syncSnipeList(): Promise<void> {
        const timer = this.performanceMonitor.startTimer('syncSnipeList');

        try {
            const now = Date.now();
            const removeThreshold = now - (this.config.autoRemoveAfterDays * 24 * 60 * 60 * 1000);

            for (const [mint, entry] of this.snipeList.entries()) {
                if (entry.addedAt < removeThreshold) {
                    await this.removeFromSnipeList(new PublicKey(mint));
                    continue;
                }

                // Update token metadata if needed
                try {
                    const token = await this.tokenPairService.getTokenByMint(
                        new PublicKey(mint)
                    );
                    if (token && token.symbol !== entry.symbol) {
                        entry.symbol = token.symbol;
                        await this.persistEntry(entry);
                    }
                } catch (error) {
                    logger.warn(`Error updating token metadata for ${mint}:`, error);
                }
            }
        } catch (error) {
            logger.error('Error syncing snipe list:', error);
            ErrorReporter.reportError(error, {
                context: 'SnipeListService.syncSnipeList'
            });
        } finally {
            this.performanceMonitor.endTimer('syncSnipeList', timer);
        }
    }

    private async createBackup(): Promise<void> {
        if (!this.config.persistToFile) return;

        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(
                this.backupDir,
                `snipe-list-${timestamp}.json`
            );

            fs.copyFileSync(this.snipeListFile, backupFile);

            // Clean up old backups
            const backups = fs.readdirSync(this.backupDir);
            if (backups.length > 10) { // Keep last 10 backups
                const oldestBackup = backups
                    .sort()
                    .slice(0, backups.length - 10);
                
                for (const backup of oldestBackup) {
                    fs.unlinkSync(path.join(this.backupDir, backup));
                }
            }
        } catch (error) {
            logger.error('Error creating backup:', error);
            ErrorReporter.reportError(error, {
                context: 'SnipeListService.createBackup'
            });
        }
    }

    private initializeDirectories(): void {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir);
        }
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir);
        }
    }

    async cleanup(): Promise<void> {
        if (this.syncTimeout) {
            clearInterval(this.syncTimeout);
        }
        if (this.backupTimeout) {
            clearInterval(this.backupTimeout);
        }
        
        await this.saveSnipeList();
        
        if (this.redis) {
            await this.redis.quit();
        }
    }
}
