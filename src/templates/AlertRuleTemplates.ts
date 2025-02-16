import { Decimal } from 'decimal.js';
import { AlertRule } from '../types/monitoring.types';

export const AlertRuleTemplates: Record<string, Omit<AlertRule, 'id'>> = {
    highCpuUsage: {
        name: 'High CPU Usage',
        metric: 'system.cpu.usage',
        condition: 'gt',
        threshold: new Decimal('80'),
        severity: 'warning',
        duration: 300,
        enabled: true,
        notificationChannels: ['email', 'slack'],
        description: 'Alerts when CPU usage exceeds 80% for 5 minutes'
    },

    criticalMemoryUsage: {
        name: 'Critical Memory Usage',
        metric: 'system.memory.usage',
        condition: 'gt',
        threshold: new Decimal('90'),
        severity: 'critical',
        duration: 120,
        enabled: true,
        notificationChannels: ['email', 'slack', 'telegram'],
        description: 'Alerts when memory usage exceeds 90% for 2 minutes'
    },

    highLatency: {
        name: 'High WebSocket Latency',
        metric: 'websocket.latency',
        condition: 'gt',
        threshold: new Decimal('1000'),
        severity: 'warning',
        duration: 60,
        enabled: true,
        notificationChannels: ['slack'],
        description: 'Alerts when WebSocket latency exceeds 1000ms for 1 minute'
    },

    orderQueueBacklog: {
        name: 'Order Queue Backlog',
        metric: 'orders.queue.size',
        condition: 'gt',
        threshold: new Decimal('1000'),
        severity: 'warning',
        duration: 300,
        enabled: true,
        notificationChannels: ['email', 'slack'],
        description: 'Alerts when order queue exceeds 1000 items for 5 minutes'
    },

    errorRateSpike: {
        name: 'Error Rate Spike',
        metric: 'system.error.rate',
        condition: 'gt',
        threshold: new Decimal('5'),
        severity: 'critical',
        duration: 60,
        enabled: true,
        notificationChannels: ['email', 'slack', 'telegram'],
        description: 'Alerts when error rate exceeds 5% for 1 minute'
    },

    lowDiskSpace: {
        name: 'Low Disk Space',
        metric: 'system.disk.usage',
        condition: 'gt',
        threshold: new Decimal('85'),
        severity: 'warning',
        duration: 600,
        enabled: true,
        notificationChannels: ['email'],
        description: 'Alerts when disk usage exceeds 85% for 10 minutes'
    }
};

export function createAlertRuleFromTemplate(
    templateName: keyof typeof AlertRuleTemplates,
    overrides: Partial<AlertRule> = {}
): Omit<AlertRule, 'id'> {
    const template = AlertRuleTemplates[templateName];
    if (!template) {
        throw new Error(`Template "${templateName}" not found`);
    }

    return {
        ...template,
        ...overrides
    };
}
