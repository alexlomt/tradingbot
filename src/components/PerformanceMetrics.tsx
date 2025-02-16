import React, { useEffect, useRef, useState } from 'react';
import {
    Paper,
    Group,
    Stack,
    Text,
    Select,
    Grid,
    Button,
    MultiSelect
} from '@mantine/core';
import { DateRangePicker } from '@mantine/dates';
import { Line } from 'react-chartjs-2';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend
} from 'chart.js';
import { useMonitoring } from '../hooks/useMonitoring';
import { formatNumber, formatDate } from '../utils/formatters';
import { Decimal } from 'decimal.js';
import { SystemMetrics } from '../types/monitoring.types';

ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend
);

interface PerformanceMetricsProps {
    defaultRange?: [Date, Date];
    defaultMetrics?: string[];
}

export const PerformanceMetrics: React.FC<PerformanceMetricsProps> = ({
    defaultRange = [
        new Date(Date.now() - 24 * 60 * 60 * 1000),
        new Date()
    ],
    defaultMetrics = ['cpuUsage', 'memoryUsage', 'wsLatency']
}) => {
    const { getHistoricalMetrics } = useMonitoring();
    const [dateRange, setDateRange] = useState<[Date, Date]>(defaultRange);
    const [selectedMetrics, setSelectedMetrics] = useState<string[]>(defaultMetrics);
    const [metrics, setMetrics] = useState<SystemMetrics[]>([]);
    const [timeframe, setTimeframe] = useState<'1m' | '5m' | '15m' | '1h'>('5m');

    useEffect(() => {
        loadMetrics();
    }, [dateRange, timeframe]);

    const loadMetrics = async () => {
        const data = await getHistoricalMetrics(dateRange[0], dateRange[1]);
        const aggregatedData = aggregateMetrics(data, timeframe);
        setMetrics(aggregatedData);
    };

    const aggregateMetrics = (
        data: SystemMetrics[],
        timeframe: string
    ): SystemMetrics[] => {
        const interval = getIntervalMilliseconds(timeframe);
        const buckets = new Map<number, SystemMetrics[]>();

        data.forEach(metric => {
            const bucket = Math.floor(metric.timestamp.getTime() / interval) * interval;
            if (!buckets.has(bucket)) {
                buckets.set(bucket, []);
            }
            buckets.get(bucket).push(metric);
        });

        return Array.from(buckets.entries())
            .map(([timestamp, bucketMetrics]) => ({
                timestamp: new Date(timestamp),
                ...aggregateBucketMetrics(bucketMetrics)
            }))
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    };

    const aggregateBucketMetrics = (
        bucketMetrics: SystemMetrics[]
    ): Partial<SystemMetrics> => {
        const result: Partial<SystemMetrics> = {};
        const numMetrics = bucketMetrics.length;

        for (const metric of selectedMetrics) {
            const values = bucketMetrics.map(m => m[metric]);
            result[metric] = values.reduce(
                (sum, val) => sum.plus(val),
                new Decimal(0)
            ).div(numMetrics);
        }

        return result;
    };

    const getIntervalMilliseconds = (timeframe: string): number => {
        switch (timeframe) {
            case '1m': return 60 * 1000;
            case '5m': return 5 * 60 * 1000;
            case '15m': return 15 * 60 * 1000;
            case '1h': return 60 * 60 * 1000;
            default: return 5 * 60 * 1000;
        }
    };

    const chartData = {
        labels: metrics.map(m => formatDate(m.timestamp)),
        datasets: selectedMetrics.map(metric => ({
            label: metric,
            data: metrics.map(m => m[metric].toNumber()),
            borderColor: getMetricColor(metric),
            tension: 0.1
        }))
    };

    const chartOptions = {
        responsive: true,
        interaction: {
            mode: 'index' as const,
            intersect: false,
        },
        plugins: {
            legend: {
                position: 'top' as const,
            }
        },
        scales: {
            y: {
                type: 'linear' as const,
                display: true,
                position: 'left' as const,
            }
        }
    };

    const getMetricColor = (metric: string): string => {
        switch (metric) {
            case 'cpuUsage': return '#228BE6';
            case 'memoryUsage': return '#40C057';
            case 'wsLatency': return '#FA5252';
            case 'activeConnections': return '#7950F2';
            case 'queueSize': return '#FD7E14';
            default: return '#868E96';
        }
    };

    return (
        <Paper p="md" radius="md">
            <Stack spacing="md">
                <Group position="apart">
                    <Text size="lg" weight={500}>Performance Metrics</Text>
                    <Group spacing="xs">
                        <Select
                            value={timeframe}
                            onChange={(value) => setTimeframe(value as any)}
                            data={[
                                { value: '1m', label: '1 minute' },
                                { value: '5m', label: '5 minutes' },
                                { value: '15m', label: '15 minutes' },
                                { value: '1h', label: '1 hour' }
                            ]}
                            size="xs"
                        />
                        <Button 
                            size="xs"
                            variant="light"
                            onClick={loadMetrics}
                        >
                            Refresh
                        </Button>
                    </Group>
                </Group>

                <Grid>
                    <Grid.Col span={12}>
                        <Group spacing="md" grow>
                            <DateRangePicker
                                value={dateRange}
                                onChange={setDateRange}
                                size="xs"
                            />
                            <MultiSelect
                                data={[
                                    { value: 'cpuUsage', label: 'CPU Usage' },
                                    { value: 'memoryUsage', label: 'Memory Usage' },
                                    { value: 'wsLatency', label: 'WebSocket Latency' },
                                    { value: 'activeConnections', label: 'Active Connections' },
                                    { value: 'queueSize', label: 'Queue Size' }
                                ]}
                                value={selectedMetrics}
                                onChange={setSelectedMetrics}
                                size="xs"
                                placeholder="Select metrics"
                            />
                        </Group>
                    </Grid.Col>

                    <Grid.Col span={12}>
                        <Line 
                            data={chartData}
                            options={chartOptions}
                            height={300}
                        />
                    </Grid.Col>
                </Grid>
            </Stack>
        </Paper>
    );
};
