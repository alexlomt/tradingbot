import { validateAlertRule, validateConfig, isValidEmail, isValidUrl } from '../utils/validation';
import { AlertRule } from '../types/monitoring.types';
import { SystemConfig } from '../types/config.types';
import { Decimal } from 'decimal.js';

describe('Validation Utilities', () => {
    describe('validateAlertRule', () => {
        const validRule: AlertRule = {
            id: 'test_rule',
            name: 'Test Rule',
            metric: 'cpu_usage',
            condition: 'gt',
            threshold: new Decimal('80'),
            severity: 'warning',
            duration: 300,
            enabled: true,
            notificationChannels: ['email', 'slack']
        };

        it('should validate a correct alert rule', () => {
            const result = validateAlertRule(validRule);
            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should reject invalid rule name', () => {
            const result = validateAlertRule({ ...validRule, name: '' });
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Rule name is required');
        });

        it('should reject invalid threshold', () => {
            const result = validateAlertRule({ 
                ...validRule, 
                threshold: new Decimal('NaN') 
            });
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Valid threshold value is required');
        });

        it('should validate notification channels', () => {
            const result = validateAlertRule({
                ...validRule,
                notificationChannels: ['invalid_channel']
            });
            expect(result.isValid).toBe(false);
            expect(result.errors[0]).toMatch(/Invalid notification channels/);
        });
    });

    describe('validateConfig', () => {
        const validConfig: SystemConfig = {
            monitoring: {
                interval: 5000,
                retentionDays: 30,
                alertThrottling: 300
            },
            websocket: {
                reconnectAttempts: 3,
                reconnectInterval: 5000,
                pingInterval: 30000
            },
            notifications: {
                email: {
                    enabled: true,
                    smtpHost: 'smtp.example.com',
                    smtpPort: 587,
                    sender: 'alerts@example.com',
                    recipients: ['admin@example.com']
                },
                slack: {
                    enabled: true,
                    webhook: 'https://hooks.slack.com/services/xxx',
                    channel: '#alerts'
                },
                telegram: {
                    enabled: false,
                    botToken: '',
                    chatId: ''
                }
            },
            logging: {
                level: 'info',
                retention: 30,
                maxSize: 100
            }
        };

        it('should validate correct config', () => {
            const result = validateConfig(validConfig);
            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should validate monitoring intervals', () => {
            const result = validateConfig({
                ...validConfig,
                monitoring: {
                    ...validConfig.monitoring,
                    interval: 500
                }
            });
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain(
                'Monitoring interval must be between 1 and 60 seconds'
            );
        });

        it('should validate email configuration', () => {
            const result = validateConfig({
                ...validConfig,
                notifications: {
                    ...validConfig.notifications,
                    email: {
                        ...validConfig.notifications.email,
                        sender: 'invalid-email'
                    }
                }
            });
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Valid sender email is required');
        });
    });

    describe('Email Validation', () => {
        it('should validate correct email addresses', () => {
            expect(isValidEmail('user@example.com')).toBe(true);
            expect(isValidEmail('user.name+tag@example.co.uk')).toBe(true);
        });

        it('should reject invalid email addresses', () => {
            expect(isValidEmail('invalid-email')).toBe(false);
            expect(isValidEmail('@example.com')).toBe(false);
            expect(isValidEmail('user@')).toBe(false);
        });
    });

    describe('URL Validation', () => {
        it('should validate correct URLs', () => {
            expect(isValidUrl('https://example.com')).toBe(true);
            expect(isValidUrl('http://localhost:3000')).toBe(true);
        });

        it('should reject invalid URLs', () => {
            expect(isValidUrl('not-a-url')).toBe(false);
            expect(isValidUrl('http://')).toBe(false);
        });
    });
});
