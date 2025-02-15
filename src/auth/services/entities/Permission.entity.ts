import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToMany
} from 'typeorm';
import { Role } from './Role.entity';

@Entity('permissions')
export class Permission {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    name: string;

    @Column({ type: 'text' })
    description: string;

    @Column({ default: true })
    isActive: boolean;

    @Column({ type: 'jsonb', nullable: true })
    metadata: Record<string, any>;

    @ManyToMany(() => Role, role => role.permissions)
    roles: Role[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
