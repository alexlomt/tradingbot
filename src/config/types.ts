export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface TradingConfig {
  apiKey: string;
  apiSecret: string;
  defaultPair: string;
  orderSize: number;
  maxOpenPositions: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'text';
  outputPath: string;
}

export interface AppConfig {
  version: string;
  port: number;
  environment: 'development' | 'staging' | 'production';
  database: DatabaseConfig;
  trading: TradingConfig;
  logging: LoggingConfig;
}
