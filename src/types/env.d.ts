declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: 'development' | 'production' | 'test';
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    KMS_MASTER_KEY_ID: string;
    KMS_KEY_ALIAS: string;
    BACKUP_ENCRYPTION_KEY: string;
    // Add other environment variables as needed
  }
}
