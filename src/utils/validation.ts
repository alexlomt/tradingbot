import { Decimal } from 'decimal.js';
import { AlertRule } from '../types/monitoring.types';
import { SystemConfig } from '../types/config.types';

interface ValidationResult {
    isValid: boolean;
    errors: string[];
}

export function validateAlertRule(rule: Partial<AlertRule>): ValidationResult {
    const errors: string[] = [];

    if (!rule.name?.trim()) {
        errors.push('Rule name is required');
    } else if (rule.name.length > 100) {
        errors.push('Rule name must be less than 100 characters');
    }

    if (!rule.metric?.trim()) {
        errors.push('Metric is required');
    }

    if (!rule.condition) {
        errors.push('Condition is required');
    } else if (!['gt', 'lt', 'eq', 'gte', 'lte'].includes(rule.condition)) {
        errors.push('Invalid condition type');
    }

    try {
        if (!rule.threshold || new Decimal(rule.threshold).isNaN()) {
            errors.push('Valid threshold value is required');
        }
    } catch {
        errors.push('Invalid threshold format');
    }

    if (!rule.severity || !['info', 'warning', 'critical'].includes(rule.severity)) {
        errors.push('Valid severity level is required');
    }

    if (rule.duration !== undefined && (
        typeof rule.duration !== 'number' ||
        rule.duration < 0 ||
        rule.duration > 86400
    )) {
        errors.push('Duration must be between 0 and 86400 seconds');
    }

    if (rule.notificationChannels?.length > 0) {
        const validChannels = ['email', 'slack', 'telegram'];
        const invalidChannels = rule.notificationChannels.filter(
            channel => !validChannels.includes(channel)
        );
        if (invalidChannels.length > 0) {
            errors.push(`Invalid notification channels: ${invalidChannels.join(', ')}`);
        }
    }

    return {
        isValid: errors.length === 0,
        errors
    };
}

export function validateConfig(config: SystemConfig): ValidationResult {
    const errors: string[] = [];

    // Monitoring validation
    if (!config.monitoring) {
        errors.push('Monitoring configuration is required');
    } else {
        const { interval, retentionDays, alertThrottling } = config.monitoring;
        
        if (interval < 1000 || interval > 60000) {
            errors.push('Monitoring interval must be between 1 and 60 seconds');
        }
        
        if (retentionDays < 1 || retentionDays > 365) {
            errors.push('Retention period must be between 1 and 365 days');
        }
        
        if (alertThrottling < 0 || alertThrottling > 3600) {
            errors.push('Alert throttling must be between 0 and 3600 seconds');
        }
    }

    // WebSocket validation
    if (!config.websocket) {
        errors.push('WebSocket configuration is required');
    } else {
        const { reconnectAttempts, reconnectInterval, pingInterval } = config.websocket;
        
        if (reconnectAttempts < 1 || reconnectAttempts > 10) {
            errors.push('Reconnect attempts must be between 1 and 10');
        }
        
        if (reconnectInterval < 1000 || reconnectInterval > 30000) {
            errors.push('Reconnect interval must be between 1 and 30 seconds');
        }
        
        if (pingInterval < 5000 || pingInterval > 60000) {
            errors.push('Ping interval must be between 5 and 60 seconds');
        }
    }

    // Notifications validation
    if (config.notifications) {
        const { email, slack, telegram } = config.notifications;
        
        if (email?.enabled) {
            if (!email.smtpHost?.trim()) {
                errors.push('SMTP host is required for email notifications');
            }
            if (!email.smtpPort || email.smtpPort < 1 || email.smtpPort > 65535) {
                errors.push('Valid SMTP port is required');
            }
            if (!email.sender?.trim() || !isValidEmail(email.sender)) {
                errors.push('Valid sender email is required');
            }
            if (email.recipients?.some(r => !isValidEmail(r))) {
                errors.push('All recipient email addresses must be valid');
            }
        }
        
        if (slack?.enabled) {
            if (!slack.webhook?.trim() || !isValidUrl(slack.webhook)) {
                errors.push('Valid Slack webhook URL is required');
            }
            if (!slack.channel?.trim()) {
                errors.push('Slack channel is required');
            }
        }
        
        if (telegram?.enabled) {
            if (!telegram.botToken?.trim()) {
                errors.push('Telegram bot token is required');
            }
            if (!telegram.chatId?.trim()) {
                errors.push('Telegram chat ID is required');
            }
        }
    }

    // Logging validation
    if (!config.logging) {
        errors.push('Logging configuration is required');
    } else {
        const { level, retention, maxSize } = config.logging;
        
        if (!['debug', 'info', 'warn', 'error'].includes(level)) {
            errors.push('Invalid logging level');
        }
        
        if (retention < 1 || retention > 365) {
            errors.push('Log retention must be between 1 and 365 days');
        }
        
        if (maxSize < 1 || maxSize > 1000) {
            errors.push('Max log size must be between 1 and 1000 MB');
        }
    }

    return {
        isValid: errors.length === 0,
        errors
    };
}

export function isValidEmail(email: string): boolean {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
}

export function isValidUrl(url: string): boolean {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}
