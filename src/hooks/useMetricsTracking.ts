import { useState, useEffect, useCallback, useRef } from 'react';
import { PerformanceMonitor } from '../utils/performance';
import { useAccessibility } from '../components/AccessibilityProvider';
import { logger } from '../utils/logger';

interface MetricsConfig {
    interval?: number;
    enabled?: boolean;
    sampleRate?: number;
    aggregationPeriod?: number;
}

interface MetricSnapshot {
    timestamp: Date;
    metrics: Record<string, number>;
    events: MetricEvent[];
}

interface MetricEvent {
    name: string;
    value: number;
    metadata?: Record<string, any>;
}

export function useMetricsTracking(
    componentName: string,
    config: MetricsConfig = {}
) {
    const {
        interval = 5000,
        enabled = true,
        sampleRate = 1,
        aggregationPeriod = 60000
    } = config;

    const { announceMessage } = useAccessibility();
    const metricsRef = useRef<MetricSnapshot[]>([]);
    const eventsRef = useRef<MetricEvent[]>([]);
    const timerRef = useRef<NodeJS.Timeout>();

    const [currentMetrics, setCurrentMetrics] = useState<MetricSnapshot>(null);

    const trackEvent = useCallback((
        name: string,
        value: number,
        metadata?: Record<string, any>
    ) => {
        if (!enabled || Math.random() > sampleRate) return;

        const event: MetricEvent = {
            name,
            value,
            metadata,
            timestamp: new Date()
        };

        eventsRef.current.push(event);
        PerformanceMonitor.recordMetric(name, {
            timestamp: event.timestamp,
            duration: value,
            context: metadata
        });

    }, [enabled, sampleRate]);

    const aggregateMetrics = useCallback(() => {
        const now = new Date();
        const cutoff = new Date(now.getTime() - aggregationPeriod);

        // Filter old metrics
        metricsRef.current = metricsRef.current.filter(
            m => m.timestamp > cutoff
        );

        // Aggregate events
        const events = eventsRef.current.filter(
            e => e.timestamp > cutoff
        );

        const aggregated: Record<string, number> = {};
        
        events.forEach(event => {
            if (!aggregated[event.name]) {
                aggregated[event.name] = 0;
            }
            aggregated[event.name] += event.value;
        });

        // Calculate averages
        Object.keys(aggregated).forEach(key => {
            const eventCount = events.filter(e => e.name === key).length;
            aggregated[key] = aggregated[key] / eventCount;
        });

        const snapshot: MetricSnapshot = {
            timestamp: now,
            metrics: aggregated,
            events: [...events]
        };

        metricsRef.current.push(snapshot);
        setCurrentMetrics(snapshot);

        // Clear processed events
        eventsRef.current = eventsRef.current.filter(
            e => e.timestamp > now
        );

        return snapshot;
    }, [aggregationPeriod]);

    const getMetricAverage = useCallback((
        metricName: string,
        timeWindow: number = aggregationPeriod
    ) => {
        const now = new Date();
        const cutoff = new Date(now.getTime() - timeWindow);

        const relevantSnapshots = metricsRef.current.filter(
            s => s.timestamp > cutoff
        );

        if (relevantSnapshots.length === 0) return 0;

        const sum = relevantSnapshots.reduce((acc, snapshot) => {
            return acc + (snapshot.metrics[metricName] || 0);
        }, 0);

        return sum / relevantSnapshots.length;
    }, [aggregationPeriod]);

    const detectAnomalies = useCallback((snapshot: MetricSnapshot) => {
        Object.entries(snapshot.metrics).forEach(([metric, value]) => {
            const average = getMetricAverage(metric);
            const threshold = average * 2; // 200% of average

            if (value > threshold) {
                logger.warn(`Anomaly detected in ${metric}`, {
                    component: componentName,
                    current: value,
                    average,
                    threshold
                });

                announceMessage(`Performance anomaly detected in ${metric}`);
            }
        });
    }, [componentName, getMetricAverage, announceMessage]);

    useEffect(() => {
        if (!enabled) return;

        const collectMetrics = async () => {
            try {
                const snapshot = aggregateMetrics();
                detectAnomalies(snapshot);
            } catch (error) {
                logger.error('Error collecting metrics:', error);
            }
        };

        timerRef.current = setInterval(collectMetrics, interval);

        return () => {
            if (timerRef.current) {
                clearInterval(timerRef.current);
            }
        };
    }, [enabled, interval, aggregateMetrics, detectAnomalies]);

    return {
        trackEvent,
        currentMetrics,
        getMetricAverage,
        metricsHistory: metricsRef.current
    };
}
