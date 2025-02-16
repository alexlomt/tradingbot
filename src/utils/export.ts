import { saveAs } from 'file-saver';
import { format } from 'date-fns';
import { SystemMetrics } from '../types/monitoring.types';
import { formatNumber, formatDate } from './formatters';

interface ExportOptions {
    format: 'csv' | 'json';
    includeHeaders?: boolean;
    filename?: string;
}

export async function exportMetrics(
    startDate: Date,
    endDate: Date,
    options: ExportOptions = { format: 'csv', includeHeaders: true }
): Promise<void> {
    try {
        const metrics = await fetchMetricsData(startDate, endDate);
        const formattedData = formatMetricsData(metrics, options);
        const blob = createExportBlob(formattedData, options);
        const filename = options.filename || generateFilename(startDate, endDate, options.format);
        saveAs(blob, filename);
    } catch (error) {
        console.error('Export failed:', error);
        throw new Error('Failed to export metrics data');
    }
}

async function fetchMetricsData(
    startDate: Date,
    endDate: Date
): Promise<SystemMetrics[]> {
    const response = await fetch('/api/metrics', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString()
        })
    });

    if (!response.ok) {
        throw new Error('Failed to fetch metrics data');
    }

    return response.json();
}

function formatMetricsData(
    metrics: SystemMetrics[],
    options: ExportOptions
): string {
    if (options.format === 'json') {
        return JSON.stringify(metrics, null, 2);
    }

    const headers = [
        'Timestamp',
        'CPU Usage',
        'Memory Usage',
        'WebSocket Latency',
        'Active Connections',
        'Queue Size',
        'Status'
    ];

    const rows = metrics.map(metric => [
        formatDate(metric.timestamp),
        formatNumber(metric.cpuUsage),
        formatNumber(metric.memoryUsage),
        metric.wsLatency.toString(),
        metric.activeConnections.toString(),
        metric.queueSize.toString(),
        metric.status
    ]);

    if (options.includeHeaders) {
        rows.unshift(headers);
    }

    return rows
        .map(row => row.join(','))
        .join('\n');
}

function createExportBlob(
    data: string,
    options: ExportOptions
): Blob {
    const mimeTypes = {
        csv: 'text/csv;charset=utf-8',
        json: 'application/json;charset=utf-8'
    };

    return new Blob(
        [data],
        { type: mimeTypes[options.format] }
    );
}

function generateFilename(
    startDate: Date,
    endDate: Date,
    format: string
): string {
    const formatString = 'yyyyMMdd_HHmmss';
    return `metrics_${format(startDate, formatString)}_${format(endDate, formatString)}.${format}`;
}
