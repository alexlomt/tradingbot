import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { User } from '../auth/entities/User.entity';

export enum AuditActionType {
    // User Actions
    USER_CREATED = 'USER_CREATED',
    USER_UPDATED = 'USER_UPDATED',
    USER_DELETED = 'USER_DELETED',
    USER_LOGIN = 'USER_LOGIN',
    USER_LOGOUT = 'USER_LOGOUT',
    USER_LOGIN_FAILED = 'USER_LOGIN_FAILED',
    PASSWORD_CHANGED = 'PASSWORD_CHANGED',
    TWO_FACTOR_ENABLED = 'TWO_FACTOR_ENABLED',
    TWO_FACTOR_DISABLED = 'TWO_FACTOR_DISABLED',

    // Role Actions
    ROLE_CREATED = 'ROLE_CREATED',
    ROLE_UPDATED = 'ROLE_UPDATED',
    ROLE_DELETED = 'ROLE_DELETED',
    PERMISSIONS_UPDATED = 'PERMISSIONS_UPDATED',

    // Trading Actions
    ORDER_CREATED = 'ORDER_CREATED',
    ORDER_UPDATED = 'ORDER_UPDATED',
    ORDER_CANCELLED = 'ORDER_CANCELLED',
    TRADE_EXECUTED = 'TRADE_EXECUTED',
    STRATEGY_CREATED = 'STRATEGY_CREATED',
    STRATEGY_UPDATED = 'STRATEGY_UPDATED',
    STRATEGY_DELETED = 'STRATEGY_DELETED',
    STRATEGY_ENABLED = 'STRATEGY_ENABLED',
    STRATEGY_DISABLED = 'STRATEGY_DISABLED',

    // System Actions
    SYSTEM_CONFIG_UPDATED = 'SYSTEM_CONFIG_UPDATED',
    SYSTEM_ERROR = 'SYSTEM_ERROR',
    SYSTEM_WARNING = 'SYSTEM_WARNING',
    CACHE_CLEARED = 'CACHE_CLEARED',
    METRICS_RESET = 'METRICS_RESET',

    // Risk Management
    RISK_LIMIT_UPDATED = 'RISK_LIMIT_UPDATED',
    RISK_ALERT_TRIGGERED = 'RISK_ALERT_TRIGGERED',
    POSITION_LIMIT_REACHED = 'POSITION_LIMIT_REACHED',
    AUTO_HEDGE_TRIGGERED = 'AUTO_HEDGE_TRIGGERED',

    // Security Events
    SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY',
    API_KEY_CREATED = 'API_KEY_CREATED',
    API_KEY_UPDATED = 'API_KEY_UPDATED',
    API_KEY_DELETED = 'API_KEY_DELETED',
    IP_BLOCKED = 'IP_BLOCKED'
}

export enum AuditSeverity {
    INFO = 'INFO',
    WARNING = 'WARNING',
    ERROR = 'ERROR',
    CRITICAL = 'CRITICAL'
}

export enum ResourceType {
    USER = 'USER',
    ROLE = 'ROLE',
    STRATEGY = 'STRATEGY',
    ORDER = 'ORDER',
    TRADE = 'TRADE',
    SYSTEM = 'SYSTEM',
    API_KEY = 'API_KEY',
    CONFIG = 'CONFIG'
}

@Entity('audit_logs')
@Index(['timestamp', 'actionType'])
@Index(['userId', 'timestamp'])
@Index(['resourceType', 'resourceId'])
export class AuditLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        type: 'enum',
        enum: AuditActionType
    })
    actionType: AuditActionType;

    @Column({
        type: 'enum',
        enum: AuditSeverity,
        default: AuditSeverity.INFO
    })
    severity: AuditSeverity;

    @Column({
        type: 'enum',
        enum: ResourceType,
        nullable: true
    })
    resourceType: ResourceType;

    @Column({ nullable: true })
    resourceId: string;

    @ManyToOne(() => User, { nullable: true })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ nullable: true })
    userId: string;

    @Column({ type: 'jsonb' })
    details: Record<string, any>;

    @Column({ nullable: true })
    ipAddress: string;

    @Column({ nullable: true })
    userAgent: string;

    @Column({ type: 'jsonb', nullable: true })
    metadata: Record<string, any>;

    @Column({ default: false })
    isArchived: boolean;

    @Column({ default: false })
    requiresAttention: boolean;

    @CreateDateColumn({ type: 'timestamp with time zone' })
    @Index()
    timestamp: Date;

    @UpdateDateColumn({ type: 'timestamp with time zone' })
    updatedAt: Date;

    @Column({ nullable: true })
    relatedAuditId: string;

    @Column({ type: 'text', array: true, default: '{}' })
    tags: string[];

    static create(params: {
        actionType: AuditActionType;
        userId?: string;
        resourceType?: ResourceType;
        resourceId?: string;
        details: Record<string, any>;
        severity?: AuditSeverity;
        ipAddress?: string;
        userAgent?: string;
        metadata?: Record<string, any>;
        tags?: string[];
        requiresAttention?: boolean;
        relatedAuditId?: string;
    }): AuditLog {
        const log = new AuditLog();
        Object.assign(log, {
            ...params,
            timestamp: new Date(),
            severity: params.severity || AuditSeverity.INFO,
            tags: params.tags || [],
            requiresAttention: params.requiresAttention || false
        });
        return log;
    }

    addTag(tag: string): void {
        if (!this.tags.includes(tag)) {
            this.tags.push(tag);
        }
    }

    markAsArchived(): void {
        this.isArchived = true;
        this.updatedAt = new Date();
    }

    updateSeverity(severity: AuditSeverity): void {
        this.severity = severity;
        this.updatedAt = new Date();
    }

    addMetadata(key: string, value: any): void {
        this.metadata = {
            ...this.metadata,
            [key]: value
        };
        this.updatedAt = new Date();
    }

    requireAttention(reason: string): void {
        this.requiresAttention = true;
        this.addMetadata('attentionReason', reason);
        this.updatedAt = new Date();
    }

    relate(auditId: string): void {
        this.relatedAuditId = auditId;
        this.updatedAt = new Date();
    }
}
