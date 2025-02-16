import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Alert } from '../../entities/Alert.entity';
import { MonitoringService } from './MonitoringService';
import { MetricsService } from '../metrics/MetricsService';
import { AuditService } from '../audit/AuditService';
import { WebSocketService } from '../websocket/WebSocketService';
import { Subject, interval } from 'rxjs';
import { Decimal } from 'decimal.js';

interface AlertRule {
    id: string;
    name: string;
    metric: string;
    condition: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
    threshold: Decimal;
    duration: number;
    severity: 'info' | 'warning' | 'critical';
    enabled: boolean;
    notificationChannels: string[];
}

interface AlertNotification {
    id: string;
    ruleId: string;
    metric: string;
    value: Decimal;
    threshold: Decimal;
    timestamp: Date;
    severity: string;
    message: string;
}

@Injectable()
export class AlertingService implements OnModuleInit {
    private readonly alertRules: Map<string, AlertRule> = new Map();
    private readonly activeAlerts: Map<string, Alert> = new Map();
    private readonly alertNotifications = new Subject<AlertNotification>();
    private readonly CHECK_INTERVAL = 10000; // 10 seconds
    private readonly NOTIFICATION_CHANNELS = ['email', 'slack', 'telegram'];

    constructor(
        @InjectRepository(Alert)
        private readonly alertRepository: Repository<Alert>,
        private readonly configService: ConfigService,
        private readonly monitoringService: MonitoringService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService,
        private readonly webSocketService: WebSocketService
    ) {}

    async onModuleInit() {
        await this.loadAlertRules();
        this.startAlertChecks();
        this.subscribeToSystemHealth();
    }

    private async loadAlertRules() {
        const rules = this.configService.get<AlertRule[]>('ALERT_RULES');
        rules.forEach(rule => {
            this.alertRules.set(rule.id, {
                ...rule,
                threshold: new Decimal(rule.threshold)
            });
        });
    }

    private startAlertChecks() {
        interval(this.CHECK_INTERVAL).subscribe(async () => {
            try {
                await this.checkAlertRules();
            } catch (error) {
                await this.handleError('alert_check', error);
            }
        });
    }

    private subscribeToSystemHealth() {
        this.monitoringService.getSystemHealth().subscribe(async (health) => {
            try {
                await this.processSystemHealth(health);
            } catch (error) {
                await this.handleError('health_processing', error);
            }
        });
    }

    private async processSystemHealth(health: any) {
        for (const [component, status] of Object.entries(health.components)) {
            const componentRules = Array.from(this.alertRules.values())
                .filter(rule => rule.metric.startsWith(`${component}.`));

            for (const rule of componentRules) {
                await this.evaluateRule(rule, status);
            }
        }
    }

    private async checkAlertRules() {
        const metrics = await this.metricsService.getCurrentMetrics();

        for (const rule of this.alertRules.values()) {
            if (!rule.enabled) continue;

            const metricValue = new Decimal(metrics[rule.metric] || 0);
            await this.evaluateRule(rule, metricValue);
        }
    }

    private async evaluateRule(
        rule: AlertRule,
        value: Decimal | any
    ) {
        const isTriggered = this.checkCondition(rule, value);
        const existingAlert = this.activeAlerts.get(rule.id);

        if (isTriggered && !existingAlert) {
            await this.createAlert(rule, value);
        } else if (!isTriggered && existingAlert) {
            await this.resolveAlert(existingAlert);
        }
    }

    private checkCondition(
        rule: AlertRule,
        value: Decimal | any
    ): boolean {
        const metricValue = value instanceof Decimal ? value : new Decimal(value);

        switch (rule.condition) {
            case 'gt':
                return metricValue.gt(rule.threshold);
            case 'lt':
                return metricValue.lt(rule.threshold);
            case 'eq':
                return metricValue.eq(rule.threshold);
            case 'gte':
                return metricValue.gte(rule.threshold);
            case 'lte':
                return metricValue.lte(rule.threshold);
            default:
                return false;
        }
    }

