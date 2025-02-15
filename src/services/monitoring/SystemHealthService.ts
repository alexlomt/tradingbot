import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MetricsService } from '../metrics/MetricsService';
import { NotificationService } from '../notification/NotificationService';
import { RedisService } from '../cache/RedisService';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as pidusage from 'pidusage';
import { exec } from 'child_process';
import { promisify } from 'util';
import { 
    SystemMetrics,
    ResourceStatus,
    DiskMetrics,
    NetworkMetrics,
    DatabaseMetrics,
    ServiceHealth
} from '../../types/monitoring.types';

const execAsync = promisify(exec);

@Injectable()
export class SystemHealthService implements OnModuleInit {
    private readonly logger = new Logger(SystemHealthService.name);
    private readonly checkIntervalMs: number;
    private readonly criticalThresholds: Record<string, number>;
    private readonly warningThresholds: Record<string, number>;
    private readonly servicePorts: Map<string, number>;
    private readonly metricsHistory: Map<string, SystemMetrics[]>;
    private readonly historyRetentionHours: number;

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService,
        private readonly redisService: RedisService,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.checkIntervalMs = this.configService.get('HEALTH_CHECK_INTERVAL_MS', 30000);
        this.criticalThresholds = {
            cpuUsage: 90,
            memoryUsage: 90,
            diskUsage: 90,
            networkLatency: 1000,
            databaseConnections: 90,
            errorRate: 5
        };
        this.warningThresholds = {
            cpuUsage: 75,
            memoryUsage: 80,
            diskUsage: 80,
            networkLatency: 500,
            databaseConnections: 70,
            errorRate: 2
        };
        this.servicePorts = new Map([
            ['api', 3000],
            ['websocket', 3001],
            ['trading-engine', 3002],
            ['market-data', 3003]
        ]);
        this.metricsHistory = new Map();
        this.historyRetentionHours = 24;
    }

    async onModuleInit() {
        await this.initializeMetricsStorage();
        this.startHealthMonitoring();
    }

    private async initializeMetricsStorage() {
        const storedMetrics = await this.redisService.get('system:metrics:history');
        if (storedMetrics) {
            const parsed = JSON.parse(storedMetrics);
            Object.entries(parsed).forEach(([key, value]) => {
                this.metricsHistory.set(key, value as SystemMetrics[]);
            });
        }
    }

    private startHealthMonitoring() {
        setInterval(async () => {
            try {
                const metrics = await this.collectSystemMetrics();
                await this.processMetrics(metrics);
            } catch (error) {
                this.logger.error('Health monitoring failed:', error);
                await this.handleMonitoringError(error);
            }
        }, this.checkIntervalMs);
    }

    private async collectSystemMetrics(): Promise<SystemMetrics> {
        const [
            systemMetrics,
            diskMetrics,
            networkMetrics,
            databaseMetrics,
            serviceHealth
        ] = await Promise.all([
            this.getSystemMetrics(),
            this.getDiskMetrics(),
            this.getNetworkMetrics(),
            this.getDatabaseMetrics(),
            this.checkServicesHealth()
        ]);

        return {
            timestamp: new Date(),
            system: systemMetrics,
            disk: diskMetrics,
            network: networkMetrics,
            database: databaseMetrics,
            services: serviceHealth
        };
    }

    private async getSystemMetrics() {
        const cpuUsage = await this.getCpuUsage();
        const memory = {
            total: os.totalmem(),
            free: os.freemem(),
            used: os.totalmem() - os.freemem()
        };

        return {
            cpuUsage,
            memoryUsage: (memory.used / memory.total) * 100,
            loadAverage: os.loadavg(),
            uptime: os.uptime(),
            status: this.determineResourceStatus('system', cpuUsage)
        };
    }

    private async getCpuUsage(): Promise<number> {
        const usage = await pidusage(process.pid);
        return usage.cpu;
    }

    private async getDiskMetrics(): Promise<DiskMetrics> {
        const { stdout } = await execAsync('df -k /');
        const lines = stdout.trim().split('\n');
        const [, stats] = lines;
        const [, total, used] = stats.split(/\s+/);

        const usagePercent = (parseInt(used) / parseInt(total)) * 100;
        return {
            total: parseInt(total) * 1024,
            used: parseInt(used) * 1024,
            free: (parseInt(total) - parseInt(used)) * 1024,
            usagePercent,
            status: this.determineResourceStatus('disk', usagePercent)
        };
    }

    private async getNetworkMetrics(): Promise<NetworkMetrics> {
        const latencies = await Promise.all(
            this.servicePorts.entries()
            .map(async ([service, port]) => {
                const startTime = Date.now();
                try {
                    await this.checkPort(port);
                    return { service, latency: Date.now() - startTime };
                } catch {
                    return { service, latency: -1 };
                }
            })
        );

        const averageLatency = latencies
            .filter(({ latency }) => latency > 0)
            .reduce((sum, { latency }) => sum + latency, 0) / latencies.length;

        return {
            latencies: Object.fromEntries(
                latencies.map(({ service, latency }) => [service, latency])
            ),
            averageLatency,
            status: this.determineResourceStatus('network', averageLatency)
        };
    }

    private async checkPort(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const net = require('net');
            const socket = new net.Socket();

            socket.setTimeout(1000);

            socket.on('connect', () => {
                socket.destroy();
                resolve();
            });

            socket.on('error', (err) => {
                socket.destroy();
                reject(err);
            });

            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error('Timeout'));
            });

            socket.connect(port, 'localhost');
        });
    }

    private async getDatabaseMetrics(): Promise<DatabaseMetrics> {
        const redisInfo = await this.redisService.info();
        const mongoStatus = await this.getMongoStatus();

        return {
            redis: {
                connectedClients: parseInt(redisInfo.connected_clients),
                usedMemory: parseInt(redisInfo.used_memory),
                cmdPerSec: parseInt(redisInfo.instantaneous_ops_per_sec),
                status: this.determineResourceStatus(
                    'redis',
                    parseInt(redisInfo.used_memory_peak_perc)
                )
            },
            mongodb: {
                connections: mongoStatus.connections.current,
                activeConnections: mongoStatus.connections.active,
                queuedOperations: mongoStatus.globalLock.currentQueue.total,
                status: this.determineResourceStatus(
                    'mongodb',
                    (mongoStatus.connections.current / mongoStatus.connections.available) * 100
                )
            }
        };
    }

    private async getMongoStatus(): Promise<any> {
        const { stdout } = await execAsync('mongosh --eval "db.serverStatus()"');
        return JSON.parse(stdout);
    }

    private async checkServicesHealth(): Promise<ServiceHealth[]> {
        return Promise.all(
            Array.from(this.servicePorts.entries()).map(async ([service, port]) => {
                try {
                    await this.checkPort(port);
                    return {
                        service,
                        status: 'healthy',
                        lastCheck: new Date(),
                        port
                    };
                } catch (error) {
                    return {
                        service,
                        status: 'unhealthy',
                        lastCheck: new Date(),
                        port,
                        error: error.message
                    };
                }
            })
        );
    }

    private determineResourceStatus(
        resource: string,
        value: number
    ): ResourceStatus {
        if (value >= this.criticalThresholds[resource]) {
            return 'critical';
        } else if (value >= this.warningThresholds[resource]) {
            return 'warning';
        }
        return 'healthy';
    }

    private async processMetrics(metrics: SystemMetrics) {
        await this.updateMetricsHistory(metrics);
        await this.metricsService.recordSystemMetrics(metrics);

        const alerts = this.checkAlertConditions(metrics);
        for (const alert of alerts) {
            await this.notificationService.sendSystemAlert(alert);
        }

        this.eventEmitter.emit('system.metrics.updated', metrics);
    }

    private async updateMetricsHistory(metrics: SystemMetrics) {
        const cutoffTime = new Date();
        cutoffTime.setHours(cutoffTime.getHours() - this.historyRetentionHours);

        for (const [key, history] of this.metricsHistory.entries()) {
            const filtered = history
                .filter(m => m.timestamp > cutoffTime)
                .concat(metrics);

            this.metricsHistory.set(key, filtered);
        }

        await this.redisService.set(
            'system:metrics:history',
            JSON.stringify(Object.fromEntries(this.metricsHistory)),
            'EX',
            this.historyRetentionHours * 3600
        );
    }

    private checkAlertConditions(metrics: SystemMetrics): any[] {
        const alerts = [];

        if (metrics.system.status === 'critical') {
            alerts.push({
                type: 'SYSTEM_OVERLOAD',
                severity: 'critical',
                message: `System CPU usage at ${metrics.system.cpuUsage.toFixed(2)}%`
            });
        }

        if (metrics.disk.status === 'critical') {
            alerts.push({
                type: 'DISK_SPACE',
                severity: 'critical',
                message: `Disk usage at ${metrics.disk.usagePercent.toFixed(2)}%`
            });
        }

        const unhealthyServices = metrics.services
            .filter(s => s.status === 'unhealthy');

        if (unhealthyServices.length > 0) {
            alerts.push({
                type: 'SERVICE_DOWN',
                severity: 'critical',
                message: `Services down: ${unhealthyServices
                    .map(s => s.service)
                    .join(', ')}`
            });
        }

        return alerts;
    }

    private async handleMonitoringError(error: Error) {
        await this.notificationService.sendSystemAlert({
            type: 'MONITORING_ERROR',
            severity: 'critical',
            message: error.message,
            error: error.stack
        });

        await this.metricsService.recordMonitoringError({
            timestamp: new Date(),
            error: error.message
        });
    }
}
