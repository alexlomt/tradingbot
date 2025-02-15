import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToMany
} from 'typeorm';
import { Role } from './Role.entity';
import { UserSession } from './UserSession.entity';

@Entity('users')
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    email: string;

    @Column({ unique: true })
    username: string;

    @Column()
    password: string;

    @Column({ default: true })
    isActive: boolean;

    @Column({ default: false })
    isTwoFactorEnabled: boolean;

    @Column({ nullable: true })
    twoFactorSecret: string;

    @ManyToOne(() => Role, role => role.users, { eager: true })
    role: Role;

    @OneToMany(() => UserSession, session => session.user)
    sessions: UserSession[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @Column({ nullable: true })
    lastLoginAt: Date;

    @Column({ default: 0 })
    loginAttempts: number;

    @Column({ nullable: true })
    lockoutUntil: Date;
}
