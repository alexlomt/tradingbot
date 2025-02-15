import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { RedisService } from '../cache/RedisService';
import { UserService } from '../user/UserService';
import { WebSocketService } from '../websocket/WebSocketService';
import { MailerService } from '@nestjs-modules/mailer';
import { Twilio } from 'twilio';
import * as Telegram from 'node-telegram-bot-api';
import { PushNotificationService } from './PushNotificationService';
import { NotificationTemplateService } from './templates/NotificationTemplateService';
import { 
    NotificationType, 
    NotificationChannel, 
    NotificationPriority,
    NotificationData 
} from '../../types/notification.types';

@Injectable()
export class NotificationService implements OnModuleInit {
    private readonly logger = new Logger(NotificationService.name);
    private readonly twilioClient: Twilio;
    private readonly telegramBot: Telegram;
    private readonly rateLimits: Map<string, number> = new Map();
    private readonly maxRetries = 3;
    private readonly retryDelay = 1000;

    constructor(
        private readonly configService: ConfigService,
        private readonly redisService: RedisService,
        private readonly userService: UserService,
        private readonly wsService: WebSocketService,
        private readonly mailerService: MailerService,
        private readonly pushNotificationService: PushNotificationService,
        private readonly templateService: NotificationTemplateService,
        @InjectQueue('notifications') private notificationQueue: Queue
    ) {
        this.twilioClient = new Twilio(
            this.configService.get('TWILIO_ACCOUNT_SID'),
            this.configService.get('TWILIO_AUTH_TOKEN')
        );

        this.telegramBot = new Telegram(
            this.configService.get('TELEGRAM_BOT_TOKEN'),
            { polling: false }
        );
    }

    async onModuleInit() {
        await this.initializeRateLimits();
        this.startRateLimitCleaner();
    }

    async sendTradeNotification(
        userId: string,
        tradeData: any,
        priority: NotificationPriority = NotificationPriority.HIGH
    ) {
        const user = await this.userService.getUserWithPreferences(userId);
        if (!user) return;

        const notification: NotificationData = {
            userId,
            type: NotificationType.TRADE_EXECUTED,
            priority,
            channels: user.notificationPreferences.tradeNotifications || ['ws'],
            data: {
                userName: user.name,
                tradeId: tradeData.id,
                tradeType: tradeData.type,
                pair: tradeData.pair,
                amount: tradeData.amount,
                price: tradeData.price,
                total: tradeData.total,
                fee: tradeData.fee,
                executionTime: tradeData.executionTime,
                performance24h: tradeData.performance24h,
                totalPnL: tradeData.totalPnL
            }
        };

        await this.queueNotification(notification);
    }

    async sendPriceAlert(
        userId: string,
        alertData: any,
        priority: NotificationPriority = NotificationPriority.MEDIUM
    ) {
        const user = await this.userService.getUserWithPreferences(userId);
        if (!user) return;

        const notification: NotificationData = {
            userId,
            type: NotificationType.PRICE_ALERT,
            priority,
            channels: user.notificationPreferences.priceAlerts || ['email', 'ws'],
            data: {
                userName: user.name,
                pair: alertData.pair,
                currentPrice: alertData.currentPrice,
                targetPrice: alertData.targetPrice,
                condition: alertData.condition,
                timestamp: new Date(),
                alertId: alertData.id
            }
        };

        await this.queueNotification(notification);
    }

    async sendSecurityAlert(
        userId: string,
        alertData: any,
        priority: NotificationPriority = NotificationPriority.CRITICAL
    ) {
        const user = await this.userService.getUserWithPreferences(userId);
        if (!user) return;

        const notification: NotificationData = {
            userId,
            type: NotificationType.SECURITY_ALERT,
            priority,
            channels: ['email', 'sms', 'ws'],
            data: {
                userName: user.name,
                type: alertData.type,
                location: alertData.location,
                ip: alertData.ip,
                deviceInfo: alertData.deviceInfo,
                timestamp: new Date(),
                actionRequired: alertData.actionRequired
            }
        };

        await this.queueNotification(notification);
    }

    async sendSystemAlert(
        alertData: any,
        priority: NotificationPriority = NotificationPriority.HIGH
    ) {
        const admins = await this.userService.getAdminUsers();

        for (const admin of admins) {
            const notification: NotificationData = {
                userId: admin.id,
                type: NotificationType.SYSTEM_ALERT,
                priority,
                channels: ['email', 'telegram'],
                data: {
                    userName: admin.name,
                    component: alertData.component,
                    error: alertData.error,
                    metrics: alertData.metrics,
                    timestamp: new Date(),
                    systemId: alertData.systemId
                }
            };

            await this.queueNotification(notification);
        }
    }

