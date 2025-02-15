import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { S3 } from 'aws-sdk';
import { MongoClient } from 'mongodb';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createReadStream, createWriteStream } from 'fs';
import { join } from 'path';
import * as zlib from 'zlib';
import { MetricsService } from '../metrics/MetricsService';
import { NotificationService } from '../notification/NotificationService';
import { BackupStatus, BackupType, RestorePoint } from '../../types/backup.types';

const execAsync = promisify(exec);

@Injectable()
export class DatabaseBackupService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseBackupService.name);
    private readonly s3: S3;
    private readonly backupPath: string;
    private readonly dbUri: string;
    private readonly dbName: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService
    ) {
        this.s3 = new S3({
            accessKeyId: this.configService.get('AWS_ACCESS_KEY_ID'),
            secretAccessKey: this.configService.get('AWS_SECRET_ACCESS_KEY'),
            region: this.configService.get('AWS_REGION')
        });

        this.backupPath = this.configService.get('BACKUP_PATH', '/var/backups/trading-bot');
        this.dbUri = this.configService.get('MONGODB_URI');
        this.dbName = this.configService.get('MONGODB_DATABASE');
    }

    async onModuleInit() {
        await this.validateBackupConfiguration();
        await this.initializeBackupDirectory();
    }

    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async performFullBackup() {
        const backupId = `full-${new Date().toISOString()}`;
        const startTime = Date.now();

        try {
            this.logger.log(`Starting full backup: ${backupId}`);

            const backupFile = await this.createMongoBackup(BackupType.FULL);
            const compressedFile = await this.compressBackup(backupFile);
            const s3Key = await this.uploadToS3(compressedFile, backupId);

            await this.cleanupLocalFiles(backupFile, compressedFile);
            await this.updateBackupMetadata(backupId, BackupType.FULL, s3Key);

            const duration = Date.now() - startTime;
            await this.recordBackupMetrics(backupId, BackupType.FULL, duration, true);

            this.logger.log(`Full backup completed: ${backupId}`);
        } catch (error) {
            this.logger.error(`Full backup failed: ${backupId}`, error);
            await this.handleBackupError(backupId, error);
        }
    }

    @Cron(CronExpression.EVERY_HOUR)
    async performIncrementalBackup() {
        const backupId = `incremental-${new Date().toISOString()}`;
        const startTime = Date.now();

        try {
            this.logger.log(`Starting incremental backup: ${backupId}`);

            const lastBackup = await this.getLastSuccessfulBackup();
            const backupFile = await this.createMongoBackup(
                BackupType.INCREMENTAL,
                lastBackup
            );

            const compressedFile = await this.compressBackup(backupFile);
            const s3Key = await this.uploadToS3(compressedFile, backupId);

            await this.cleanupLocalFiles(backupFile, compressedFile);
            await this.updateBackupMetadata(backupId, BackupType.INCREMENTAL, s3Key);

            const duration = Date.now() - startTime;
            await this.recordBackupMetrics(backupId, BackupType.INCREMENTAL, duration, true);

            this.logger.log(`Incremental backup completed: ${backupId}`);
        } catch (error) {
            this.logger.error(`Incremental backup failed: ${backupId}`, error);
            await this.handleBackupError(backupId, error);
        }
    }

    async restoreFromBackup(restorePoint: RestorePoint): Promise<boolean> {
        const restoreId = `restore-${new Date().toISOString()}`;
        const startTime = Date.now();

        try {
            this.logger.log(`Starting database restore: ${restoreId}`);

            const backupFile = await this.downloadFromS3(restorePoint.s3Key);
            const uncompressedFile = await this.decompressBackup(backupFile);

            await this.stopDatabaseConnections();
            await this.performRestore(uncompressedFile);
            await this.restartDatabase();

            await this.cleanupLocalFiles(backupFile, uncompressedFile);

            const duration = Date.now() - startTime;
            await this.recordRestoreMetrics(restoreId, duration, true);

            this.logger.log(`Database restore completed: ${restoreId}`);
            return true;
        } catch (error) {
            this.logger.error(`Database restore failed: ${restoreId}`, error);
            await this.handleRestoreError(restoreId, error);
            return false;
        }
    }

    private async createMongoBackup(
        type: BackupType,
        lastBackup?: string
    ): Promise<string> {
        const outputFile = join(
            this.backupPath,
            `backup-${new Date().toISOString()}.archive`
        );

        const mongodumpArgs = [
            `--uri="${this.dbUri}"`,
            `--db=${this.dbName}`,
            `--archive=${outputFile}`,
            '--gzip'
        ];

        if (type === BackupType.INCREMENTAL && lastBackup) {
            mongodumpArgs.push(`--query='{"_ts": {"$gt": "${lastBackup}"}}'`);
        }

        await execAsync(`mongodump ${mongodumpArgs.join(' ')}`);
        return outputFile;
    }

    private async compressBackup(inputFile: string): Promise<string> {
        const outputFile = `${inputFile}.gz`;
        const readStream = createReadStream(inputFile);
        const writeStream = createWriteStream(outputFile);
        const gzip = zlib.createGzip();

        await new Promise((resolve, reject) => {
            readStream
                .pipe(gzip)
                .pipe(writeStream)
                .on('finish', resolve)
                .on('error', reject);
        });

        return outputFile;
    }

    private async uploadToS3(file: string, backupId: string): Promise<string> {
        const key = `backups/${this.dbName}/${backupId}.gz`;
        const stream = createReadStream(file);

        await this.s3.upload({
            Bucket: this.configService.get('AWS_BACKUP_BUCKET'),
            Key: key,
            Body: stream,
            ServerSideEncryption: 'AES256'
        }).promise();

        return key;
    }

    private async downloadFromS3(key: string): Promise<string> {
        const localFile = join(this.backupPath, key.split('/').pop()!);
        const writeStream = createWriteStream(localFile);

        const response = await this.s3.getObject({
            Bucket: this.configService.get('AWS_BACKUP_BUCKET'),
            Key: key
        }).promise();

        await new Promise((resolve, reject) => {
            writeStream.write(response.Body, (error) => {
                if (error) reject(error);
                else resolve(true);
            });
        });

        return localFile;
    }

    private async decompressBackup(inputFile: string): Promise<string> {
        const outputFile = inputFile.replace('.gz', '');
        const readStream = createReadStream(inputFile);
        const writeStream = createWriteStream(outputFile);
        const gunzip = zlib.createGunzip();

        await new Promise((resolve, reject) => {
            readStream
                .pipe(gunzip)
                .pipe(writeStream)
                .on('finish', resolve)
                .on('error', reject);
        });

        return outputFile;
    }

    private async performRestore(backupFile: string): Promise<void> {
        const mongorestore = [
            `--uri="${this.dbUri}"`,
            `--db=${this.dbName}`,
            `--archive=${backupFile}`,
            '--drop'
        ];

        await execAsync(`mongorestore ${mongorestore.join(' ')}`);
    }

    private async stopDatabaseConnections(): Promise<void> {
        const client = await MongoClient.connect(this.dbUri);
        const admin = client.db().admin();
        
        const connections = await admin.listDatabases();
        for (const db of connections.databases) {
            if (db.name === this.dbName) {
                await admin.command({ killAllSessions: [] });
                break;
            }
        }
        
        await client.close();
    }

    private async restartDatabase(): Promise<void> {
        await execAsync('systemctl restart mongodb');
    }

    private async cleanupLocalFiles(...files: string[]): Promise<void> {
        for (const file of files) {
            await execAsync(`rm -f ${file}`);
        }
    }

    private async updateBackupMetadata(
        backupId: string,
        type: BackupType,
        s3Key: string
    ): Promise<void> {
        const metadata = {
            backupId,
            type,
            s3Key,
            timestamp: new Date().toISOString(),
            status: BackupStatus.COMPLETED
        };

        await this.s3.putObject({
            Bucket: this.configService.get('AWS_BACKUP_BUCKET'),
            Key: `metadata/${backupId}.json`,
            Body: JSON.stringify(metadata),
            ContentType: 'application/json'
        }).promise();
    }

    private async recordBackupMetrics(
        backupId: string,
        type: BackupType,
        duration: number,
        success: boolean
    ): Promise<void> {
        await this.metricsService.recordBackupMetrics({
            backupId,
            type,
            duration,
            success
        });
    }

    private async recordRestoreMetrics(
        restoreId: string,
        duration: number,
        success: boolean
    ): Promise<void> {
        await this.metricsService.recordRestoreMetrics({
            restoreId,
            duration,
            success
        });
    }

    private async handleBackupError(backupId: string, error: Error): Promise<void> {
        await this.notificationService.sendSystemAlert({
            component: 'DatabaseBackup',
            type: 'BACKUP_FAILED',
            backupId,
            error: error.message
        });

        await this.recordBackupMetrics(
            backupId,
            BackupType.FULL,
            0,
            false
        );
    }

    private async handleRestoreError(restoreId: string, error: Error): Promise<void> {
        await this.notificationService.sendSystemAlert({
            component: 'DatabaseRestore',
            type: 'RESTORE_FAILED',
            restoreId,
            error: error.message
        });

        await this.recordRestoreMetrics(
            restoreId,
            0,
            false
        );
    }

    private async validateBackupConfiguration(): Promise<void> {
        const requiredConfigs = [
            'AWS_ACCESS_KEY_ID',
            'AWS_SECRET_ACCESS_KEY',
            'AWS_REGION',
            'AWS_BACKUP_BUCKET',
            'MONGODB_URI',
            'MONGODB_DATABASE'
        ];

        for (const config of requiredConfigs) {
            if (!this.configService.get(config)) {
                throw new Error(`Missing required configuration: ${config}`);
            }
        }
    }

    private async initializeBackupDirectory(): Promise<void> {
        await execAsync(`mkdir -p ${this.backupPath}`);
        await execAsync(`chmod 700 ${this.backupPath}`);
    }

    private async getLastSuccessfulBackup(): Promise<string> {
        const response = await this.s3.listObjectsV2({
            Bucket: this.configService.get('AWS_BACKUP_BUCKET'),
            Prefix: 'metadata/',
            MaxKeys: 100
        }).promise();

        const metadata = await Promise.all(
            response.Contents
                ?.sort((a, b) => b.LastModified.getTime() - a.LastModified.getTime())
                .map(async (object) => {
                    const data = await this.s3.getObject({
                        Bucket: this.configService.get('AWS_BACKUP_BUCKET'),
                        Key: object.Key
                    }).promise();
                    return JSON.parse(data.Body.toString());
                }) || []
        );

        const lastSuccessful = metadata.find(m => m.status === BackupStatus.COMPLETED);
        return lastSuccessful?.timestamp || new Date(0).toISOString();
    }
}
