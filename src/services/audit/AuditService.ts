import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../../entities/AuditLog.entity';
import { ConfigService } from '@nestjs/config';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import { MetricsService } from '../metrics/MetricsService';
import { NotificationService } from '../notification/NotificationService';

@Injectable()
export class AuditService {
    private readonly RETENTION_DAYS: number;
    private readonly HIGH_RISK_ACTIONS = [
        'USER_DELETED',
        'ROLE_DELETED',
        'PERMISSIONS_UPDATED',
        'SYSTEM_CONFIG_CHANGED',
        'TRADING_STRATEGY_MODIFIED',
        'RISK_PARAMETERS_CHANGED'
    ];

    constructor(
        @InjectRepository(AuditLog)
        private readonly auditLogRepository: Repository<AuditLog>,
        private readonly configService: ConfigService,
        private readonly elasticsearchService: ElasticsearchService,
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService
    ) {
        this.RETENTION_DAYS = this.configService.get<number>('AUDIT_LOG_RETENTION_DAYS', 365);
    }

    async logUserAction(params: {
        userId: string;
        action: string;
        details: Record<string, any>;
        ipAddress: string;
        userAgent: string;
        resourceId?: string;
        status: 'SUCCESS' | 'FAILURE';
        errorDetails?: string;
    }): Promise<void> {
        const auditLog = this.auditLogRepository.create({
            userId: params.userId,
            action: params.action,
            details: params.details,
            ipAddress: params.ipAddress,
            userAgent: params.userAgent,
            resourceId: params.resourceId,
            status: params.status,
            errorDetails: params.errorDetails,
            timestamp: new Date()
        });

        await Promise.all([
            // Store in database
            this.auditLogRepository.save(auditLog),
            
            // Index in Elasticsearch for advanced searching
            this.elasticsearchService.index({
                index: 'audit-logs',
                body: {
                    ...auditLog,
                    timestamp: new Date().toISOString()
                }
            }),

            // Update metrics
            this.metricsService.incrementAuditMetric(params.action, params.status)
        ]);

        // Check if this is a high-risk action
        if (this.HIGH_RISK_ACTIONS.includes(params.action)) {
            await this.notificationService.sendAdminNotification({
                type: 'HIGH_RISK_ACTION',
                data: {
                    action: params.action,
                    userId: params.userId,
                    details: params.details,
                    timestamp: new Date()
                }
            });
        }
    }

    async logUserCreation(user: any, createdBy: string): Promise<void> {
        await this.logUserAction({
            userId: createdBy,
            action: 'USER_CREATED',
            details: {
                createdUserId: user.id,
                email: user.email,
                role: user.role.name
            },
            ipAddress: 'system',
            userAgent: 'system',
            resourceId: user.id,
            status: 'SUCCESS'
        });
    }

    async logUserUpdate(user: any, updatedBy: string, changes: Record<string, any>): Promise<void> {
        await this.logUserAction({
            userId: updatedBy,
            action: 'USER_UPDATED',
            details: {
                updatedUserId: user.id,
                changes
            },
            ipAddress: 'system',
            userAgent: 'system',
            resourceId: user.id,
            status: 'SUCCESS'
        });
    }

    async logRoleCreation(role: any, createdBy: string): Promise<void> {
        await this.logUserAction({
            userId: createdBy,
            action: 'ROLE_CREATED',
            details: {
                roleId: role.id,
                name: role.name,
                permissions: role.permissions.map(p => p.name)
            },
            ipAddress: 'system',
            userAgent: 'system',
            resourceId: role.id,
            status: 'SUCCESS'
        });
    }

    async logRoleUpdate(role: any, updatedBy: string, changes: Record<string, any>): Promise<void> {
        await this.logUserAction({
            userId: updatedBy,
            action: 'ROLE_UPDATED',
            details: {
                roleId: role.id,
                changes
            },
            ipAddress: 'system',
            userAgent: 'system',
            resourceId: role.id,
            status: 'SUCCESS'
        });
    }

    async logTradingActivity(params: {
        userId: string;
        action: string;
        tradingPair: string;
        amount: number;
        price: number;
        type: 'BUY' | 'SELL';
        status: 'SUCCESS' | 'FAILURE';
        errorDetails?: string;
    }): Promise<void> {
        await this.logUserAction({
            userId: params.userId,
            action: 'TRADING_ACTIVITY',
            details: {
                tradingPair: params.tradingPair,
                amount: params.amount,
                price: params.price,
                type: params.type
            },
            ipAddress: 'system',
            userAgent: 'system',
            status: params.status,
            errorDetails: params.errorDetails
        });
    }

    async logSystemEvent(params: {
        event: string;
        details: Record<string, any>;
        severity: 'INFO' | 'WARNING' | 'ERROR';
    }): Promise<void> {
        await this.logUserAction({
            userId: 'system',
            action: 'SYSTEM_EVENT',
            details: {
                event: params.event,
                severity: params.severity,
                ...params.details
            },
            ipAddress: 'system',
            userAgent: 'system',
            status: 'SUCCESS'
        });
    }

    async getAuditLogs(params: {
        userId?: string;
        action?: string;
        startDate?: Date;
        endDate?: Date;
        page?: number;
        limit?: number;
    }): Promise<{
        logs: AuditLog[];
        total: number;
    }> {
        const query = this.auditLogRepository.createQueryBuilder('audit_log');

        if (params.userId) {
            query.andWhere('audit_log.userId = :userId', { userId: params.userId });
        }

        if (params.action) {
            query.andWhere('audit_log.action = :action', { action: params.action });
        }

        if (params.startDate) {
            query.andWhere('audit_log.timestamp >= :startDate', { startDate: params.startDate });
        }

        if (params.endDate) {
            query.andWhere('audit_log.timestamp <= :endDate', { endDate: params.endDate });
        }

        const [logs, total] = await query
            .orderBy('audit_log.timestamp', 'DESC')
            .skip((params.page || 0) * (params.limit || 10))
            .take(params.limit || 10)
            .getManyAndCount();

        return { logs, total };
    }

    async cleanupOldLogs(): Promise<void> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - this.RETENTION_DAYS);

        await Promise.all([
            // Clean up database
            this.auditLogRepository.createQueryBuilder()
                .delete()
                .where('timestamp < :cutoffDate', { cutoffDate })
                .execute(),

            // Clean up Elasticsearch
            this.elasticsearchService.deleteByQuery({
                index: 'audit-logs',
                body: {
                    query: {
                        range: {
                            timestamp: {
                                lt: cutoffDate.toISOString()
                            }
                        }
                    }
                }
            })
        ]);
    }
}
