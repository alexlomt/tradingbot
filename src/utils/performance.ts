import { PerformanceMetric } from '../types/monitoring.types';

interface PerformanceData {
    metrics: Map<string, PerformanceMetric[]>;
    marks: Map<string, PerformanceMark[]>;
}

const performanceData: PerformanceData = {
    metrics: new Map(),
    marks: new Map()
};

export class PerformanceMonitor {
    private static readonly MAX_METRICS = 1000;
    private static readonly CLEANUP_THRESHOLD = 0.9; // 90%

    static startMeasure(name: string): void {
        performance.mark(`${name}-start`);
    }

    static endMeasure(name: string, context: Record<string, any> = {}): void {
        try {
            performance.mark(`${name}-end`);
            performance.measure(name, `${name}-start`, `${name}-end`);

            const entry = performance.getEntriesByName(name).pop();
            if (entry) {
                this.recordMetric(name, {
                    timestamp: new Date(),
                    duration: entry.duration,
                    context
                });
            }

            // Cleanup marks
            performance.clearMarks(`${name}-start`);
            performance.clearMarks(`${name}-end`);
            performance.clearMeasures(name);
        } catch (error) {
            console.error(`Performance measurement error for ${name}:`, error);
        }
    }

    static recordMetric(name: string, data: PerformanceMetric): void {
        if (!performanceData.metrics.has(name)) {
            performanceData.metrics.set(name, []);
        }

        const metrics = performanceData.metrics.get(name);
        metrics.push(data);

        if (metrics.length > this.MAX_METRICS) {
            this.cleanup(name);
        }
    }

    private static cleanup(metricName: string): void {
        const metrics = performanceData.metrics.get(metricName);
        if (metrics) {
            const cutoff = Math.floor(this.MAX_METRICS * this.CLEANUP_THRESHOLD);
            performanceData.metrics.set(metricName, metrics.slice(-cutoff));
        }
    }

    static getMetrics(name: string): PerformanceMetric[] {
        return performanceData.metrics.get(name) || [];
    }

    static getAverageMetric(name: string, lastN?: number): number {
        const metrics = this.getMetrics(name);
        if (!metrics.length) return 0;

        const subset = lastN ? metrics.slice(-lastN) : metrics;
        const sum = subset.reduce((acc, metric) => acc + metric.duration, 0);
        return sum / subset.length;
    }

    static reportLongTask(duration: number, taskInfo: string): void {
        if (duration > 50) { // 50ms threshold for long tasks
            this.recordMetric('long-task', {
                timestamp: new Date(),
                duration,
                context: { taskInfo }
            });
        }
    }

    static async measureAsync<T>(
        name: string,
        fn: () => Promise<T>,
        context: Record<string, any> = {}
    ): Promise<T> {
        this.startMeasure(name);
        try {
            const result = await fn();
            return result;
        } finally {
            this.endMeasure(name, context);
        }
    }
}
