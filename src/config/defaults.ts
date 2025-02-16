import { AppConfig } from './types';

export const defaultConfig: AppConfig = {
  version: '1.0.0',
  port: 3000,
  environment: 'development',
  database: {
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    password: 'postgres',
    database: 'tradingbot',
  },
  trading: {
    apiKey: '',
    apiSecret: '',
    defaultPair: 'BTC/USD',
    orderSize: 0.01,
    maxOpenPositions: 3,
  },
  logging: {
    level: 'info',
    format: 'json',
    outputPath: './logs',
  },
};
