import { 
    Connection, 
    PublicKey, 
    TransactionInstruction,
    VersionedTransaction
} from '@solana/web3.js';
import { 
    ExecutionStrategy,
    TradeExecutionContext,
    TransactionResult,
    TransactionConfig
} from '../../types/trading.types';
import { TokenPairService } from '../token/TokenPairService';
import { MarketDataService } from '../market/MarketDataService';
import { TransactionManager } from '../transaction/TransactionManager';
import { PoolCache } from '../cache/PoolCache';
import { MarketCache } from '../cache/MarketCache';
import { ConfigService } from '../config/ConfigService';
import { logger } from '../../utils/logger';
import { ErrorReporter } from '../../utils/errorReporting';
import { PerformanceMonitor } from '../../utils/performance';
import { Redis } from 'ioredis';
import BN from 'bn.js';

interface StrategyMetrics {
    successRate: number;
    averageExecutionTime: number;
    failureRate: number;
    totalExecutions: number;
    avgGasUsed: number;
    lastUpdated: number;
}

export class ExecutionStrategyService {
    private readonly strategies: Map<string, ExecutionStrategy>;
    private readonly metrics: Map<string, StrategyMetrics>;
    private readonly redis?: Redis;
    private readonly performanceMonitor: PerformanceMonitor;

    private readonly DEFAULT_PRIORITY = 1;
    private readonly METRICS_TTL = 24 * 60 * 60; // 24 hours
    private readonly METRICS_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes

    constructor(
        private readonly connection: Connection,
        private readonly tokenPairService: TokenPairService,
        private readonly marketDataService: MarketDataService,
        private readonly transactionManager: TransactionManager,
        private readonly poolCache: PoolCache,
        private readonly marketCache: MarketCache,
        private readonly config: ConfigService
    ) {
        this.strategies = new Map();
        this.metrics = new Map();
        this.performanceMonitor = new PerformanceMonitor();

        if (config.get('REDIS_ENABLED') === 'true') {
            this.redis = new Redis({
                host: config.get('REDIS_HOST'),
                port: parseInt(config.get('REDIS_PORT') || '6379'),
                password: config.get('REDIS_PASSWORD'),
                retryStrategy: (times: number) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            });

            this.redis.on('error', (error) => {
                logger.error('Redis connection error:', error);
                ErrorReporter.reportError(error, {
                    context: 'ExecutionStrategyService.redis',
                    service: 'Redis'
                });
            });
        }

        this.initializeDefaultStrategies();
        this.startMetricsUpdateInterval();
    }

    async executeStrategy(
        instructions: TransactionInstruction[],
        context: TradeExecutionContext
    ): Promise<TransactionResult> {
        const timer = this.performanceMonitor.startTimer('executeStrategy');

        try {
            // Get all enabled strategies sorted by priority
            const enabledStrategies = Array.from(this.strategies.values())
                .filter(s => s.enabled)
                .sort((a, b) => b.priority - a.priority);

            if (enabledStrategies.length === 0) {
                throw new Error('No enabled execution strategies available');
            }

            // Try each strategy in order until one succeeds
            for (const strategy of enabledStrategies) {
                try {
                    const startTime = Date.now();
                    
                    // Validate strategy
                    const isValid = await strategy.validate(context);
                    if (!isValid) {
                        logger.debug(`Strategy ${strategy.name} validation failed`);
                        continue;
                    }

                    // Execute strategy
                    const result = await strategy.execute(instructions, context);
                    
                    // Update metrics
                    await this.updateStrategyMetrics(
                        strategy.name,
                        result.success,
                        Date.now() - startTime,
                        result.gasUsed
                    );

                    if (result.success) {
                        return result;
                    }
                } catch (error) {
                    logger.error(`Strategy ${strategy.name} execution error:`, error);
                    await this.updateStrategyMetrics(
                        strategy.name,
                        false,
                        0,
                        0
                    );
                }
            }

            throw new Error('All execution strategies failed');
        } catch (error) {
            logger.error('Strategy execution error:', error);
            ErrorReporter.reportError(error, {
                context: 'ExecutionStrategyService.executeStrategy',
                tradeId: context.positionId
            });
            return {
                success: false,
                error: error.message
            };
        } finally {
            this.performanceMonitor.endTimer('executeStrategy', timer);
        }
    }

    registerStrategy(strategy: ExecutionStrategy): void {
        if (this.strategies.has(strategy.name)) {
            throw new Error(`Strategy ${strategy.name} already registered`);
        }
        this.strategies.set(strategy.name, strategy);
    }

    async enableStrategy(name: string): Promise<void> {
        const strategy = this.strategies.get(name);
        if (!strategy) {
            throw new Error(`Strategy ${name} not found`);
        }
        strategy.enabled = true;
        await this.updateStrategyConfig(name, { enabled: true });
    }

    async disableStrategy(name: string): Promise<void> {
        const strategy = this.strategies.get(name);
        if (!strategy) {
            throw new Error(`Strategy ${name} not found`);
        }
        strategy.enabled = false;
        await this.updateStrategyConfig(name, { enabled: false });
    }