    private async queueNotification(notification: NotificationData) {
        if (!await this.checkRateLimit(notification.userId, notification.type)) {
            this.logger.warn(`Rate limit exceeded for user ${notification.userId}`);
            return;
        }

        const jobOptions = {
            priority: this.getPriorityLevel(notification.priority),
            attempts: this.maxRetries,
            backoff: {
                type: 'exponential',
                delay: this.retryDelay
            },
            removeOnComplete: true,
            timeout: 30000
        };

        await this.notificationQueue.add('send-notification', notification, jobOptions);
        await this.updateRateLimit(notification.userId, notification.type);
    }

    private async sendEmail(notification: NotificationData) {
        const template = await this.templateService.renderTemplate(
            notification.type,
            NotificationChannel.EMAIL,
            notification.data
        );

        await this.mailerService.sendMail({
            to: notification.data.email,
            subject: this.getEmailSubject(notification),
            html: template
        });
    }

    private async sendSMS(notification: NotificationData) {
        const template = await this.templateService.renderTemplate(
            notification.type,
            NotificationChannel.SMS,
            notification.data
        );

        await this.twilioClient.messages.create({
            body: template,
            to: notification.data.phoneNumber,
            from: this.configService.get('TWILIO_PHONE_NUMBER')
        });
    }

    private async sendTelegramMessage(notification: NotificationData) {
        const template = await this.templateService.renderTemplate(
            notification.type,
            NotificationChannel.TELEGRAM,
            notification.data
        );

        const userTelegram = await this.userService.getUserTelegramInfo(
            notification.userId
        );

        if (userTelegram?.chatId) {
            await this.telegramBot.sendMessage(
                userTelegram.chatId,
                template,
                { parse_mode: 'HTML' }
            );
        }
    }

    private async sendPushNotification(notification: NotificationData) {
        const devices = await this.userService.getUserDevices(notification.userId);

        const template = await this.templateService.renderTemplate(
            notification.type,
            NotificationChannel.PUSH,
            notification.data
        );

        for (const device of devices) {
            await this.pushNotificationService.sendToDevice(
                device.token,
                {
                    title: this.getPushTitle(notification),
                    body: template,
                    data: notification.data
                }
            );
        }
    }

    private async sendWebSocketNotification(notification: NotificationData) {
        await this.wsService.sendToUser(
            notification.userId,
            'notification',
            {
                type: notification.type,
                data: notification.data,
                timestamp: new Date()
            }
        );
    }

    private async checkRateLimit(userId: string, type: NotificationType): Promise<boolean> {
        const key = `ratelimit:${userId}:${type}`;
        const count = await this.redisService.incr(key);
        
        if (count === 1) {
            await this.redisService.expire(key, 60);
        }

        return count <= this.getRateLimit(type);
    }

    private getRateLimit(type: NotificationType): number {
        const limits = {
            [NotificationType.TRADE_EXECUTED]: 10,
            [NotificationType.PRICE_ALERT]: 20,
            [NotificationType.SECURITY_ALERT]: 5,
            [NotificationType.SYSTEM_ALERT]: 30,
            [NotificationType.SUBSCRIPTION]: 10
        };

        return limits[type] || 10;
    }

    private getPriorityLevel(priority: NotificationPriority): number {
        const levels = {
            [NotificationPriority.LOW]: 3,
            [NotificationPriority.MEDIUM]: 2,
            [NotificationPriority.HIGH]: 1,
            [NotificationPriority.CRITICAL]: 0
        };

        return levels[priority] || 2;
    }

    private getEmailSubject(notification: NotificationData): string {
        const subjects = {
            [NotificationType.TRADE_EXECUTED]: 'Trade Executed Successfully',
            [NotificationType.PRICE_ALERT]: 'Price Alert Triggered',
            [NotificationType.SECURITY_ALERT]: 'Security Alert - Action Required',
            [NotificationType.SYSTEM_ALERT]: 'System Alert',
            [NotificationType.SUBSCRIPTION]: 'Subscription Update'
        };

        return subjects[notification.type] || 'Notification from Trading Bot';
    }

    private getPushTitle(notification: NotificationData): string {
        const titles = {
            [NotificationType.TRADE_EXECUTED]: 'Trade Executed',
            [NotificationType.PRICE_ALERT]: 'Price Alert',
            [NotificationType.SECURITY_ALERT]: '🚨 Security Alert',
            [NotificationType.SYSTEM_ALERT]: 'System Alert',
            [NotificationType.SUBSCRIPTION]: 'Subscription Update'
        };

        return titles[notification.type] || 'Notification';
    }

    private async initializeRateLimits() {
        const limits = await this.redisService.keys('ratelimit:*');
        for (const key of limits) {
            const count = await this.redisService.get(key);
            this.rateLimits.set(key, parseInt(count, 10));
        }
    }

    private startRateLimitCleaner() {
        setInterval(async () => {
            const expiredKeys = [];
            for (const [key, count] of this.rateLimits.entries()) {
                const ttl = await this.redisService.ttl(key);
                if (ttl <= 0) {
                    expiredKeys.push(key);
                }
            }
            expiredKeys.forEach(key => this.rateLimits.delete(key));
        }, 60000);
    }
}
