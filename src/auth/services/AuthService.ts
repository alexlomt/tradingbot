import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { User } from '../entities/User.entity';
import { Role } from '../entities/Role.entity';
import { Permission } from '../entities/Permission.entity';
import { 
    RegisterUserDto, 
    LoginDto, 
    JwtPayload, 
    AuthResponse 
} from '../types/auth.types';

@Injectable()
export class AuthService implements OnModuleInit {
    private SUPER_ADMIN_EMAIL = 'alexlomt@yahoo.com';
    private SALT_ROUNDS = 10;

    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        @InjectRepository(Role)
        private readonly roleRepository: Repository<Role>,
        @InjectRepository(Permission)
        private readonly permissionRepository: Repository<Permission>,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService
    ) {}

    async onModuleInit() {
        await this.initializeRolesAndPermissions();
        await this.ensureSuperAdmin();
    }

    async register(registerDto: RegisterUserDto): Promise<AuthResponse> {
        const existingUser = await this.userRepository.findOne({
            where: { email: registerDto.email }
        });

        if (existingUser) {
            throw new UnauthorizedException('User already exists');
        }

        const hashedPassword = await bcrypt.hash(
            registerDto.password, 
            this.SALT_ROUNDS
        );

        const user = this.userRepository.create({
            ...registerDto,
            password: hashedPassword,
            role: registerDto.email === this.SUPER_ADMIN_EMAIL 
                ? await this.roleRepository.findOne({ where: { name: 'SUPER_ADMIN' }})
                : await this.roleRepository.findOne({ where: { name: 'USER' }})
        });

        await this.userRepository.save(user);

        const token = this.generateToken(user);
        return {
            user: this.sanitizeUser(user),
            token
        };
    }

    async login(loginDto: LoginDto): Promise<AuthResponse> {
        const user = await this.userRepository.findOne({
            where: { email: loginDto.email },
            relations: ['role', 'role.permissions']
        });

        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const isPasswordValid = await bcrypt.compare(
            loginDto.password,
            user.password
        );

        if (!isPasswordValid) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const token = this.generateToken(user);
        return {
            user: this.sanitizeUser(user),
            token
        };
    }

    async validateToken(token: string): Promise<User> {
        try {
            const payload = this.jwtService.verify<JwtPayload>(token);
            const user = await this.userRepository.findOne({
                where: { id: payload.sub },
                relations: ['role', 'role.permissions']
            });

            if (!user) {
                throw new UnauthorizedException('User not found');
            }

            return user;
        } catch (error) {
            throw new UnauthorizedException('Invalid token');
        }
    }

    private generateToken(user: User): string {
        const payload: JwtPayload = {
            sub: user.id,
            email: user.email,
            role: user.role.name
        };

        return this.jwtService.sign(payload);
    }

    private async initializeRolesAndPermissions(): Promise<void> {
        const roles = ['SUPER_ADMIN', 'ADMIN', 'USER'];
        const permissions = [
            'MANAGE_USERS',
            'MANAGE_ROLES',
            'MANAGE_PERMISSIONS',
            'VIEW_DASHBOARD',
            'MANAGE_BOT',
            'VIEW_ANALYTICS',
            'MANAGE_STRATEGIES',
            'MANAGE_RISK',
            'VIEW_LOGS'
        ];

        // Create permissions
        for (const perm of permissions) {
            const existingPerm = await this.permissionRepository.findOne({
                where: { name: perm }
            });

            if (!existingPerm) {
                await this.permissionRepository.save({
                    name: perm,
                    description: `Permission to ${perm.toLowerCase().replace('_', ' ')}`
                });
            }
        }

        // Create roles with permissions
        const allPerms = await this.permissionRepository.find();
        
        for (const roleName of roles) {
            const existingRole = await this.roleRepository.findOne({
                where: { name: roleName }
            });

            if (!existingRole) {
                const role = this.roleRepository.create({
                    name: roleName,
                    description: `${roleName.toLowerCase().replace('_', ' ')} role`,
                    permissions: roleName === 'SUPER_ADMIN' ? allPerms :
                               roleName === 'ADMIN' ? allPerms.filter(p => p.name !== 'MANAGE_ROLES') :
                               allPerms.filter(p => ['VIEW_DASHBOARD', 'VIEW_ANALYTICS'].includes(p.name))
                });

                await this.roleRepository.save(role);
            }
        }
    }

    private async ensureSuperAdmin(): Promise<void> {
        const superAdmin = await this.userRepository.findOne({
            where: { email: this.SUPER_ADMIN_EMAIL }
        });

        if (!superAdmin) {
            const defaultPassword = this.configService.get('SUPER_ADMIN_DEFAULT_PASSWORD');
            if (!defaultPassword) {
                throw new Error('SUPER_ADMIN_DEFAULT_PASSWORD not set in configuration');
            }

            await this.register({
                email: this.SUPER_ADMIN_EMAIL,
                password: defaultPassword,
                username: 'SuperAdmin'
            });
        }
    }

    private sanitizeUser(user: User): Partial<User> {
        const { password, ...sanitizedUser } = user;
        return sanitizedUser;
    }
}
