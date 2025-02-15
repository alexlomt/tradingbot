import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { RedisService } from '../cache/RedisService';
import { UserService } from '../user/UserService';
import { WebSocketService } from '../websocket/WebSocketService';
import { MailerService } from '@nestjs-modules/mailer';
import { Twilio } from 'twilio';
import { 
    NotificationTemplate, 
    NotificationPriority,
    NotificationChannel,
    NotificationType 
} from '../../types/notification.types';
import * as Telegram from 'node-telegram-bot-api';
import { PushNotificationService } from './PushNotificationService';

@Injectable()
export class NotificationService implements OnModuleInit {
    private readonly logger = new Logger(NotificationService.name);
    private readonly twilioClient: Twilio;
    private readonly telegramBot: Telegram;
    private readonly rateLimits: Map<string, number> = new Map();

    constructor(
        private readonly configService: ConfigService,
        private readonly redisService: RedisService,
        private readonly userService: UserService,
        private readonly wsService: WebSocketService,
        private readonly mailerService: MailerService,
        private readonly pushNotificationService: PushNotificationService,
        @InjectQueue('notifications') private notificationQueue: Queue
    ) {
        this.twilioClient = new Twilio(
            this.configService.get('TWILIO_ACCOUNT_SID')!,
            this.configService.get('TWILIO_AUTH_TOKEN')!
        );

        this.telegramBot = new Telegram(
            this.configService.get('TELEGRAM_BOT_TOKEN')!,
            { polling: false }
        );
    }

    async onModuleInit() {
        await this.initializeTemplates();
        this.startRateLimitCleaner();
    }

    async sendTradeNotification(
        userId: string,
        tradeData: any,
        priority: NotificationPriority = NotificationPriority.HIGH
    ) {
        const user = await this.userService.getUserWithPreferences(userId);
        if (!user) return;

        const notification = {
            type: NotificationType.TRADE,
            userId,
            priority,
            data: {
                tradeId: tradeData.id,
                status: tradeData.status,
                amount: tradeData.amount,
                pair: tradeData.pair,
                price: tradeData.price,
                timestamp: new Date()
            },
            channels: user.notificationPreferences.tradeNotifications || ['ws']
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

        const notification = {
            type: NotificationType.PRICE_ALERT,
            userId,
            priority,
            data: {
                pair: alertData.pair,
                currentPrice: alertData.currentPrice,
                targetPrice: alertData.targetPrice,
                condition: alertData.condition,
                timestamp: new Date()
            },
            channels: user.notificationPreferences.priceAlerts || ['email', 'ws']
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

        const notification = {
            type: NotificationType.SECURITY,
            userId,
            priority,
            data: {
                type: alertData.type,
                location: alertData.location,
                ip: alertData.ip,
                timestamp: new Date()
            },
            channels: ['email', 'sms', 'ws'] // Security alerts always use all channels
        };

        await this.queueNotification(notification);
    }

    private async queueNotification(notification: any) {
        if (!this.checkRateLimit(notification.userId, notification.type)) {
            this.logger.warn(`Rate limit exceeded for user ${notification.userId}`);
            return;
        }

        const jobOptions = {
            priority: this.getPriorityLevel(notification.priority),
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 1000
            },
            removeOnComplete: true
        };

        await this.notificationQueue.add('send-notification', notification, jobOptions);
        await this.updateRateLimit(notification.userId, notification.type);
    }

    private async sendNotificationToChannels(notification: any) {
        const promises = notification.channels.map(channel => 
            this.sendToChannel(channel, notification)
        );

        try {
            await Promise.all(promises);
            await this.logNotificationSuccess(notification);
        } catch (error) {
            await this.logNotificationError(notification, error);
            throw error;
        }
    }

    private async sendToChannel(channel: NotificationChannel, notification: any) {
        switch (channel) {
            case NotificationChannel.EMAIL:
                return this.sendEmail(notification);
            case NotificationChannel.SMS:
                return this.sendSMS(notification);
            case NotificationChannel.WEBSOCKET:
                return this.sendWebSocketNotification(notification);
            case NotificationChannel.PUSH:
                return this.sendPushNotification(notification);
            case NotificationChannel.TELEGRAM:
                return this.sendTelegramMessage(notification);
        }
    }

    private async sendEmail(notification: any) {
        const template = await this.getTemplate(
            notification.type,
            NotificationChannel.EMAIL
        );

        const compiledTemplate = this.compileTemplate(template, notification.data);

        await this.mailerService.sendMail({
            to: notification.data.email,
            subject: compiledTemplate.subject,
            html: compiledTemplate.body
        });
    }

    private async sendSMS(notification: any) {
        const template = await this.getTemplate(
            notification.type,
            NotificationChannel.SMS
        );

        const message = this.compileTemplate(template, notification.data);

        await this.twilioClient.messages.create({
            body: message.body,
            to: notification.data.phoneNumber,
            from: this.configService.get('TWILIO_PHONE_NUMBER')
        });
    }

    private async sendWebSocketNotification(notification: any) {
        await this.wsService.sendToUser(
            notification.userId,
            'notification',
            notification.data
        );
    }

    private async sendPushNotification(notification: any) {
        const userDevices = await this.userService.getUserDevices(notification.userId);
        
        for (const device of userDevices) {
            await this.pushNotificationService.sendToDevice(
                device.token,
                notification.data
            );
        }
    }

    private async sendTelegramMessage(notification: any) {
        const userTelegram = await this.userService.getUserTelegramInfo(
            notification.userId
        );
        
        if (userTelegram?.chatId) {
            await this.telegramBot.sendMessage(
                userTelegram.chatId,
                notification.data.message,
                { parse_mode: 'HTML' }
            );
        }
    }

    private async checkRateLimit(userId: string, type: NotificationType): Promise<boolean> {
        const key = `ratelimit:${userId}:${type}`;
        const count = await this.redisService.incr(key);
        
        if (count === 1) {
            await this.redisService.expire(key, 60); // 1 minute window
        }

        return count <= this.getRateLimit(type);
    }

    private getRateLimit(type: NotificationType): number {
        const limits = {
            [NotificationType.TRADE]: 10,
            [NotificationType.PRICE_ALERT]: 20,
            [NotificationType.SECURITY]: 5
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

    private async logNotificationSuccess(notification: any) {
        await this.redisService.lpush(
            'notifications:success',
            JSON.stringify({
                ...notification,
                timestamp: new Date()
            })
        );
    }

    private async logNotificationError(notification: any, error: any) {
        await this.redisService.lpush(
            'notifications:errors',
            JSON.stringify({
                ...notification,
                error: error.message,
                timestamp: new Date()
            })
        );
    }
}
