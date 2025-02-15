import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Query,
    UseGuards,
    ValidationPipe,
    ParseUUIDPipe,
    HttpStatus,
    UseInterceptors,
    CacheInterceptor,
    HttpException
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UserService } from '../services/UserService';
import { RoleGuard } from '../guards/RoleGuard';
import { RequiredPermissions } from '../decorators/RequiredPermissions.decorator';
import { CurrentUser } from '../decorators/CurrentUser.decorator';
import { RateLimitInterceptor } from '../interceptors/RateLimitInterceptor';
import { AuditInterceptor } from '../interceptors/AuditInterceptor';
import { MetricsInterceptor } from '../interceptors/MetricsInterceptor';
import {
    CreateUserDto,
    UpdateUserDto,
    UserFilters,
    UserResponse,
    UsersResponse,
    ApiResponse as CustomApiResponse
} from '../types/user.types';
import { User } from '../auth/entities/User.entity';
import { CircuitBreakerService } from '../services/circuit-breaker/CircuitBreakerService';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseInterceptors(CacheInterceptor, RateLimitInterceptor, AuditInterceptor, MetricsInterceptor)
@UseGuards(RoleGuard)
export class UserController {
    constructor(
        private readonly userService: UserService,
        private readonly circuitBreaker: CircuitBreakerService
    ) {}

    @Post()
    @RequiredPermissions(['MANAGE_USERS'])
    @ApiOperation({ summary: 'Create a new user' })
    @ApiResponse({ status: HttpStatus.CREATED, type: UserResponse })
    @ApiResponse({ status: HttpStatus.CONFLICT, description: 'User already exists' })
    @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient permissions' })
    async createUser(
        @Body(new ValidationPipe({ transform: true })) createUserDto: CreateUserDto,
        @CurrentUser() currentUser: User
    ): Promise<CustomApiResponse<UserResponse>> {
        try {
            const user = await this.circuitBreaker.executeFunction(
                'create_user_controller',
                async () => this.userService.createUser(createUserDto, currentUser.id)
            );

            return {
                success: true,
                data: user,
                message: 'User created successfully'
            };
        } catch (error) {
            if (error.message.includes('already exists')) {
                throw new HttpException(
                    'User with this email or username already exists',
                    HttpStatus.CONFLICT
                );
            }
            throw error;
        }
    }

    @Get()
    @RequiredPermissions(['VIEW_USERS'])
    @ApiOperation({ summary: 'Get all users with filters' })
    @ApiResponse({ status: HttpStatus.OK, type: UsersResponse })
    async getAllUsers(
        @Query(new ValidationPipe({ transform: true })) filters: UserFilters
    ): Promise<CustomApiResponse<UsersResponse>> {
        const users = await this.circuitBreaker.executeFunction(
            'get_all_users_controller',
            async () => this.userService.getAllUsers(filters)
        );

        return {
            success: true,
            data: { users, total: users.length },
            message: 'Users retrieved successfully'
        };
    }

    @Get(':id')
    @RequiredPermissions(['VIEW_USERS'])
    @ApiOperation({ summary: 'Get user by ID' })
    @ApiResponse({ status: HttpStatus.OK, type: UserResponse })
    @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'User not found' })
    async getUserById(
        @Param('id', new ParseUUIDPipe()) id: string
    ): Promise<CustomApiResponse<UserResponse>> {
        try {
            const user = await this.circuitBreaker.executeFunction(
                'get_user_by_id_controller',
                async () => this.userService.getUserById(id)
            );

            return {
                success: true,
                data: user,
                message: 'User retrieved successfully'
            };
        } catch (error) {
            if (error.message === 'User not found') {
                throw new HttpException('User not found', HttpStatus.NOT_FOUND);
            }
            throw error;
        }
    }

    @Put(':id')
    @RequiredPermissions(['MANAGE_USERS'])
    @ApiOperation({ summary: 'Update user' })
    @ApiResponse({ status: HttpStatus.OK, type: UserResponse })
    @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'User not found' })
    @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient permissions' })
    async updateUser(
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body(new ValidationPipe({ transform: true })) updateUserDto: UpdateUserDto,
        @CurrentUser() currentUser: User
    ): Promise<CustomApiResponse<UserResponse>> {
        // Special handling for SUPER_ADMIN updates
        const targetUser = await this.userService.getUserById(id);
        if (
            targetUser.role.name === 'SUPER_ADMIN' && 
            currentUser.role.name !== 'SUPER_ADMIN'
        ) {
            throw new HttpException(
                'Only SUPER_ADMIN can modify SUPER_ADMIN users',
                HttpStatus.FORBIDDEN
            );
        }

        try {
            const updatedUser = await this.circuitBreaker.executeFunction(
                'update_user_controller',
                async () => this.userService.updateUser(id, updateUserDto, currentUser.id)
            );

            return {
                success: true,
                data: updatedUser,
                message: 'User updated successfully'
            };
        } catch (error) {
            if (error.message === 'User not found') {
                throw new HttpException('User not found', HttpStatus.NOT_FOUND);
            }
            if (error.message.includes('already in use')) {
                throw new HttpException(
                    'Email or username already in use',
                    HttpStatus.CONFLICT
                );
            }
            throw error;
        }
    }

    @Delete(':id')
    @RequiredPermissions(['MANAGE_USERS'])
    @ApiOperation({ summary: 'Delete user' })
    @ApiResponse({ status: HttpStatus.OK, description: 'User deleted successfully' })
    @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'User not found' })
    @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Cannot delete SUPER_ADMIN' })
    async deleteUser(
        @Param('id', new ParseUUIDPipe()) id: string,
        @CurrentUser() currentUser: User
    ): Promise<CustomApiResponse<void>> {
        // Prevent deletion of SUPER_ADMIN users
        const targetUser = await this.userService.getUserById(id);
        if (targetUser.role.name === 'SUPER_ADMIN') {
            throw new HttpException(
                'Cannot delete SUPER_ADMIN user',
                HttpStatus.FORBIDDEN
            );
        }

        try {
            await this.circuitBreaker.executeFunction(
                'delete_user_controller',
                async () => this.userService.deleteUser(id, currentUser.id)
            );

            return {
                success: true,
                message: 'User deleted successfully'
            };
        } catch (error) {
            if (error.message === 'User not found') {
                throw new HttpException('User not found', HttpStatus.NOT_FOUND);
            }
            throw error;
        }
    }
}
