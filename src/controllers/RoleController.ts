import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    UseGuards,
    ValidationPipe,
    ParseUUIDPipe,
    HttpStatus,
    UseInterceptors,
    HttpException
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { RoleService } from '../services/RoleService';
import { RoleGuard } from '../guards/RoleGuard';
import { RequiredPermissions } from '../decorators/RequiredPermissions.decorator';
import { CurrentUser } from '../decorators/CurrentUser.decorator';
import { RateLimitInterceptor } from '../interceptors/RateLimitInterceptor';
import { AuditInterceptor } from '../interceptors/AuditInterceptor';
import { MetricsInterceptor } from '../interceptors/MetricsInterceptor';
import { CacheInterceptor } from '../interceptors/CacheInterceptor';
import { Role } from '../auth/entities/Role.entity';
import { User } from '../auth/entities/User.entity';
import { CreateRoleDto, UpdateRoleDto, RoleResponse, ApiResponse as CustomApiResponse } from '../types/role.types';
import { CircuitBreakerService } from '../services/circuit-breaker/CircuitBreakerService';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../services/audit/AuditService';

@ApiTags('Roles')
@ApiBearerAuth()
@Controller('roles')
@UseInterceptors(CacheInterceptor, RateLimitInterceptor, AuditInterceptor, MetricsInterceptor)
@UseGuards(RoleGuard)
export class RoleController {
    private readonly SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
    private readonly PROTECTED_ROLES = ['SUPER_ADMIN', 'ADMIN'];

    constructor(
        private readonly roleService: RoleService,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly configService: ConfigService,
        private readonly auditService: AuditService
    ) {}

