import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { AppConfig } from './types';
import { appConfigSchema } from './validation';
import { defaultConfig } from './defaults';

export class ConfigurationManager {
  private static instance: ConfigurationManager;
  private config: AppConfig;
  private configVersion: string;

  private constructor() {
    this.loadEnvironmentVariables();
    this.config = this.loadConfiguration();
    this.configVersion = this.config.version;
  }

  public static getInstance(): ConfigurationManager {
    if (!ConfigurationManager.instance) {
      ConfigurationManager.instance = new ConfigurationManager();
    }
    return ConfigurationManager.instance;
  }

  private loadEnvironmentVariables(): void {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
    }
  }

  private loadConfiguration(): AppConfig {
    try {
      const config: AppConfig = {
        version: process.env.APP_VERSION || defaultConfig.version,
        port: parseInt(process.env.APP_PORT || String(defaultConfig.port)),
        environment: (process.env.NODE_ENV as AppConfig['environment']) || defaultConfig.environment,
        database: {
          host: process.env.DB_HOST || defaultConfig.database.host,
          port: parseInt(process.env.DB_PORT || String(defaultConfig.database.port)),
          username: process.env.DB_USERNAME || defaultConfig.database.username,
          password: process.env.DB_PASSWORD || defaultConfig.database.password,
          database: process.env.DB_NAME || defaultConfig.database.database,
        },
        trading: {
          apiKey: process.env.TRADING_API_KEY || defaultConfig.trading.apiKey,
          apiSecret: process.env.TRADING_API_SECRET || defaultConfig.trading.apiSecret,
          defaultPair: process.env.TRADING_DEFAULT_PAIR || defaultConfig.trading.defaultPair,
          orderSize: parseFloat(process.env.TRADING_ORDER_SIZE || String(defaultConfig.trading.orderSize)),
          maxOpenPositions: parseInt(process.env.TRADING_MAX_OPEN_POSITIONS || String(defaultConfig.trading.maxOpenPositions)),
        },
        logging: {
          level: (process.env.LOG_LEVEL as AppConfig['logging']['level']) || defaultConfig.logging.level,
          format: (process.env.LOG_FORMAT as AppConfig['logging']['format']) || defaultConfig.logging.format,
          outputPath: process.env.LOG_OUTPUT_PATH || defaultConfig.logging.outputPath,
        },
      };

      // Validate the configuration
      const validatedConfig = appConfigSchema.parse(config);
      return validatedConfig;
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('Configuration validation failed:', error.errors);
      } else {
        console.error('Failed to load configuration:', error);
      }
      throw error;
    }
  }

  public getConfig(): AppConfig {
    return { ...this.config };
  }

  public getConfigVersion(): string {
    return this.configVersion;
  }

  public validateConfiguration(): boolean {
    try {
      appConfigSchema.parse(this.config);
      return true;
    } catch (error) {
      return false;
    }
  }
}

export const configManager = ConfigurationManager.getInstance();
