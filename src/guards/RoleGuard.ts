import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { UserService } from '../services/UserService';
import { RoleService } from '../services/RoleService';
import { AuditService } from '../services/audit/AuditService';
import { User } from '../auth/entities/User.entity';
import { RoleType } from '../types/role.types';
import { CacheService } from '../services/cache/CacheService';

@Injectable()
export class RoleGuard implements CanActivate {
    private readonly CACHE_TTL = 300; // 5 minutes
    private readonly SUPER_ADMIN_EMAIL = 'alexlomt@yahoo.com';

    constructor(
        private readonly reflector: Reflector,
        private readonly jwtService: JwtService,
        private readonly userService: UserService,
        private readonly roleService: RoleService,
        private readonly configService: ConfigService,
        private readonly auditService: AuditService,
        private readonly cacheService: CacheService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        try {
            const requiredPermissions = this.reflector.get<string[]>(
                'permissions',
                context.getHandler()
            ) || [];

            const request = context.switchToHttp().getRequest();
            const token = this.extractToken(request);

            if (!token) {
                throw new UnauthorizedException('No token provided');
            }

            const user = await this.validateUser(token);
            request.user = user;

            // Super admin check
            if (user.email === this.SUPER_ADMIN_EMAIL) {
                return true;
            }

            // Cache key for user permissions
            const cacheKey = `permissions:${user.id}`;
            let userPermissions = await this.cacheService.get(cacheKey);

            if (!userPermissions) {
                const role = await this.roleService.getRoleById(user.role.id);
                userPermissions = role.permissions.map(p => p.name);
                await this.cacheService.set(
                    cacheKey,
                    JSON.stringify(userPermissions),
                    this.CACHE_TTL
                );
            } else {
                userPermissions = JSON.parse(userPermissions);
            }

            // If no specific permissions required, just need to be authenticated
            if (requiredPermissions.length === 0) {
                return true;
            }

            const hasPermission = requiredPermissions.every(permission =>
                userPermissions.includes(permission)
            );

            if (!hasPermission) {
                await this.auditService.logAccessDenied(
                    user.id,
                    requiredPermissions,
                    request.path
                );
                throw new ForbiddenException('Insufficient permissions');
            }

            // Log successful access
            await this.auditService.logAccess(
                user.id,
                requiredPermissions,
                request.path
            );

            return true;
        } catch (error) {
            if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
                throw error;
            }
            throw new UnauthorizedException('Invalid token');
        }
    }

    private extractToken(request: Request): string | null {
        const authHeader = request.headers.authorization;
        if (!authHeader) {
            return null;
        }

        const [type, token] = authHeader.split(' ');
        return type === 'Bearer' ? token : null;
    }

    private async validateUser(token: string): Promise<User> {
        try {
            const decoded = this.jwtService.verify(token, {
                secret: this.configService.get('JWT_SECRET')
            });

            const user = await this.userService.getUserById(decoded.sub);

            if (!user.isActive) {
                throw new UnauthorizedException('User account is inactive');
            }

            return user;
        } catch (error) {
            throw new UnauthorizedException('Invalid token');
        }
    }
}
