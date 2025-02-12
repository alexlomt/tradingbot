// src/services/filters/filter-manager.ts
import { EventEmitter } from 'events';
import { FilterChain } from './filter-chain';
import { logger } from '../../config/logger';

export class FilterManager extends EventEmitter {
    private filterChain: FilterChain;

    constructor(connection: Connection, config: FilterConfig) {
        super();
        this.filterChain = new FilterChain(connection, config);
    }

    async executeFilters(poolKeys: LiquidityPoolKeysV4): Promise<{
        passed: boolean;
        results: FilterResult[];
    }> {
        try {
            const results = await this.filterChain.executeFilterChain(poolKeys);
            const passed = results.every(r => r.passed);

            // Emit filter results for real-time updates
            this.emit('filterResults', {
                mint: poolKeys.baseMint.toString(),
                results,
                passed,
                timestamp: new Date()
            });

            return { passed, results };
        } catch (error) {
            logger.error('Filter execution failed:', error);
            throw error;
        }
    }
}