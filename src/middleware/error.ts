// src/middleware/error.ts
import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

export class AppError extends Error {
    constructor(
        public statusCode: number,
        public message: string,
        public isOperational: boolean = true
    ) {
        super(message);
        Error.captureStackTrace(this, this.constructor);
    }
}

export const errorHandler = (
    err: Error,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (err instanceof AppError) {
        logger.error({
            error: err.message,
            stack: err.stack,
            isOperational: err.isOperational
        });

        return res.status(err.statusCode).json({
            error: err.message
        });
    }

    // Unexpected errors
    logger.error({
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });

    res.status(500).json({
        error: 'An unexpected error occurred'
    });
};