    @Post()
    @RequiredPermissions(['MANAGE_ROLES'])
    @ApiOperation({ summary: 'Create a new role' })
    @ApiResponse({ status: HttpStatus.CREATED, type: RoleResponse })
    async createRole(
        @Body(new ValidationPipe({ transform: true })) createRoleDto: CreateRoleDto,
        @CurrentUser() currentUser: User
    ): Promise<CustomApiResponse<RoleResponse>> {
        // Only SUPER_ADMIN can create roles with elevated permissions
        if (
            createRoleDto.permissions.includes('MANAGE_ROLES') && 
            currentUser.role.name !== this.SUPER_ADMIN_ROLE
        ) {
            throw new HttpException(
                'Only SUPER_ADMIN can create roles with role management permissions',
                HttpStatus.FORBIDDEN
            );
        }

        try {
            const role = await this.circuitBreaker.executeFunction(
                'create_role_controller',
                async () => {
                    const newRole = await this.roleService.createRole(createRoleDto);
                    await this.auditService.logRoleCreation(newRole, currentUser.id);
                    return newRole;
                }
            );

            return {
                success: true,
                data: role,
                message: 'Role created successfully',
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            if (error.message.includes('already exists')) {
                throw new HttpException(
                    'Role with this name already exists',
                    HttpStatus.CONFLICT
                );
            }
            throw error;
        }
    }

    @Get()
    @RequiredPermissions(['VIEW_ROLES'])
    @ApiOperation({ summary: 'Get all roles' })
    @ApiResponse({ status: HttpStatus.OK, type: [RoleResponse] })
    async getAllRoles(
        @CurrentUser() currentUser: User
    ): Promise<CustomApiResponse<RoleResponse[]>> {
        const roles = await this.circuitBreaker.executeFunction(
            'get_all_roles_controller',
            async () => {
                let roles = await this.roleService.getAllRoles();
                
                // Filter out SUPER_ADMIN role for non-SUPER_ADMIN users
                if (currentUser.role.name !== this.SUPER_ADMIN_ROLE) {
                    roles = roles.filter(role => role.name !== this.SUPER_ADMIN_ROLE);
                }
                
                return roles;
            }
        );

        return {
            success: true,
            data: roles,
            message: 'Roles retrieved successfully',
            timestamp: new Date().toISOString()
        };
    }

    @Get(':id')
    @RequiredPermissions(['VIEW_ROLES'])
    @ApiOperation({ summary: 'Get role by ID' })
    @ApiResponse({ status: HttpStatus.OK, type: RoleResponse })
    async getRoleById(
        @Param('id', new ParseUUIDPipe()) id: string,
        @CurrentUser() currentUser: User
    ): Promise<CustomApiResponse<RoleResponse>> {
        try {
            const role = await this.circuitBreaker.executeFunction(
                'get_role_by_id_controller',
                async () => this.roleService.getRoleById(id)
            );

            // Prevent non-SUPER_ADMIN from viewing SUPER_ADMIN role
            if (
                role.name === this.SUPER_ADMIN_ROLE && 
                currentUser.role.name !== this.SUPER_ADMIN_ROLE
            ) {
                throw new HttpException(
                    'Access denied',
                    HttpStatus.FORBIDDEN
                );
            }

            return {
                success: true,
                data: role,
                message: 'Role retrieved successfully',
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            if (error.message === 'Role not found') {
                throw new HttpException('Role not found', HttpStatus.NOT_FOUND);
            }
            throw error;
        }
    }

    @Put(':id')
    @RequiredPermissions(['MANAGE_ROLES'])
    @ApiOperation({ summary: 'Update role' })
    @ApiResponse({ status: HttpStatus.OK, type: RoleResponse })
    async updateRole(
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body(new ValidationPipe({ transform: true })) updateRoleDto: UpdateRoleDto,
        @CurrentUser() currentUser: User
    ): Promise<CustomApiResponse<RoleResponse>> {
        const existingRole = await this.roleService.getRoleById(id);

        // Protect system roles
        if (this.PROTECTED_ROLES.includes(existingRole.name)) {
            if (currentUser.role.name !== this.SUPER_ADMIN_ROLE) {
                throw new HttpException(
                    'Protected role cannot be modified',
                    HttpStatus.FORBIDDEN
                );
            }
        }

        try {
            const updatedRole = await this.circuitBreaker.executeFunction(
                'update_role_controller',
                async () => {
                    const role = await this.roleService.updateRole(id, updateRoleDto);
                    await this.auditService.logRoleUpdate(role, currentUser.id);
                    return role;
                }
            );

            return {
                success: true,
                data: updatedRole,
                message: 'Role updated successfully',
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            if (error.message === 'Role not found') {
                throw new HttpException('Role not found', HttpStatus.NOT_FOUND);
            }
            throw error;
        }
    }

    @Delete(':id')
    @RequiredPermissions(['MANAGE_ROLES'])
    @ApiOperation({ summary: 'Delete role' })
    @ApiResponse({ status: HttpStatus.OK })
    async deleteRole(
        @Param('id', new ParseUUIDPipe()) id: string,
        @CurrentUser() currentUser: User
    ): Promise<CustomApiResponse<void>> {
        const role = await this.roleService.getRoleById(id);

        // Prevent deletion of protected roles
        if (this.PROTECTED_ROLES.includes(role.name)) {
            throw new HttpException(
                'Protected role cannot be deleted',
                HttpStatus.FORBIDDEN
            );
        }

        // Check if role has any users
        const hasUsers = await this.roleService.roleHasUsers(id);
        if (hasUsers) {
            throw new HttpException(
                'Cannot delete role with assigned users',
                HttpStatus.CONFLICT
            );
        }

        try {
            await this.circuitBreaker.executeFunction(
                'delete_role_controller',
                async () => {
                    await this.roleService.deleteRole(id);
                    await this.auditService.logRoleDeletion(role, currentUser.id);
                }
            );

            return {
                success: true,
                message: 'Role deleted successfully',
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            if (error.message === 'Role not found') {
                throw new HttpException('Role not found', HttpStatus.NOT_FOUND);
            }
            throw error;
        }
    }
}
