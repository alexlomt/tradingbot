import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Redis from 'ioredis';
import { AuditService } from '../audit/AuditService';
import { MetricsService } from '../metrics/MetricsService';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private client: Redis.Redis;
    private subscriber: Redis.Redis;
    private publisher: Redis.Redis;
    private readonly reconnectAttempts: number = 5;
    private readonly reconnectDelay: number = 5000;

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService
    ) {}

    async onModuleInit() {
        await this.initializeRedisConnections();
        this.setupEventListeners();
        this.startHeartbeat();
    }

    async onModuleDestroy() {
        await Promise.all([
            this.client?.disconnect(),
            this.subscriber?.disconnect(),
            this.publisher?.disconnect()
        ]);
    }

    private async initializeRedisConnections() {
        const options = this.getRedisOptions();

        try {
            // Initialize main client
            this.client = new Redis.Cluster(
                this.getClusterNodes(),
                {
                    ...options,
                    redisOptions: {
                        ...options,
                        lazyConnect: true
                    }
                }
            );

            // Initialize subscriber client
            this.subscriber = this.client.duplicate();

            // Initialize publisher client
            this.publisher = this.client.duplicate();

            await Promise.all([
                this.client.connect(),
                this.subscriber.connect(),
                this.publisher.connect()
            ]);

            await this.auditService.logSystemEvent({
                event: 'REDIS_CONNECTED',
                details: { clustered: true },
                severity: 'INFO'
            });
        } catch (error) {
            await this.auditService.logSystemEvent({
                event: 'REDIS_CONNECTION_ERROR',
                details: { error: error.message },
                severity: 'ERROR'
            });
            throw error;
        }
    }

    private getRedisOptions(): Redis.ClusterOptions {
        return {
            scaleReads: 'slave',
            maxRedirections: 16,
            retryDelayOnFailover: 2000,
            retryDelayOnClusterDown: 1000,
            enableOfflineQueue: true,
            enableReadyCheck: true,
            slotsRefreshTimeout: 10000,
            redisOptions: {
                password: this.configService.get<string>('REDIS_PASSWORD'),
                tls: this.configService.get<boolean>('REDIS_TLS_ENABLED') ? {} : undefined,
                connectTimeout: 10000,
                maxRetriesPerRequest: 3,
                enableAutoPipelining: true,
                autoResendUnfulfilledCommands: true,
            }
        };
    }

    private getClusterNodes(): Array<{ host: string; port: number }> {
        const nodes = this.configService.get<string>('REDIS_CLUSTER_NODES');
        return nodes.split(',').map(node => {
            const [host, port] = node.split(':');
            return { host, port: parseInt(port, 10) };
        });
    }

    private setupEventListeners() {
        const clients = [this.client, this.subscriber, this.publisher];

        clients.forEach(client => {
            client.on('error', async (error) => {
                await this.auditService.logSystemEvent({
                    event: 'REDIS_ERROR',
                    details: { error: error.message },
                    severity: 'ERROR'
                });
                await this.metricsService.incrementRedisError();
            });

            client.on('reconnecting', async () => {
                await this.metricsService.incrementRedisReconnect();
            });

            client.on('+node', async (node) => {
                await this.auditService.logSystemEvent({
                    event: 'REDIS_NODE_ADDED',
                    details: { node },
                    severity: 'INFO'
                });
            });

            client.on('-node', async (node) => {
                await this.auditService.logSystemEvent({
                    event: 'REDIS_NODE_REMOVED',
                    details: { node },
                    severity: 'WARNING'
                });
            });
        });
    }

    private startHeartbeat() {
        setInterval(async () => {
            try {
                await this.client.ping();
                await this.metricsService.recordRedisLatency();
            } catch (error) {
                await this.auditService.logSystemEvent({
                    event: 'REDIS_HEARTBEAT_FAILED',
                    details: { error: error.message },
                    severity: 'ERROR'
                });
            }
        }, 30000); // Every 30 seconds
    }

    // Redis Commands
    async get(key: string): Promise<string | null> {
        try {
            const start = Date.now();
            const result = await this.client.get(key);
            this.metricsService.recordRedisOperation('get', Date.now() - start);
            return result;
        } catch (error) {
            await this.handleRedisError('get', error);
            throw error;
        }
    }

    async set(key: string, value: string, ttl?: number): Promise<void> {
        try {
            const start = Date.now();
            if (ttl) {
                await this.client.set(key, value, 'EX', ttl);
            } else {
                await this.client.set(key, value);
            }
            this.metricsService.recordRedisOperation('set', Date.now() - start);
        } catch (error) {
            await this.handleRedisError('set', error);
            throw error;
        }
    }

    async setex(key: string, seconds: number, value: string): Promise<void> {
        try {
            const start = Date.now();
            await this.client.setex(key, seconds, value);
            this.metricsService.recordRedisOperation('setex', Date.now() - start);
        } catch (error) {
            await this.handleRedisError('setex', error);
            throw error;
        }
    }

    async del(key: string): Promise<void> {
        try {
            const start = Date.now();
            await this.client.del(key);
            this.metricsService.recordRedisOperation('del', Date.now() - start);
        } catch (error) {
            await this.handleRedisError('del', error);
            throw error;
        }
    }

    async incr(key: string): Promise<number> {
        try {
            const start = Date.now();
            const result = await this.client.incr(key);
            this.metricsService.recordRedisOperation('incr', Date.now() - start);
            return result;
        } catch (error) {
            await this.handleRedisError('incr', error);
            throw error;
        }
    }

    async ttl(key: string): Promise<number> {
        try {
            const start = Date.now();
            const result = await this.client.ttl(key);
            this.metricsService.recordRedisOperation('ttl', Date.now() - start);
            return result;
        } catch (error) {
            await this.handleRedisError('ttl', error);
            throw error;
        }
    }

    async expire(key: string, seconds: number): Promise<void> {
        try {
            const start = Date.now();
            await this.client.expire(key, seconds);
            this.metricsService.recordRedisOperation('expire', Date.now() - start);
        } catch (error) {
            await this.handleRedisError('expire', error);
            throw error;
        }
    }

    multi(): Redis.Pipeline {
        return this.client.pipeline();
    }

    private async handleRedisError(operation: string, error: any): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'REDIS_OPERATION_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });
        await this.metricsService.incrementRedisError();
    }

    // Pub/Sub Methods
    async publish(channel: string, message: string): Promise<number> {
        try {
            return await this.publisher.publish(channel, message);
        } catch (error) {
            await this.handleRedisError('publish', error);
            throw error;
        }
    }

    async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
        try {
            await this.subscriber.subscribe(channel);
            this.subscriber.on('message', (ch, message) => {
                if (ch === channel) {
                    callback(message);
                }
            });
        } catch (error) {
            await this.handleRedisError('subscribe', error);
            throw error;
        }
    }
}
