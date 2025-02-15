export enum BackupType {
    FULL = 'FULL',
    INCREMENTAL = 'INCREMENTAL'
}

export enum BackupStatus {
    PENDING = 'PENDING',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED'
}

export interface RestorePoint {
    backupId: string;
    s3Key: string;
    timestamp: string;
    type: BackupType;
}

export interface BackupMetrics {
    backupId: string;
    type: BackupType;
    duration: number;
    success: boolean;
}

export interface RestoreMetrics {
    restoreId: string;
    duration: number;
    success: boolean;
}
