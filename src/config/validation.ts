import { z } from 'zod';

export const databaseConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  database: z.string().min(1),
});

export const tradingConfigSchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  defaultPair: z.string().min(1),
  orderSize: z.number().positive(),
  maxOpenPositions: z.number().int().positive(),
});

export const loggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  format: z.enum(['json', 'text']),
  outputPath: z.string().min(1),
});

export const appConfigSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  port: z.number().int().min(1).max(65535),
  environment: z.enum(['development', 'staging', 'production']),
  database: databaseConfigSchema,
  trading: tradingConfigSchema,
  logging: loggingConfigSchema,
});
