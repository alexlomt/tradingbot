import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
    Paper,
    Title,
    Group,
    Select,
    Text,
    Stack,
    Badge,
    ThemeIcon
} from '@mantine/core';
import { IconChartLine, IconAlertTriangle } from '@tabler/icons-react';
import { useMetricsTracking } from '../hooks/useMetricsTracking';
import { useStyles } from './PerformanceVisualizer.styles';
import { formatNumber } from '../utils/formatters';

interface PerformanceVisualizerProps {
    componentName: string;
    metricKey: string;
    threshold?: number;
    timeRange?: number;
}

export const PerformanceVisualizer: React.FC<PerformanceVisualizerProps> = ({
    componentName,
    metricKey,
    threshold,
    timeRange = 3600000 // 1 hour
}) => {
    const { classes, cx } = useStyles();
    const { metricsHistory, currentMetrics, getMetricAverage } = useMetricsTracking(
        componentName,
        { aggregationPeriod: timeRange }
    );

    const chartData = useMemo(() => {
        const now = Date.now();
        const cutoff = now - timeRange;
        
        const filteredMetrics = metricsHistory.filter(
            m => m.timestamp.getTime() > cutoff
        );

        return {
            labels: filteredMetrics.map(m => 
                new Date(m.timestamp).toLocaleTimeString()
            ),
            datasets: [{
                label: metricKey,
                data: filteredMetrics.map(m => m.metrics[metricKey] || 0),
                fill: false,
                borderColor: '#228be6',
                tension: 0.4
            }]
        };
    }, [metricsHistory, metricKey, timeRange]);

    const currentValue = currentMetrics?.metrics[metricKey] || 0;
    const average = getMetricAverage(metricKey);
    const isAboveThreshold = threshold && currentValue > threshold;

    return (
        <Paper className={classes.root} p="md">
            <Stack spacing="md">
                <Group position="apart">
                    <Group>
                        <ThemeIcon
                            size="lg"
                            variant="light"
                            color={isAboveThreshold ? 'red' : 'blue'}
                        >
                            {isAboveThreshold ? (
                                <IconAlertTriangle size={20} />
                            ) : (
                                <IconChartLine size={20} />
                            )}
                        </ThemeIcon>
                        <Title order={4}>{metricKey}</Title>
                    </Group>
                    <Select
                        size="xs"
                        defaultValue="1h"
                        data={[
                            { value: '1h', label: 'Last Hour' },
                            { value: '6h', label: 'Last 6 Hours' },
                            { value: '24h', label: 'Last 24 Hours' }
                        ]}
                        onChange={(value) => {
                            const hours = parseInt(value);
                            // Update timeRange through prop callback
                        }}
                    />
                </Group>

                <Group spacing="xl">
                    <div>
                        <Text size="sm" color="dimmed">Current</Text>
                        <Text size="xl" weight={500}>
                            {formatNumber(currentValue)}
                        </Text>
                    </div>
                    <div>
                        <Text size="sm" color="dimmed">Average</Text>
                        <Text size="xl" weight={500}>
                            {formatNumber(average)}
                        </Text>
                    </div>
                    {threshold && (
                        <div>
                            <Text size="sm" color="dimmed">Threshold</Text>
                            <Text size="xl" weight={500}>
                                {formatNumber(threshold)}
                            </Text>
                        </div>
                    )}
                </Group>

                {isAboveThreshold && (
                    <Badge 
                        color="red"
                        variant="filled"
                        size="lg"
                    >
                        Exceeds Threshold
                    </Badge>
                )}

                <div className={classes.chartContainer}>
                    <Line
                        data={chartData}
                        options={{
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: {
                                    display: false
                                }
                            },
                            scales: {
                                y: {
                                    beginAtZero: true,
                                    ticks: {
                                        callback: (value) => formatNumber(value)
                                    }
                                }
                            }
                        }}
                    />
                </div>
            </Stack>
        </Paper>
    );
};
