import { AlertNotification } from '../types/monitoring.types';
import { format } from 'date-fns';

interface NotificationTemplate {
    subject: string;
    body: string;
    color?: string;
    priority?: 'low' | 'normal' | 'high';
}

export class AlertNotificationTemplates {
    private static getSeverityEmoji(severity: string): string {
        switch (severity.toLowerCase()) {
            case 'critical':
                return '🔴';
            case 'warning':
                return '⚠️';
            case 'info':
                return 'ℹ️';
            default:
                return '❗';
        }
    }

    private static formatValue(value: any): string {
        if (typeof value === 'number') {
            return value.toLocaleString(undefined, {
                maximumFractionDigits: 8
            });
        }
        return String(value);
    }

    private static formatTimestamp(date: Date): string {
        return format(date, 'yyyy-MM-dd HH:mm:ss');
    }

    static getEmailTemplate(alert: AlertNotification): NotificationTemplate {
        const emoji = this.getSeverityEmoji(alert.severity);
        
        return {
            subject: `${emoji} [${alert.severity.toUpperCase()}] ${alert.name}`,
            body: `
                <h2>${emoji} Alert: ${alert.name}</h2>
                <p><strong>Status:</strong> ${alert.status}</p>
                <p><strong>Severity:</strong> ${alert.severity}</p>
                <p><strong>Metric:</strong> ${alert.metric}</p>
                <p><strong>Value:</strong> ${this.formatValue(alert.value)}</p>
                <p><strong>Threshold:</strong> ${this.formatValue(alert.threshold)}</p>
                <p><strong>Triggered at:</strong> ${this.formatTimestamp(alert.timestamp)}</p>
                ${alert.description ? `<p><strong>Description:</strong> ${alert.description}</p>` : ''}
                <hr>
                <p><small>View details in monitoring dashboard</small></p>
            `.trim(),
            priority: alert.severity === 'critical' ? 'high' : 'normal'
        };
    }

    static getSlackTemplate(alert: AlertNotification): NotificationTemplate {
        const emoji = this.getSeverityEmoji(alert.severity);
        const color = alert.severity === 'critical' ? '#FF0000' : 
                     alert.severity === 'warning' ? '#FFA500' : '#0000FF';

        return {
            subject: `${emoji} Alert: ${alert.name}`,
            body: [
                `*Status:* ${alert.status}`,
                `*Severity:* ${alert.severity}`,
                `*Metric:* ${alert.metric}`,
                `*Value:* ${this.formatValue(alert.value)}`,
                `*Threshold:* ${this.formatValue(alert.threshold)}`,
                `*Triggered at:* ${this.formatTimestamp(alert.timestamp)}`,
                alert.description ? `*Description:* ${alert.description}` : ''
            ].filter(Boolean).join('\n'),
            color
        };
    }

    static getTelegramTemplate(alert: AlertNotification): NotificationTemplate {
        const emoji = this.getSeverityEmoji(alert.severity);
        
        return {
            subject: `${emoji} Alert: ${alert.name}`,
            body: [
                `${emoji} *Alert: ${alert.name}*`,
                ``,
                `*Status:* ${alert.status}`,
                `*Severity:* ${alert.severity}`,
                `*Metric:* ${alert.metric}`,
                `*Value:* ${this.formatValue(alert.value)}`,
                `*Threshold:* ${this.formatValue(alert.threshold)}`,
                `*Triggered at:* ${this.formatTimestamp(alert.timestamp)}`,
                alert.description ? `\n*Description:* ${alert.description}` : ''
            ].filter(Boolean).join('\n'),
            priority: alert.severity === 'critical' ? 'high' : 'normal'
        };
    }

    static getJsonTemplate(alert: AlertNotification): any {
        return {
            alert_name: alert.name,
            status: alert.status,
            severity: alert.severity,
            metric: alert.metric,
            value: this.formatValue(alert.value),
            threshold: this.formatValue(alert.threshold),
            timestamp: this.formatTimestamp(alert.timestamp),
            description: alert.description || null
        };
    }
}
