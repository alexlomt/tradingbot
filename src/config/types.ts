export interface NetworkConfig {
  rpcEndpoint: string;
  wsEndpoint: string;
  commitment: string;
  cluster: string;
}

export interface WalletConfig {
  path: string;
  publicKey: string;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface RedisConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
  tls: boolean;
}

export interface TradingConfig {
  apiKey: string;
  apiSecret: string;
  defaultPair: string;
  orderSize: number;
  maxOpenPositions: number;
  maxConcurrentTrades: number;
  maxDailyTrades: number;
  maxPositionSize: number;
  dailyVolumeLimit: number;
  defaultSlippage: number;
  minLiquidityUsd: number;
  emergencyCloseAll: boolean;
}

export interface RiskManagementConfig {
  takeProfit: number;
  stopLoss: number;
  maxDrawdown: number;
  maxLeverage: number;
  cooldownPeriod: number;
}

export interface TransactionConfig {
  useWarpTransactions: boolean;
  useJitoTransactions: boolean;
  useCustomFee: boolean;
  customFee: number;
  computeUnitLimit: number;
  computeUnitPrice: number;
  skipPreflight: boolean;
  maxRetries: number;
  maxTimeout: number;
}

export interface MarketDataConfig {
  marketUpdateInterval: number;
  priceUpdateInterval: number;
  liquidityCheckInterval: number;
  volatilityWindow: number;
}

export interface SnipeListConfig {
  enabled: boolean;
  maxEntries: number;
  autoRemoveDays: number;
  persist: boolean;
  syncInterval: number;
  backupInterval: number;
}

export interface CacheConfig {
  enabled: boolean;
  ttl: number;
  maxSize: number;
  updateInterval: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'text';
  outputPath: string;
  sentryEnabled: boolean;
  sentryDsn: string;
  metricsEnabled: boolean;
  metricsPort: number;
}

export interface FeatureFlagsConfig {
  automaticTradingEnabled: boolean;
  riskManagementEnabled: boolean;
  warpIntegrationEnabled: boolean;
  jitoIntegrationEnabled: boolean;
  metricsDashboardEnabled: boolean;
}

export interface AppConfig {
  version: string;
  port: number;
  environment: 'development' | 'staging' | 'production';
  network: NetworkConfig;
  wallet: WalletConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  trading: TradingConfig;
  riskManagement: RiskManagementConfig;
  transactions: TransactionConfig;
  marketData: MarketDataConfig;
  snipeList: SnipeListConfig;
  cache: CacheConfig;
  logging: LoggingConfig;
  featureFlags: FeatureFlagsConfig;
}
