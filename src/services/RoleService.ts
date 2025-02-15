import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../auth/entities/Role.entity';
import { Permission } from '../auth/entities/Permission.entity';
import { CreateRoleDto, UpdateRoleDto } from '../types/role.types';
import { CircuitBreakerService } from './circuit-breaker/CircuitBreakerService';
import { CacheService } from './cache/CacheService';

@Injectable()
export class RoleService {
    private readonly CACHE_TTL = 300; // 5 minutes
    private readonly CACHE_PREFIX = 'role:';

    constructor(
        @InjectRepository(Role)
        private readonly roleRepository: Repository<Role>,
        @InjectRepository(Permission)
        private readonly permissionRepository: Repository<Permission>,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly cacheService: CacheService
    ) {}

    async getAllRoles(): Promise<Role[]> {
        return this.circuitBreaker.executeFunction(
            'get_all_roles',
            async () => {
                const cachedRoles = await this.cacheService.get(
                    `${this.CACHE_PREFIX}all`
                );

                if (cachedRoles) {
                    return JSON.parse(cachedRoles);
                }

                const roles = await this.roleRepository.find({
                    relations: ['permissions']
                });

                await this.cacheService.set(
                    `${this.CACHE_PREFIX}all`,
                    JSON.stringify(roles),
                    this.CACHE_TTL
                );

                return roles;
            }
        );
    }

    async getRoleById(id: string): Promise<Role> {
        return this.circuitBreaker.executeFunction(
            'get_role_by_id',
            async () => {
                const cachedRole = await this.cacheService.get(
                    `${this.CACHE_PREFIX}${id}`
                );

                if (cachedRole) {
                    return JSON.parse(cachedRole);
                }

                const role = await this.roleRepository.findOne({
                    where: { id },
                    relations: ['permissions']
                });

                if (!role) {
                    throw new Error('Role not found');
                }

                await this.cacheService.set(
                    `${this.CACHE_PREFIX}${id}`,
                    JSON.stringify(role),
                    this.CACHE_TTL
                );

                return role;
            }
        );
    }

    async createRole(createRoleDto: CreateRoleDto): Promise<Role> {
        return this.circuitBreaker.executeFunction(
            'create_role',
            async () => {
                const permissions = await this.permissionRepository.findByIds(
                    createRoleDto.permissionIds
                );

                const role = this.roleRepository.create({
                    ...createRoleDto,
                    permissions
                });

                const savedRole = await this.roleRepository.save(role);
                await this.invalidateRoleCache();
                return savedRole;
            }
        );
    }

    async updateRole(id: string, updateRoleDto: UpdateRoleDto): Promise<Role> {
        return this.circuitBreaker.executeFunction(
            'update_role',
            async () => {
                const role = await this.getRoleById(id);
                
                if (updateRoleDto.permissionIds) {
                    const permissions = await this.permissionRepository.findByIds(
                        updateRoleDto.permissionIds
                    );
                    role.permissions = permissions;
                }

                Object.assign(role, updateRoleDto);
                const updatedRole = await this.roleRepository.save(role);
                await this.invalidateRoleCache();
                return updatedRole;
            }
        );
    }

    async deleteRole(id: string): Promise<void> {
        return this.circuitBreaker.executeFunction(
            'delete_role',
            async () => {
                const role = await this.getRoleById(id);
                
                if (role.name === 'SUPER_ADMIN') {
                    throw new Error('Cannot delete SUPER_ADMIN role');
                }

                await this.roleRepository.remove(role);
                await this.invalidateRoleCache();
            }
        );
    }

    async getAllPermissions(): Promise<Permission[]> {
        return this.circuitBreaker.executeFunction(
            'get_all_permissions',
            async () => {
                const cachedPermissions = await this.cacheService.get(
                    `${this.CACHE_PREFIX}permissions`
                );

                if (cachedPermissions) {
                    return JSON.parse(cachedPermissions);
                }

                const permissions = await this.permissionRepository.find();

                await this.cacheService.set(
                    `${this.CACHE_PREFIX}permissions`,
                    JSON.stringify(permissions),
                    this.CACHE_TTL
                );

                return permissions;
            }
        );
    }

    private async invalidateRoleCache(): Promise<void> {
        await this.cacheService.del(`${this.CACHE_PREFIX}all`);
        // Could also implement more granular cache invalidation if needed
    }
}
