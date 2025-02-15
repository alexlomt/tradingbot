import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectMetric } from '@nestjs/prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';
import { RedisService } from '../cache/RedisService';
import { InfluxDB, Point } from '@influxdata/influxdb-client';
import { MetricsConfig } from '../../config/metrics.config';
import { TradingMetrics, SystemMetrics } from '../../types/metrics.types';

@Injectable()
export class MetricsService implements OnModuleInit {
    private influxDB: InfluxDB;
    private readonly metricsBuffer: Map<string, Point[]> = new Map();
    private flushInterval: NodeJS.Timeout;

    constructor(
        private configService: ConfigService,
        private redisService: RedisService,
        @InjectMetric('trading_volume_total')
        private tradingVolumeCounter: Counter<string>,
        @InjectMetric('active_trades')
        private activeTradesGauge: Gauge<string>,
        @InjectMetric('trade_execution_duration')
        private tradeExecutionHistogram: Histogram<string>,
        @InjectMetric('system_memory_usage')
        private memoryUsageGauge: Gauge<string>
    ) {
        this.influxDB = new InfluxDB({
            url: this.configService.get('INFLUXDB_URL')!,
            token: this.configService.get('INFLUXDB_TOKEN')!
        });
    }

    async onModuleInit() {
        this.startMetricsCollection();
        this.startMetricsFlush();
    }

    private startMetricsCollection() {
        // System metrics collection
        setInterval(() => {
            this.collectSystemMetrics();
        }, MetricsConfig.SYSTEM_METRICS_INTERVAL);

        // Trading metrics collection
        setInterval(() => {
            this.collectTradingMetrics();
        }, MetricsConfig.TRADING_METRICS_INTERVAL);
    }

    private startMetricsFlush() {
        this.flushInterval = setInterval(() => {
            this.flushMetricsBuffer();
        }, MetricsConfig.METRICS_FLUSH_INTERVAL);
    }

    async recordTradeExecution(tradeData: {
        userId: string;
        amount: number;
        success: boolean;
        duration: number;
        marketAddress: string;
    }) {
        const point = new Point('trade_execution')
            .tag('user_id', tradeData.userId)
            .tag('market', tradeData.marketAddress)
            .tag('success', String(tradeData.success))
            .floatField('amount', tradeData.amount)
            .floatField('duration_ms', tradeData.duration);

        this.bufferMetric('trading', point);

        // Update Prometheus metrics
        this.tradingVolumeCounter.inc(tradeData.amount);
        this.tradeExecutionHistogram.observe(tradeData.duration);

        // Update Redis cache for real-time monitoring
        await this.updateRealTimeMetrics('trades', tradeData);
    }

    async recordMarketActivity(marketData: {
        address: string;
        volume24h: number;
        price: number;
        liquidity: number;
    }) {
        const point = new Point('market_activity')
            .tag('market_address', marketData.address)
            .floatField('volume_24h', marketData.volume24h)
            .floatField('price', marketData.price)
            .floatField('liquidity', marketData.liquidity);

        this.bufferMetric('markets', point);
    }

    async recordUserActivity(userData: {
        userId: string;
        action: string;
        success: boolean;
        metadata?: Record<string, any>;
    }) {
        const point = new Point('user_activity')
            .tag('user_id', userData.userId)
            .tag('action', userData.action)
            .tag('success', String(userData.success));

        if (userData.metadata) {
            Object.entries(userData.metadata).forEach(([key, value]) => {
                if (typeof value === 'number') {
                    point.floatField(key, value);
                } else {
                    point.stringField(key, String(value));
                }
            });
        }

        this.bufferMetric('users', point);
    }

    async recordWebhookProcessing(
        eventType: string,
        duration: number,
        success: boolean
    ) {
        const point = new Point('webhook_processing')
            .tag('event_type', eventType)
            .tag('success', String(success))
            .floatField('duration_ms', duration);

        this.bufferMetric('webhooks', point);
    }

