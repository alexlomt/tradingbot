export enum NotificationType {
    TRADE_EXECUTED = 'TRADE_EXECUTED',
    PRICE_ALERT = 'PRICE_ALERT',
    MARGIN_CALL = 'MARGIN_CALL',
    SECURITY_ALERT = 'SECURITY_ALERT',
    SYSTEM_ALERT = 'SYSTEM_ALERT',
    SUBSCRIPTION = 'SUBSCRIPTION'
}

export enum NotificationChannel {
    EMAIL = 'EMAIL',
    SMS = 'SMS',
    TELEGRAM = 'TELEGRAM',
    PUSH = 'PUSH',
    WEBSOCKET = 'WEBSOCKET'
}

export enum NotificationPriority {
    LOW = 'LOW',
    MEDIUM = 'MEDIUM',
    HIGH = 'HIGH',
    CRITICAL = 'CRITICAL'
}

export interface NotificationTemplate {
    id: string;
    type: NotificationType;
    channel: NotificationChannel;
    subject?: string;
    content: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface NotificationData {
    userId: string;
    type: NotificationType;
    priority: NotificationPriority;
    channels: NotificationChannel[];
    data: Record<string, any>;
    metadata?: Record<string, any>;
}
