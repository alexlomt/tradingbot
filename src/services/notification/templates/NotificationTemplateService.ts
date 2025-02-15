import { Injectable, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../cache/RedisService';
import { ConfigService } from '@nestjs/config';
import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NotificationType, NotificationChannel } from '../../../types/notification.types';

@Injectable()
export class NotificationTemplateService implements OnModuleInit {
    private templates: Map<string, Handlebars.TemplateDelegate> = new Map();
    private readonly cachePrefix = 'template:';
    private readonly cacheTTL = 3600; // 1 hour

    constructor(
        private readonly redisService: RedisService,
        private readonly configService: ConfigService
    ) {
        // Register custom Handlebars helpers
        Handlebars.registerHelper('formatCurrency', (value: number) => {
            return new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: 'USD'
            }).format(value);
        });

        Handlebars.registerHelper('formatDate', (date: Date) => {
            return new Intl.DateTimeFormat('en-US', {
                dateStyle: 'medium',
                timeStyle: 'medium'
            }).format(new Date(date));
        });

        Handlebars.registerHelper('formatPercent', (value: number) => {
            return `${(value * 100).toFixed(2)}%`;
        });
    }

    async onModuleInit() {
        await this.loadTemplates();
    }

    private async loadTemplates() {
        const templateTypes = Object.values(NotificationType);
        const channels = Object.values(NotificationChannel);

        for (const type of templateTypes) {
            for (const channel of channels) {
                const templateKey = this.getTemplateKey(type, channel);
                const cachedTemplate = await this.redisService.get(
                    this.cachePrefix + templateKey
                );

                if (cachedTemplate) {
                    this.templates.set(
                        templateKey,
                        Handlebars.compile(cachedTemplate)
                    );
                } else {
                    await this.loadAndCacheTemplate(type, channel);
                }
            }
        }
    }

    private async loadAndCacheTemplate(
        type: NotificationType,
        channel: NotificationChannel
    ) {
        try {
            const templatePath = join(
                __dirname,
                'files',
                channel.toLowerCase(),
                `${type.toLowerCase()}.hbs`
            );

            const templateContent = readFileSync(templatePath, 'utf-8');
            const compiledTemplate = Handlebars.compile(templateContent);

            const templateKey = this.getTemplateKey(type, channel);
            this.templates.set(templateKey, compiledTemplate);

            // Cache template
            await this.redisService.set(
                this.cachePrefix + templateKey,
                templateContent,
                'EX',
                this.cacheTTL
            );
        } catch (error) {
            console.error(
                `Failed to load template for ${type} - ${channel}:`,
                error
            );
            throw error;
        }
    }

    async renderTemplate(
        type: NotificationType,
        channel: NotificationChannel,
        data: any
    ): Promise<string> {
        const templateKey = this.getTemplateKey(type, channel);
        const template = this.templates.get(templateKey);

        if (!template) {
            throw new Error(`Template not found: ${templateKey}`);
        }

        try {
            return template(this.enrichTemplateData(data));
        } catch (error) {
            console.error(`Template rendering error for ${templateKey}:`, error);
            throw error;
        }
    }

    private enrichTemplateData(data: any) {
        return {
            ...data,
            appName: this.configService.get('APP_NAME'),
            supportEmail: this.configService.get('SUPPORT_EMAIL'),
            year: new Date().getFullYear(),
            baseUrl: this.configService.get('APP_URL')
        };
    }

    private getTemplateKey(type: NotificationType, channel: NotificationChannel): string {
        return `${type}_${channel}`;
    }
}
