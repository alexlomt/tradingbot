// src/server.ts
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import http from 'http';
import WebSocket from 'ws';
import { connectDB } from './config/database';
import { logger } from './config/logger';
import { configureSecurityMiddleware } from './middleware/security';
import { errorHandler } from './middleware/error';
import { connectRedis } from './config/redis';
import { setupWebSocketServer } from './websocket';
import { authRouter } from './api/routes/auth';
import { botRouter } from './api/routes/bots';
import { licenseRouter } from './api/routes/license';
import { stripeRouter } from './api/routes/stripe';

async function startServer() {
    try {
        // Initialize database connections
        await connectDB();
        await connectRedis();

        const app = express();
        const server = http.createServer(app);
        const wss = new WebSocket.Server({ server });

        // Security middleware
        configureSecurityMiddleware(app);

        // Basic middleware
        app.use(helmet());
        app.use(cors({
            origin: process.env.ALLOWED_ORIGINS?.split(','),
            credentials: true
        }));
        app.use(express.json());

        // Setup WebSocket
        setupWebSocketServer(wss);

        // API Routes
        app.use('/api/auth', authRouter);
        app.use('/api/bots', botRouter);
        app.use('/api/license', licenseRouter);
        app.use('/api/stripe', stripeRouter);

        // Error handling
        app.use(errorHandler);

        // Health check
        app.get('/health', (_, res) => res.status(200).send('OK'));

        // Start server
        const PORT = process.env.PORT || 3001;
        server.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
        });

        // Handle graceful shutdown
        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);

    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

async function gracefulShutdown(signal: string) {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);
    
    try {
        // Close database connections
        await mongoose.connection.close();
        await redis.quit();
        
        logger.info('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
    }
}

startServer();