    private async updateStrategyMetrics(
        name: string,
        success: boolean,
        executionTime: number,
        gasUsed: number = 0
    ): Promise<void> {
        const currentMetrics = this.metrics.get(name) || {
            successRate: 0,
            averageExecutionTime: 0,
            failureRate: 0,
            totalExecutions: 0,
            avgGasUsed: 0,
            lastUpdated: Date.now()
        };

        const newTotalExecutions = currentMetrics.totalExecutions + 1;
        const newSuccesses = success ? 
            currentMetrics.successRate * currentMetrics.totalExecutions + 1 :
            currentMetrics.successRate * currentMetrics.totalExecutions;

        const updatedMetrics: StrategyMetrics = {
            successRate: newSuccesses / newTotalExecutions,
            averageExecutionTime: (
                currentMetrics.averageExecutionTime * currentMetrics.totalExecutions + executionTime
            ) / newTotalExecutions,
            failureRate: success ? 
                currentMetrics.failureRate :
                (currentMetrics.failureRate * currentMetrics.totalExecutions + 1) / newTotalExecutions,
            totalExecutions: newTotalExecutions,
            avgGasUsed: (
                currentMetrics.avgGasUsed * currentMetrics.totalExecutions + gasUsed
            ) / newTotalExecutions,
            lastUpdated: Date.now()
        };

        this.metrics.set(name, updatedMetrics);
        await this.cacheMetrics(name, updatedMetrics);
    }

    private async cacheMetrics(
        name: string,
        metrics: StrategyMetrics
    ): Promise<void> {
        if (!this.redis) return;

        try {
            await this.redis.setex(
                `strategy:${name}:metrics`,
                this.METRICS_TTL,
                JSON.stringify(metrics)
            );
        } catch (error) {
            logger.error('Error caching strategy metrics:', error);
        }
    }

    private async updateStrategyConfig(
        name: string,
        updates: Partial<ExecutionStrategy>
    ): Promise<void> {
        const strategy = this.strategies.get(name);
        if (!strategy) return;

        Object.assign(strategy, updates);

        if (this.redis) {
            try {
                await this.redis.setex(
                    `strategy:${name}:config`,
                    this.METRICS_TTL,
                    JSON.stringify({
                        enabled: strategy.enabled,
                        priority: strategy.priority,
                        config: strategy.config
                    })
                );
            } catch (error) {
                logger.error('Error updating strategy config:', error);
            }
        }
    }

    private initializeDefaultStrategies(): void {
        // Standard Market Order Strategy
        this.registerStrategy({
            name: 'standard_market',
            enabled: true,
            priority: 3,
            config: {
                maxRetries: 3,
                retryDelay: 1000
            },
            validate: async (context) => {
                return true; // Always valid as fallback
            },
            execute: async (instructions, context) => {
                return await this.transactionManager.sendTransaction(
                    await this.transactionManager.createTransaction(instructions),
                    context.userSubscription.userId,
                    context.txConfig
                );
            }
        });

        // Warp Transaction Strategy
        this.registerStrategy({
            name: 'warp_execution',
            enabled: this.config.get('USE_WARP_TRANSACTIONS') === 'true',
            priority: 2,
            config: {
                maxBundleSize: 5,
                maxTimeout: 10000
            },
            validate: async (context) => {
                return context.userSubscription.features.warpEnabled;
            },
            execute: async (instructions, context) => {
                const txConfig: TransactionConfig = {
                    ...context.txConfig,
                    warpEnabled: true
                };
                return await this.transactionManager.sendTransaction(
                    await this.transactionManager.createTransaction(instructions),
                    context.userSubscription.userId,
                    txConfig
                );
            }
        });

        // Jito MEV Strategy
        this.registerStrategy({
            name: 'jito_mev',
            enabled: this.config.get('USE_JITO_TRANSACTIONS') === 'true',
            priority: 1,
            config: {
                tipThreshold: new BN(10000)
            },
            validate: async (context) => {
                return context.userSubscription.features.jitoEnabled;
            },
            execute: async (instructions, context) => {
                const txConfig: TransactionConfig = {
                    ...context.txConfig,
                    jitoEnabled: true
                };
                return await this.transactionManager.sendTransaction(
                    await this.transactionManager.createTransaction(instructions),
                    context.userSubscription.userId,
                    txConfig
                );
            }
        });
    }

    private startMetricsUpdateInterval(): void {
        setInterval(async () => {
            for (const [name, metrics] of this.metrics.entries()) {
                await this.cacheMetrics(name, metrics);
            }
        }, this.METRICS_UPDATE_INTERVAL);
    }

    getStrategyMetrics(name: string): StrategyMetrics | null {
        return this.metrics.get(name) || null;
    }

    getAllStrategies(): ExecutionStrategy[] {
        return Array.from(this.strategies.values());
    }

    getEnabledStrategies(): ExecutionStrategy[] {
        return Array.from(this.strategies.values())
            .filter(s => s.enabled)
            .sort((a, b) => b.priority - a.priority);
    }
}
