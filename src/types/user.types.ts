import { IsEmail, IsString, IsUUID, IsOptional, MinLength, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { Role } from '../auth/entities/Role.entity';

export class CreateUserDto {
    @ApiProperty()
    @IsEmail()
    email: string;

    @ApiProperty()
    @IsString()
    @MinLength(3)
    username: string;

    @ApiProperty()
    @IsString()
    @MinLength(8)
    password: string;

    @ApiProperty()
    @IsUUID()
    roleId: string;

    @ApiPropertyOptional()
    @IsBoolean()
    @IsOptional()
    isTwoFactorEnabled?: boolean;
}

export class UpdateUserDto {
    @ApiPropertyOptional()
    @IsEmail()
    @IsOptional()
    email?: string;

    @ApiPropertyOptional()
    @IsString()
    @MinLength(3)
    @IsOptional()
    username?: string;

    @ApiPropertyOptional()
    @IsString()
    @MinLength(8)
    @IsOptional()
    password?: string;

    @ApiPropertyOptional()
    @IsUUID()
    @IsOptional()
    roleId?: string;

    @ApiPropertyOptional()
    @IsBoolean()
    @IsOptional()
    isActive?: boolean;

    @ApiPropertyOptional()
    @IsBoolean()
    @IsOptional()
    isTwoFactorEnabled?: boolean;
}

export class UserFilters {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    @Type(() => Boolean)
    isActive?: boolean;

    @ApiPropertyOptional()
    @IsOptional()
    @IsUUID()
    roleId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    page?: number = 1;

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    limit?: number = 10;
}

export interface UserResponse {
    id: string;
    email: string;
    username: string;
    isActive: boolean;
    isTwoFactorEnabled: boolean;
    role: Role;
    lastLoginAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface UsersResponse {
    users: UserResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    message: string;
    error?: string;
    timestamp: string;
    path?: string;
}

export interface UserSession {
    id: string;
    userId: string;
    token: string;
    ipAddress: string;
    userAgent: string;
    lastActiveAt: Date;
    expiresAt: Date;
}

export interface UserMetrics {
    totalUsers: number;
    activeUsers: number;
    inactiveUsers: number;
    usersByRole: Record<string, number>;
    recentLogins: number;
    failedLogins: number;
}

export interface UserAuditLog {
    id: string;
    userId: string;
    actionType: UserAuditActionType;
    details: Record<string, any>;
    performedBy: string;
    timestamp: Date;
    ipAddress: string;
}

export enum UserAuditActionType {
    USER_CREATED = 'USER_CREATED',
    USER_UPDATED = 'USER_UPDATED',
    USER_DELETED = 'USER_DELETED',
    USER_ACTIVATED = 'USER_ACTIVATED',
    USER_DEACTIVATED = 'USER_DEACTIVATED',
    PASSWORD_CHANGED = 'PASSWORD_CHANGED',
    ROLE_CHANGED = 'ROLE_CHANGED',
    LOGIN_SUCCESS = 'LOGIN_SUCCESS',
    LOGIN_FAILED = 'LOGIN_FAILED',
    LOGOUT = 'LOGOUT',
    TWO_FACTOR_ENABLED = 'TWO_FACTOR_ENABLED',
    TWO_FACTOR_DISABLED = 'TWO_FACTOR_DISABLED'
}

export interface UserNotification {
    id: string;
    userId: string;
    type: UserNotificationType;
    title: string;
    message: string;
    isRead: boolean;
    createdAt: Date;
}

export enum UserNotificationType {
    ACCOUNT_UPDATE = 'ACCOUNT_UPDATE',
    SECURITY_ALERT = 'SECURITY_ALERT',
    SYSTEM_NOTIFICATION = 'SYSTEM_NOTIFICATION',
    ROLE_CHANGE = 'ROLE_CHANGE',
    PASSWORD_EXPIRY = 'PASSWORD_EXPIRY'
}

export interface UserLoginAttempt {
    id: string;
    userId: string;
    timestamp: Date;
    ipAddress: string;
    userAgent: string;
    success: boolean;
    failureReason?: string;
}

export interface UserPreferences {
    id: string;
    userId: string;
    theme: 'light' | 'dark';
    language: string;
    timezone: string;
    notifications: {
        email: boolean;
        push: boolean;
        security: boolean;
        updates: boolean;
    };
    dashboardLayout: Record<string, any>;
}

export interface TwoFactorAuthSecret {
    secret: string;
    otpAuthUrl: string;
    qrCodeDataUrl: string;
}

export interface PasswordPolicy {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumbers: boolean;
    requireSpecialChars: boolean;
    expiryDays: number;
    preventReuse: number;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: true,
    expiryDays: 90,
    preventReuse: 5
};