    private async createAlert(
        rule: AlertRule,
        value: Decimal | any
    ) {
        const alert = new Alert();
        alert.ruleId = rule.id;
        alert.name = rule.name;
        alert.metric = rule.metric;
        alert.condition = rule.condition;
        alert.threshold = rule.threshold;
        alert.value = value instanceof Decimal ? value : new Decimal(value);
        alert.timestamp = new Date();
        alert.severity = rule.severity;
        alert.status = 'active';

        const savedAlert = await this.alertRepository.save(alert);
        this.activeAlerts.set(rule.id, savedAlert);

        await this.notifyAlert(savedAlert);
    }

    private async resolveAlert(alert: Alert) {
        alert.resolvedAt = new Date();
        alert.status = 'resolved';
        await this.alertRepository.save(alert);
        this.activeAlerts.delete(alert.ruleId);

        await this.notifyResolution(alert);
    }

    private async notifyAlert(alert: Alert) {
        const rule = this.alertRules.get(alert.ruleId);
        
        const notification: AlertNotification = {
            id: alert.id,
            ruleId: alert.ruleId,
            metric: alert.metric,
            value: alert.value,
            threshold: alert.threshold,
            timestamp: alert.timestamp,
            severity: alert.severity,
            message: `Alert: ${alert.name} - ${alert.metric} ${alert.condition} ${alert.threshold}`
        };

        this.alertNotifications.next(notification);

        for (const channel of rule.notificationChannels) {
            await this.sendNotification(channel, notification);
        }

        await this.auditService.logSystemEvent({
            event: 'ALERT_TRIGGERED',
            details: notification,
            severity: alert.severity
        });
    }

    private async notifyResolution(alert: Alert) {
        const notification: AlertNotification = {
            id: alert.id,
            ruleId: alert.ruleId,
            metric: alert.metric,
            value: alert.value,
            threshold: alert.threshold,
            timestamp: new Date(),
            severity: 'info',
            message: `Resolved: ${alert.name} - ${alert.metric} returned to normal`
        };

        this.alertNotifications.next(notification);

        const rule = this.alertRules.get(alert.ruleId);
        for (const channel of rule.notificationChannels) {
            await this.sendNotification(channel, notification);
        }
    }

    private async sendNotification(
        channel: string,
        notification: AlertNotification
    ) {
        try {
            switch (channel) {
                case 'email':
                    await this.sendEmailNotification(notification);
                    break;
                case 'slack':
                    await this.sendSlackNotification(notification);
                    break;
                case 'telegram':
                    await this.sendTelegramNotification(notification);
                    break;
            }
        } catch (error) {
            await this.handleError('notification_send', error);
        }
    }

    async addAlertRule(rule: Omit<AlertRule, 'id'>): Promise<string> {
        const id = `rule_${Date.now()}`;
        const newRule: AlertRule = {
            ...rule,
            id,
            threshold: new Decimal(rule.threshold)
        };

        this.alertRules.set(id, newRule);
        await this.auditService.logSystemEvent({
            event: 'ALERT_RULE_ADDED',
            details: { rule: newRule },
            severity: 'INFO'
        });

        return id;
    }

    async updateAlertRule(
        id: string,
        updates: Partial<AlertRule>
    ): Promise<boolean> {
        const rule = this.alertRules.get(id);
        if (!rule) return false;

        const updatedRule = {
            ...rule,
            ...updates,
            threshold: updates.threshold ? 
                new Decimal(updates.threshold) : 
                rule.threshold
        };

        this.alertRules.set(id, updatedRule);
        return true;
    }

    async deleteAlertRule(id: string): Promise<boolean> {
        const deleted = this.alertRules.delete(id);
        if (deleted) {
            const activeAlert = this.activeAlerts.get(id);
            if (activeAlert) {
                await this.resolveAlert(activeAlert);
            }
        }
        return deleted;
    }

    getActiveAlerts(): Alert[] {
        return Array.from(this.activeAlerts.values());
    }

    getAlertRules(): AlertRule[] {
        return Array.from(this.alertRules.values());
    }

    subscribeToAlerts(): Subject<AlertNotification> {
        return this.alertNotifications;
    }

    private async handleError(
        operation: string,
        error: Error
    ): Promise<void> {
        await this.auditService.logSystemEvent({
            event: 'ALERTING_ERROR',
            details: {
                operation,
                error: error.message
            },
            severity: 'ERROR'
        });

        await this.metricsService.incrementError('alerting');
    }
}