    private async collectSystemMetrics() {
        const systemMetrics: SystemMetrics = {
            memoryUsage: process.memoryUsage(),
            cpuUsage: process.cpuUsage(),
            activeConnections: await this.getActiveConnections(),
            queueSizes: await this.getQueueSizes()
        };

        const point = new Point('system_metrics')
            .floatField('memory_used', systemMetrics.memoryUsage.heapUsed)
            .floatField('memory_total', systemMetrics.memoryUsage.heapTotal)
            .floatField('cpu_user', systemMetrics.cpuUsage.user)
            .floatField('cpu_system', systemMetrics.cpuUsage.system)
            .intField('active_connections', systemMetrics.activeConnections);

        this.bufferMetric('system', point);
        this.memoryUsageGauge.set(systemMetrics.memoryUsage.heapUsed);
    }

    private async collectTradingMetrics() {
        const tradingMetrics: TradingMetrics = {
            activeTrades: await this.getActiveTrades(),
            pendingOrders: await this.getPendingOrders(),
            tradingVolume24h: await this.getTradingVolume24h()
        };

        const point = new Point('trading_metrics')
            .intField('active_trades', tradingMetrics.activeTrades)
            .intField('pending_orders', tradingMetrics.pendingOrders)
            .floatField('volume_24h', tradingMetrics.tradingVolume24h);

        this.bufferMetric('trading', point);
        this.activeTradesGauge.set(tradingMetrics.activeTrades);
    }

    private bufferMetric(category: string, point: Point) {
        if (!this.metricsBuffer.has(category)) {
            this.metricsBuffer.set(category, []);
        }
        this.metricsBuffer.get(category)!.push(point);

        // Flush if buffer size exceeds threshold
        if (this.metricsBuffer.get(category)!.length >= MetricsConfig.BUFFER_SIZE_THRESHOLD) {
            this.flushMetricsBuffer(category);
        }
    }

    private async flushMetricsBuffer(category?: string) {
        const writeApi = this.influxDB.getWriteApi(
            this.configService.get('INFLUXDB_ORG')!,
            this.configService.get('INFLUXDB_BUCKET')!
        );

        try {
            const categories = category ? [category] : Array.from(this.metricsBuffer.keys());
            
            for (const cat of categories) {
                const points = this.metricsBuffer.get(cat) || [];
                if (points.length > 0) {
                    writeApi.writePoints(points);
                    this.metricsBuffer.set(cat, []);
                }
            }

            await writeApi.close();
        } catch (error) {
            console.error('Failed to flush metrics buffer:', error);
        }
    }

    private async updateRealTimeMetrics(
        category: string,
        data: Record<string, any>
    ) {
        const key = `metrics:realtime:${category}`;
        await this.redisService.lpush(key, JSON.stringify({
            timestamp: Date.now(),
            ...data
        }));
        await this.redisService.ltrim(key, 0, MetricsConfig.REALTIME_METRICS_LIMIT - 1);
    }

    private async getActiveConnections(): Promise<number> {
        return parseInt(await this.redisService.get('metrics:active_connections') || '0');
    }

    private async getQueueSizes(): Promise<Record<string, number>> {
        const queues = ['trades', 'orders', 'webhooks'];
        const sizes: Record<string, number> = {};
        
        for (const queue of queues) {
            sizes[queue] = parseInt(
                await this.redisService.get(`queue:${queue}:size`) || '0'
            );
        }
        
        return sizes;
    }

    private async getActiveTrades(): Promise<number> {
        return parseInt(await this.redisService.get('metrics:active_trades') || '0');
    }

    private async getPendingOrders(): Promise<number> {
        return parseInt(await this.redisService.get('metrics:pending_orders') || '0');
    }

    private async getTradingVolume24h(): Promise<number> {
        return parseFloat(await this.redisService.get('metrics:trading_volume_24h') || '0');
    }
}
