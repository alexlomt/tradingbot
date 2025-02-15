export interface RegisterUserDto {
    email: string;
    password: string;
    username: string;
}

export interface LoginDto {
    email: string;
    password: string;
}

export interface JwtPayload {
    sub: string;
    email: string;
    role: string;
    iat?: number;
    exp?: number;
}

export interface AuthResponse {
    user: Partial<User>;
    token: string;
}

export interface UserSession {
    id: string;
    userId: string;
    token: string;
    ipAddress: string;
    userAgent: string;
    expiresAt: Date;
}

export enum PermissionScope {
    GLOBAL = 'GLOBAL',
    ORGANIZATION = 'ORGANIZATION',
    TEAM = 'TEAM'
}

export interface PermissionMetadata {
    scope: PermissionScope;
    resources?: string[];
    conditions?: Record<string, any>;
}

export type PermissionName =
    | 'MANAGE_USERS'
    | 'MANAGE_ROLES'
    | 'MANAGE_PERMISSIONS'
    | 'VIEW_DASHBOARD'
    | 'MANAGE_BOT'
    | 'VIEW_ANALYTICS'
    | 'MANAGE_STRATEGIES'
    | 'MANAGE_RISK'
    | 'VIEW_LOGS'
    | 'MANAGE_API_KEYS'
    | 'MANAGE_SYSTEM_CONFIG'
    | 'MANAGE_TEAMS';
