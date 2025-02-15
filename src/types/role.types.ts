import { IsString, IsUUID, IsArray, IsOptional, MinLength, MaxLength, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Permission } from '../auth/entities/Permission.entity';

export enum RoleType {
    SUPER_ADMIN = 'SUPER_ADMIN',
    ADMIN = 'ADMIN',
    TRADER = 'TRADER',
    ANALYST = 'ANALYST',
    VIEWER = 'VIEWER',
    USER = 'USER'
}

export enum PermissionCategory {
    USER_MANAGEMENT = 'USER_MANAGEMENT',
    ROLE_MANAGEMENT = 'ROLE_MANAGEMENT',
    TRADING = 'TRADING',
    ANALYTICS = 'ANALYTICS',
    SYSTEM = 'SYSTEM',
    SETTINGS = 'SETTINGS'
}

export class CreateRoleDto {
    @ApiProperty()
    @IsString()
    @MinLength(3)
    @MaxLength(50)
    name: string;

    @ApiProperty()
    @IsString()
    @MinLength(10)
    @MaxLength(500)
    description: string;

    @ApiProperty({ type: [String] })
    @IsArray()
    @IsString({ each: true })
    permissions: string[];

    @ApiPropertyOptional({ enum: RoleType })
    @IsEnum(RoleType)
    @IsOptional()
    type?: RoleType;
}

export class UpdateRoleDto {
    @ApiPropertyOptional()
    @IsString()
    @MinLength(3)
    @MaxLength(50)
    @IsOptional()
    name?: string;

    @ApiPropertyOptional()
    @IsString()
    @MinLength(10)
    @MaxLength(500)
    @IsOptional()
    description?: string;

    @ApiPropertyOptional({ type: [String] })
    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    permissions?: string[];

    @ApiPropertyOptional()
    @IsOptional()
    @IsEnum(RoleType)
    type?: RoleType;
}

export interface RoleResponse {
    id: string;
    name: string;
    description: string;
    type: RoleType;
    permissions: Permission[];
    createdAt: Date;
    updatedAt: Date;
}

export interface RoleWithUsers extends RoleResponse {
    userCount: number;
}

export interface RoleMetrics {
    totalRoles: number;
    rolesPerType: Record<RoleType, number>;
    mostUsedPermissions: Array<{
        permission: string;
        count: number;
    }>;
    averagePermissionsPerRole: number;
}

export interface RoleAuditLog {
    id: string;
    roleId: string;
    actionType: RoleAuditActionType;
    changes: Record<string, any>;
    performedBy: string;
    timestamp: Date;
    ipAddress: string;
}

export enum RoleAuditActionType {
    ROLE_CREATED = 'ROLE_CREATED',
    ROLE_UPDATED = 'ROLE_UPDATED',
    ROLE_DELETED = 'ROLE_DELETED',
    PERMISSIONS_UPDATED = 'PERMISSIONS_UPDATED'
}

export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    message: string;
    error?: string;
    timestamp: string;
}

export const DEFAULT_ROLE_PERMISSIONS: Record<RoleType, string[]> = {
    [RoleType.SUPER_ADMIN]: [
        'MANAGE_USERS',
        'MANAGE_ROLES',
        'MANAGE_PERMISSIONS',
        'VIEW_DASHBOARD',
        'MANAGE_BOT',
        'VIEW_ANALYTICS',
        'MANAGE_STRATEGIES',
        'MANAGE_RISK',
        'VIEW_LOGS',
        'MANAGE_SYSTEM'
    ],
    [RoleType.ADMIN]: [
        'MANAGE_USERS',
        'VIEW_DASHBOARD',
        'MANAGE_BOT',
        'VIEW_ANALYTICS',
        'MANAGE_STRATEGIES',
        'MANAGE_RISK',
        'VIEW_LOGS'
    ],
    [RoleType.TRADER]: [
        'VIEW_DASHBOARD',
        'MANAGE_BOT',
        'VIEW_ANALYTICS',
        'MANAGE_STRATEGIES',
        'VIEW_LOGS'
    ],
    [RoleType.ANALYST]: [
        'VIEW_DASHBOARD',
        'VIEW_ANALYTICS',
        'VIEW_LOGS'
    ],
    [RoleType.VIEWER]: [
        'VIEW_DASHBOARD',
        'VIEW_ANALYTICS'
    ],
    [RoleType.USER]: [
        'VIEW_DASHBOARD'
    ]
};
