import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { RedisService } from '../../services/cache/RedisService';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class MigrationService {
    private readonly logger = new Logger(MigrationService.name);
    private readonly migrationsPath = path.join(__dirname, 'scripts');
    private readonly lockKey = 'migration:lock';
    private readonly lockTTL = 300; // 5 minutes

    constructor(
        @InjectConnection() private readonly connection: Connection,
        private readonly redisService: RedisService,
        private readonly configService: ConfigService
    ) {}

    async runMigrations(): Promise<void> {
        try {
            // Acquire lock to prevent concurrent migrations
            const locked = await this.acquireLock();
            if (!locked) {
                throw new Error('Migration is already in progress');
            }

            this.logger.log('Starting database migrations...');

            // Get all migration files
            const files = await fs.readdir(this.migrationsPath);
            const migrationFiles = files
                .filter(f => f.endsWith('.js'))
                .sort((a, b) => this.extractVersion(a) - this.extractVersion(b));

            // Get executed migrations
            const executedMigrations = await this.getExecutedMigrations();

            // Run pending migrations
            for (const file of migrationFiles) {
                const version = this.extractVersion(file);
                
                if (!executedMigrations.includes(version)) {
                    await this.runMigration(file, version);
                }
            }

            this.logger.log('Database migrations completed successfully');
        } catch (error) {
            this.logger.error('Migration failed:', error);
            throw error;
        } finally {
            await this.releaseLock();
        }
    }

    private async runMigration(file: string, version: number): Promise<void> {
        const session = await this.connection.startSession();
        session.startTransaction();

        try {
            this.logger.log(`Running migration ${file}...`);

            const migration = require(path.join(this.migrationsPath, file));
            const startTime = Date.now();

            // Run the migration
            await migration.up(this.connection, session);

            // Record successful migration
            await this.recordMigration(version, file, startTime, session);

            await session.commitTransaction();
            this.logger.log(`Migration ${file} completed successfully`);
        } catch (error) {
            await session.abortTransaction();
            this.logger.error(`Migration ${file} failed:`, error);
            throw error;
        } finally {
            session.endSession();
        }
    }

    private async recordMigration(
        version: number,
        filename: string,
        startTime: number,
        session: any
    ): Promise<void> {
        const migrationRecord = {
            version,
            filename,
            executedAt: new Date(),
            duration: Date.now() - startTime,
            checksum: await this.calculateChecksum(filename)
        };

        await this.connection.collection('migrations').insertOne(
            migrationRecord,
            { session }
        );
    }

    private async getExecutedMigrations(): Promise<number[]> {
        const migrations = await this.connection
            .collection('migrations')
            .find({})
            .sort({ version: 1 })
            .toArray();

        return migrations.map(m => m.version);
    }

    private async acquireLock(): Promise<boolean> {
        const lockValue = Date.now().toString();
        const acquired = await this.redisService.set(
            this.lockKey,
            lockValue,
            'NX',
            'EX',
            this.lockTTL
        );

        if (acquired) {
            // Extend lock periodically
            this.startLockExtension(lockValue);
        }

        return acquired !== null;
    }

    private async releaseLock(): Promise<void> {
        await this.redisService.del(this.lockKey);
    }

    private startLockExtension(lockValue: string): void {
        const interval = setInterval(async () => {
            const currentLock = await this.redisService.get(this.lockKey);
            if (currentLock === lockValue) {
                await this.redisService.expire(this.lockKey, this.lockTTL);
            } else {
                clearInterval(interval);
            }
        }, (this.lockTTL / 2) * 1000);
    }

    private extractVersion(filename: string): number {
        const match = filename.match(/^(\d+)/);
        return match ? parseInt(match[1]) : 0;
    }

    private async calculateChecksum(filename: string): Promise<string> {
        const content = await fs.readFile(
            path.join(this.migrationsPath, filename)
        );
        return require('crypto')
            .createHash('md5')
            .update(content)
            .digest('hex');
    }
}
