import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemMetrics } from '../../entities/SystemMetrics.entity';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { WebSocketService } from '../websocket/WebSocketService';
import { BehaviorSubject, Observable, interval } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import * as os from 'os';
import { Decimal } from 'decimal.js';

interface SystemHealth {
    status: 'healthy' | 'degraded' | 'critical';
    components: {
        [key: string]: {
            status: 'up' | 'down' | 'degraded';
            latency: number;
            errorRate: Decimal;
            lastCheck: Date;
        };
    };
    metrics: {
        cpuUsage: Decimal;
        memoryUsage: Decimal;
        wsLatency: number;
        activeConnections: number;
        queueSize: number;
    };
}

@Injectable()
export class MonitoringService implements OnModuleInit {
    private readonly healthStatus = new BehaviorSubject<SystemHealth>(null);
    private readonly MONITORING_INTERVAL = 5000; // 5 seconds
    private readonly ERROR_THRESHOLD = 0.05; // 5% error rate threshold
    private readonly LATENCY_THRESHOLD = 1000; // 1 second
    private readonly MEMORY_THRESHOLD = 0.85; // 85% memory usage

    constructor(
        @InjectRepository(SystemMetrics)
        private readonly metricsRepository: Repository<SystemMetrics>,
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService,
        private readonly webSocketService: WebSocketService
    ) {}

    async onModuleInit() {
        this.startMonitoring();
    }

    private startMonitoring() {
        interval(this.MONITORING_INTERVAL).subscribe(async () => {
            try {
                const health = await this.checkSystemHealth();
                this.healthStatus.next(health);
                await this.persistMetrics(health);
                await this.checkAlerts(health);
            } catch (error) {
                await this.handleError('monitoring', error);
            }
        });
    }

    private async checkSystemHealth(): Promise<SystemHealth> {
        const components = await this.checkComponents();
        const metrics = await this.gatherMetrics();
        
        const status = this.determineOverallStatus(components, metrics);

        return {
            status,
            components,
            metrics
        };
    }

    private async checkComponents(): Promise<SystemHealth['components']> {
        const components: SystemHealth['components'] = {};

        // Check WebSocket connection
        const wsStatus = await this.checkWebSocketHealth();
        components['websocket'] = wsStatus;

        // Check database connection
        const dbStatus = await this.checkDatabaseHealth();
        components['database'] = dbStatus;

        // Check market data feed
        const marketDataStatus = await this.checkMarketDataHealth();
        components['marketData'] = marketDataStatus;

        // Check order execution
        const executionStatus = await this.checkExecutionHealth();
        components['execution'] = executionStatus;

        return components;
    }

    private async gatherMetrics(): Promise<SystemHealth['metrics']> {
        const cpuUsage = await this.getCpuUsage();
        const memoryUsage = this.getMemoryUsage();
        const wsLatency = await this.getWebSocketLatency();
        const activeConnections = await this.getActiveConnections();
        const queueSize = await this.getOrderQueueSize();

        return {
            cpuUsage: new Decimal(cpuUsage),
            memoryUsage: new Decimal(memoryUsage),
            wsLatency,
            activeConnections,
            queueSize
        };
    }

    private async getCpuUsage(): Promise<number> {
        const startUsage = process.cpuUsage();
        await new Promise(resolve => setTimeout(resolve, 100));
        const endUsage = process.cpuUsage(startUsage);
        
        return (endUsage.user + endUsage.system) / 1000000;
    }

    private getMemoryUsage(): number {
        const used = process.memoryUsage();
        return used.heapUsed / used.heapTotal;
    }

    private async getWebSocketLatency(): Promise<number> {
        const start = Date.now();
        await this.webSocketService.send({ type: 'ping' });
        return Date.now() - start;
    }

    private async checkWebSocketHealth() {
        const latency = await this.getWebSocketLatency();
        const errorRate = await this.metricsService.getErrorRate('websocket');
        
        return {
            status: this.determineComponentStatus(latency, errorRate),
            latency,
            errorRate: new Decimal(errorRate),
            lastCheck: new Date()
        };
    }

    private async checkDatabaseHealth() {
        try {
            const start = Date.now();
            await this.metricsRepository.count();
            const latency = Date.now() - start;
            
            return {
                status: latency > this.LATENCY_THRESHOLD ? 'degraded' : 'up',
                latency,
                errorRate: new Decimal(0),
                lastCheck: new Date()
            };
        } catch (error) {
            await this.handleError('database_health', error);
            return {
                status: 'down',
                latency: 0,
                errorRate: new Decimal(1),
                lastCheck: new Date()
            };
        }
    }

    private determineComponentStatus(
        latency: number,
        errorRate: number
    ): 'up' | 'down' | 'degraded' {
        if (errorRate >= this.ERROR_THRESHOLD) return 'down';
        if (latency > this.LATENCY_THRESHOLD) return 'degraded';
        return 'up';
    }

    private determineOverallStatus(
        components: SystemHealth['components'],
        metrics: SystemHealth['metrics']
    ): SystemHealth['status'] {
        const componentStatuses = Object.values(components).map(c => c.status);
        
        if (componentStatuses.includes('down') || 
            metrics.memoryUsage.gt(this.MEMORY_THRESHOLD)) {
            return 'critical';
        }
        
        if (componentStatuses.includes('degraded') || 
            metrics.wsLatency > this.LATENCY_THRESHOLD) {
            return 'degraded';
        }
        
        return 'healthy';
    }

    private async persistMetrics(health: SystemHealth) {
        const metrics = new SystemMetrics();
        metrics.timestamp = new Date();
        metrics.status = health.status;
        metrics.cpuUsage = health.metrics.cpuUsage;
        metrics.memoryUsage = health.metrics.memoryUsage;
        metrics.wsLatency = health.metrics.wsLatency;
        metrics.activeConnections = health.metrics.activeConnections;
        metrics.queueSize = health.metrics.queueSize;

        await this.metricsRepository.save(metrics);
    }

    private async checkAlerts(health: SystemHealth) {
        if (health.status === 'critical') {
            await this.auditService.logSystemEvent({
                event: 'SYSTEM_CRITICAL',
                details: {
                    components: health.components,
                    metrics: health.metrics
                },
                severity: 'CRITICAL'
            });
        }

        if (health.metrics.memoryUsage.gt(this.MEMORY_THRESHOLD)) {
            await this.auditService.logSystemEvent({
                event: 'HIGH_MEMORY_USAGE',
                details: {
                    usage: health.metrics.memoryUsage.toString(),
                    threshold: this.MEMORY_THRESHOLD
                },
                severity: 'WARNING'
            });
        }
    }

    getSystemHealth(): Observable<SystemHealth> {
        return this.healthStatus.asObservable().pipe(
            filter(health => health !== null)
        );
    }

    async getHistoricalMetrics(
        startTime: Date,
        endTime: Date
    ): Promise<SystemMetrics[]> {
        return this.metricsRepository.find({
            where: {
                timestamp: Between(startTime, endTime)
            },
            order: {
                timestamp: 'ASC'
            }
        });
    }

    private async handleError(
        operation: string,
        error: Error
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'MONITORING_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('monitoring');
    }
}
