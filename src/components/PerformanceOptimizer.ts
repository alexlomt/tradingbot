import React, { useEffect, useRef, memo } from 'react';
import { useMetricsTracking } from '../hooks/useMetricsTracking';
import { PerformanceMonitor } from '../utils/performance';

interface PerformanceOptimizerProps {
    children: React.ReactNode;
    componentName: string;
    renderThreshold?: number;
    onPerformanceIssue?: (metrics: any) => void;
}

export const PerformanceOptimizer = memo(({
    children,
    componentName,
    renderThreshold = 16, // ~60fps
    onPerformanceIssue
}: PerformanceOptimizerProps) => {
    const renderCount = useRef(0);
    const lastRenderTime = useRef(performance.now());
    
    const { trackEvent } = useMetricsTracking(componentName, {
        sampleRate: 0.1, // Sample 10% of renders
        aggregationPeriod: 300000 // 5 minutes
    });

    useEffect(() => {
        renderCount.current++;
        const currentTime = performance.now();
        const renderDuration = currentTime - lastRenderTime.current;

        trackEvent('render-duration', renderDuration, {
            renderCount: renderCount.current,
            componentName
        });

        if (renderDuration > renderThreshold) {
            PerformanceMonitor.reportLongTask(renderDuration, `${componentName} render`);
            
            if (onPerformanceIssue) {
                onPerformanceIssue({
                    componentName,
                    renderDuration,
                    renderCount: renderCount.current,
                    threshold: renderThreshold
                });
            }
        }

        lastRenderTime.current = currentTime;
    });

    return (
        <React.Profiler
            id={`${componentName}-profiler`}
            onRender={(
                id,
                phase,
                actualDuration,
                baseDuration,
                startTime,
                commitTime,
                interactions
            ) => {
                trackEvent('profiler-duration', actualDuration, {
                    phase,
                    baseDuration,
                    startTime,
                    commitTime,
                    interactionCount: interactions.size
                });
            }}
        >
            {children}
        </React.Profiler>
    );
});

PerformanceOptimizer.displayName = 'PerformanceOptimizer';
