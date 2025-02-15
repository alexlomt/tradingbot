import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../auth/entities/User.entity';
import { Role } from '../auth/entities/Role.entity';
import { CreateUserDto, UpdateUserDto, UserFilters } from '../types/user.types';
import { CircuitBreakerService } from './circuit-breaker/CircuitBreakerService';
import { CacheService } from './cache/CacheService';
import { MetricsService } from './metrics/MetricsService';
import { NotificationService } from './notification/NotificationService';
import { AuditService } from './audit/AuditService';

@Injectable()
export class UserService {
    private readonly SALT_ROUNDS = 10;
    private readonly CACHE_TTL = 300; // 5 minutes
    private readonly CACHE_PREFIX = 'user:';
    private readonly MAX_LOGIN_ATTEMPTS = 5;
    private readonly LOCKOUT_DURATION = 30 * 60 * 1000; // 30 minutes

    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        @InjectRepository(Role)
        private readonly roleRepository: Repository<Role>,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly cacheService: CacheService,
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService,
        private readonly auditService: AuditService
    ) {}

    async createUser(createUserDto: CreateUserDto, createdBy: string): Promise<User> {
        return this.circuitBreaker.executeFunction(
            'create_user',
            async () => {
                const existingUser = await this.userRepository.findOne({
                    where: [
                        { email: createUserDto.email },
                        { username: createUserDto.username }
                    ]
                });

                if (existingUser) {
                    throw new ConflictException('User already exists');
                }

                const role = await this.roleRepository.findOne({
                    where: { id: createUserDto.roleId }
                });

                if (!role) {
                    throw new Error('Role not found');
                }

                const hashedPassword = await bcrypt.hash(
                    createUserDto.password,
                    this.SALT_ROUNDS
                );

                const user = this.userRepository.create({
                    ...createUserDto,
                    password: hashedPassword,
                    role
                });

                const savedUser = await this.userRepository.save(user);
                await this.auditService.logUserCreation(savedUser, createdBy);
                await this.invalidateUserCache();

                // Notify admin of new user creation
                await this.notificationService.sendAdminNotification({
                    type: 'USER_CREATED',
                    data: {
                        username: user.username,
                        email: user.email,
                        role: role.name
                    }
                });

                return this.sanitizeUser(savedUser);
            }
        );
    }

    async updateUser(
        id: string,
        updateUserDto: UpdateUserDto,
        updatedBy: string
    ): Promise<User> {
        return this.circuitBreaker.executeFunction(
            'update_user',
            async () => {
                const user = await this.getUserById(id);

                if (updateUserDto.email && updateUserDto.email !== user.email) {
                    const existingUser = await this.userRepository.findOne({
                        where: { email: updateUserDto.email, id: Not(id) }
                    });

                    if (existingUser) {
                        throw new ConflictException('Email already in use');
                    }
                }

                if (updateUserDto.roleId) {
                    const role = await this.roleRepository.findOne({
                        where: { id: updateUserDto.roleId }
                    });

                    if (!role) {
                        throw new Error('Role not found');
                    }

                    user.role = role;
                }

                if (updateUserDto.password) {
                    user.password = await bcrypt.hash(
                        updateUserDto.password,
                        this.SALT_ROUNDS
                    );
                }

                Object.assign(user, {
                    ...updateUserDto,
                    password: user.password // Preserve hashed password if not updating
                });

                const updatedUser = await this.userRepository.save(user);
                await this.auditService.logUserUpdate(updatedUser, updatedBy);
                await this.invalidateUserCache(id);

                return this.sanitizeUser(updatedUser);
            }
        );
    }

    async getAllUsers(filters?: UserFilters): Promise<User[]> {
        return this.circuitBreaker.executeFunction(
            'get_all_users',
            async () => {
                const cacheKey = `${this.CACHE_PREFIX}all${
                    filters ? ':' + JSON.stringify(filters) : ''
                }`;

                const cachedUsers = await this.cacheService.get(cacheKey);
                if (cachedUsers) {
                    return JSON.parse(cachedUsers);
                }

                const queryBuilder = this.userRepository
                    .createQueryBuilder('user')
                    .leftJoinAndSelect('user.role', 'role');

                if (filters?.isActive !== undefined) {
                    queryBuilder.andWhere('user.isActive = :isActive', {
                        isActive: filters.isActive
                    });
                }

                if (filters?.roleId) {
                    queryBuilder.andWhere('role.id = :roleId', {
                        roleId: filters.roleId
                    });
                }

                if (filters?.search) {
                    queryBuilder.andWhere(
                        '(user.username ILIKE :search OR user.email ILIKE :search)',
                        { search: `%${filters.search}%` }
                    );
                }

                const users = await queryBuilder
                    .orderBy('user.createdAt', 'DESC')
                    .getMany();

                const sanitizedUsers = users.map(user => this.sanitizeUser(user));
                
                await this.cacheService.set(
                    cacheKey,
                    JSON.stringify(sanitizedUsers),
                    this.CACHE_TTL
                );

                return sanitizedUsers;
            }
        );
    }

    async getUserById(id: string): Promise<User> {
        return this.circuitBreaker.executeFunction(
            'get_user_by_id',
            async () => {
                const cachedUser = await this.cacheService.get(
                    `${this.CACHE_PREFIX}${id}`
                );

                if (cachedUser) {
                    return JSON.parse(cachedUser);
                }

                const user = await this.userRepository.findOne({
                    where: { id },
                    relations: ['role', 'role.permissions']
                });

                if (!user) {
                    throw new Error('User not found');
                }

                const sanitizedUser = this.sanitizeUser(user);
                
                await this.cacheService.set(
                    `${this.CACHE_PREFIX}${id}`,
                    JSON.stringify(sanitizedUser),
                    this.CACHE_TTL
                );

                return sanitizedUser;
            }
        );
    }

    async deleteUser(id: string, deletedBy: string): Promise<void> {
        return this.circuitBreaker.executeFunction(
            'delete_user',
            async () => {
                const user = await this.getUserById(id);

                if (user.role.name === 'SUPER_ADMIN') {
                    throw new Error('Cannot delete SUPER_ADMIN user');
                }

                await this.userRepository.remove(user);
                await this.auditService.logUserDeletion(user, deletedBy);
                await this.invalidateUserCache(id);

                await this.notificationService.sendAdminNotification({
                    type: 'USER_DELETED',
                    data: {
                        username: user.username,
                        email: user.email,
                        deletedBy
                    }
                });
            }
        );
    }

    async updateLoginAttempts(id: string, success: boolean): Promise<void> {
        const user = await this.getUserById(id);

        if (success) {
            user.loginAttempts = 0;
            user.lockoutUntil = null;
            user.lastLoginAt = new Date();
        } else {
            user.loginAttempts += 1;

            if (user.loginAttempts >= this.MAX_LOGIN_ATTEMPTS) {
                user.lockoutUntil = new Date(Date.now() + this.LOCKOUT_DURATION);
                await this.notificationService.sendAdminNotification({
                    type: 'USER_LOCKED',
                    data: {
                        username: user.username,
                        email: user.email,
                        attempts: user.loginAttempts
                    }
                });
            }
        }

        await this.userRepository.save(user);
        await this.invalidateUserCache(id);
    }

    private sanitizeUser(user: User): Partial<User> {
        const { password, ...sanitizedUser } = user;
        return sanitizedUser;
    }

    private async invalidateUserCache(userId?: string): Promise<void> {
        if (userId) {
            await this.cacheService.del(`${this.CACHE_PREFIX}${userId}`);
        }
        await this.cacheService.del(`${this.CACHE_PREFIX}all`);
    }
}
