import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../cache/RedisService';
import { MetricsService } from '../metrics/MetricsService';
import { NotificationService } from '../notification/NotificationService';
import { CircuitState, CircuitConfig, CircuitStats } from '../../types/circuit-breaker.types';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class CircuitBreakerService implements OnModuleInit {
    private readonly logger = new Logger(CircuitBreakerService.name);
    private readonly circuits: Map<string, CircuitState> = new Map();
    private readonly stats: Map<string, CircuitStats> = new Map();
    private readonly defaultConfig: CircuitConfig;

    constructor(
        private readonly configService: ConfigService,
        private readonly redisService: RedisService,
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.defaultConfig = {
            failureThreshold: parseInt(configService.get('CIRCUIT_FAILURE_THRESHOLD', '5')),
            successThreshold: parseInt(configService.get('CIRCUIT_SUCCESS_THRESHOLD', '3')),
            timeoutMs: parseInt(configService.get('CIRCUIT_TIMEOUT_MS', '30000')),
            monitoringPeriodMs: parseInt(configService.get('CIRCUIT_MONITORING_PERIOD_MS', '60000')),
            resetTimeoutMs: parseInt(configService.get('CIRCUIT_RESET_TIMEOUT_MS', '60000'))
        };
    }

    async onModuleInit() {
        await this.loadCircuitStates();
        this.startStateMonitoring();
        this.registerMetricsReporting();
    }

    async executeFunction<T>(
        circuitId: string,
        func: () => Promise<T>,
        config?: Partial<CircuitConfig>
    ): Promise<T> {
        const circuitConfig = { ...this.defaultConfig, ...config };
        const state = await this.getCircuitState(circuitId);

        if (state === CircuitState.OPEN) {
            const lastFailure = await this.getLastFailureTime(circuitId);
            if (Date.now() - lastFailure < circuitConfig.resetTimeoutMs) {
                throw new Error(`Circuit ${circuitId} is OPEN`);
            }
            await this.transitionState(circuitId, CircuitState.HALF_OPEN);
        }

        try {
            const startTime = Date.now();
            const result = await Promise.race([
                func(),
                this.createTimeout(circuitConfig.timeoutMs)
            ]);

            await this.recordSuccess(circuitId, startTime);
            return result;
        } catch (error) {
            await this.recordFailure(circuitId, error);
            throw error;
        }
    }

    async getCircuitState(circuitId: string): Promise<CircuitState> {
        const cachedState = await this.redisService.get(`circuit:${circuitId}:state`);
        return cachedState as CircuitState || CircuitState.CLOSED;
    }

    private async loadCircuitStates() {
        const keys = await this.redisService.keys('circuit:*:state');
        for (const key of keys) {
            const circuitId = key.split(':')[1];
            const state = await this.redisService.get(key);
            this.circuits.set(circuitId, state as CircuitState);
        }
    }

    private async recordSuccess(circuitId: string, startTime: number) {
        const stats = this.getCircuitStats(circuitId);
        const responseTime = Date.now() - startTime;

        stats.successes++;
        stats.totalResponses++;
        stats.responseTimeSum += responseTime;
        stats.lastSuccess = Date.now();

        await this.updateCircuitStats(circuitId, stats);

        if (await this.getCircuitState(circuitId) === CircuitState.HALF_OPEN) {
            const config = { ...this.defaultConfig };
            if (stats.successes >= config.successThreshold) {
                await this.transitionState(circuitId, CircuitState.CLOSED);
            }
        }

        await this.metricsService.recordCircuitSuccess(circuitId, responseTime);
    }

    private async recordFailure(circuitId: string, error: Error) {
        const stats = this.getCircuitStats(circuitId);
        const state = await this.getCircuitState(circuitId);

        stats.failures++;
        stats.totalResponses++;
        stats.lastFailure = Date.now();
        stats.lastError = error.message;

        await this.updateCircuitStats(circuitId, stats);

        if (stats.failures >= this.defaultConfig.failureThreshold) {
            if (state !== CircuitState.OPEN) {
                await this.transitionState(circuitId, CircuitState.OPEN);
            }
        }

        await this.metricsService.recordCircuitFailure(circuitId, error);
    }

    private async transitionState(circuitId: string, newState: CircuitState) {
        const oldState = await this.getCircuitState(circuitId);
        if (oldState === newState) return;

        await this.redisService.multi()
            .set(`circuit:${circuitId}:state`, newState)
            .set(`circuit:${circuitId}:last_transition`, Date.now().toString())
            .exec();

        this.circuits.set(circuitId, newState);

        this.eventEmitter.emit('circuit.state.changed', {
            circuitId,
            oldState,
            newState,
            timestamp: new Date()
        });

        await this.notificationService.sendSystemAlert({
            component: 'CircuitBreaker',
            type: 'STATE_CHANGE',
            circuitId,
            oldState,
            newState
        });

        await this.metricsService.recordCircuitStateChange(circuitId, oldState, newState);
    }

    private getCircuitStats(circuitId: string): CircuitStats {
        if (!this.stats.has(circuitId)) {
            this.stats.set(circuitId, {
                successes: 0,
                failures: 0,
                totalResponses: 0,
                responseTimeSum: 0,
                lastSuccess: 0,
                lastFailure: 0,
                lastError: null
            });
        }
        return this.stats.get(circuitId)!;
    }

    private async updateCircuitStats(circuitId: string, stats: CircuitStats) {
        this.stats.set(circuitId, stats);
        await this.redisService.hset(
            `circuit:${circuitId}:stats`,
            stats as any
        );
    }

    private async getLastFailureTime(circuitId: string): Promise<number> {
        const stats = await this.redisService.hgetall(`circuit:${circuitId}:stats`);
        return parseInt(stats.lastFailure || '0');
    }

    private createTimeout(ms: number): Promise<never> {
        return new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Operation timed out')), ms);
        });
    }

    private startStateMonitoring() {
        setInterval(async () => {
            for (const [circuitId, state] of this.circuits.entries()) {
                if (state === CircuitState.OPEN) {
                    const lastFailure = await this.getLastFailureTime(circuitId);
                    if (Date.now() - lastFailure >= this.defaultConfig.resetTimeoutMs) {
                        await this.transitionState(circuitId, CircuitState.HALF_OPEN);
                    }
                }
            }
        }, this.defaultConfig.monitoringPeriodMs);
    }

    private registerMetricsReporting() {
        setInterval(async () => {
            for (const [circuitId, stats] of this.stats.entries()) {
                await this.metricsService.recordCircuitMetrics(circuitId, {
                    state: await this.getCircuitState(circuitId),
                    successRate: stats.totalResponses > 0 
                        ? stats.successes / stats.totalResponses 
                        : 1,
                    averageResponseTime: stats.totalResponses > 0 
                        ? stats.responseTimeSum / stats.totalResponses 
                        : 0,
                    totalCalls: stats.totalResponses
                });
            }
        }, 10000); // Report every 10 seconds
    }
}
