import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    HttpException,
    HttpStatus,
    Logger
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MetricsService } from '../../services/metrics/MetricsService';
import { NotificationService } from '../../services/notification/NotificationService';
import { ErrorCode } from '../../types/error.types';
import { Request } from 'express';
import * as Sentry from '@sentry/node';

@Injectable()
export class GlobalErrorInterceptor implements NestInterceptor {
    private readonly logger = new Logger(GlobalErrorInterceptor.name);

    constructor(
        private readonly metricsService: MetricsService,
        private readonly notificationService: NotificationService
    ) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const request = context.switchToHttp().getRequest<Request>();
        const startTime = Date.now();

        return next.handle().pipe(
            catchError(async error => {
                const errorContext = {
                    path: request.path,
                    method: request.method,
                    userId: request.user?.id,
                    timestamp: new Date().toISOString(),
                    duration: Date.now() - startTime
                };

                // Map error to standardized format
                const mappedError = this.mapError(error, errorContext);

                // Log error details
                this.logError(mappedError, errorContext);

                // Track error metrics
                await this.trackErrorMetrics(mappedError, errorContext);

                // Send notifications for critical errors
                if (this.isCriticalError(mappedError)) {
                    await this.handleCriticalError(mappedError, errorContext);
                }

                // Return formatted error response
                return throwError(() => this.formatErrorResponse(mappedError));
            })
        );
    }

    private mapError(error: any, context: any) {
        if (error instanceof HttpException) {
            return {
                code: error.getStatus(),
                type: 'HttpException',
                message: error.message,
                details: error.getResponse()
            };
        }

        if (error.code === 'ECONNREFUSED') {
            return {
                code: ErrorCode.SERVICE_UNAVAILABLE,
                type: 'ConnectionError',
                message: 'Service temporarily unavailable',
                details: error.message
            };
        }

        if (error.name === 'ValidationError') {
            return {
                code: ErrorCode.VALIDATION_ERROR,
                type: 'ValidationError',
                message: 'Invalid input data',
                details: this.formatValidationError(error)
            };
        }

        // Handle blockchain-specific errors
        if (error.code && error.code.startsWith('SOL_')) {
            return {
                code: ErrorCode.BLOCKCHAIN_ERROR,
                type: 'BlockchainError',
                message: this.formatBlockchainError(error),
                details: error
            };
        }

        // Default error mapping
        return {
            code: ErrorCode.INTERNAL_SERVER_ERROR,
            type: 'InternalError',
            message: 'An unexpected error occurred',
            details: error.message || 'No additional details available'
        };
    }

    private formatValidationError(error: any) {
        if (Array.isArray(error.errors)) {
            return error.errors.map(err => ({
                field: err.path,
                message: err.message,
                value: err.value
            }));
        }
        return error.message;
    }

    private formatBlockchainError(error: any) {
        const errorMessages = {
            'SOL_INSUFFICIENT_FUNDS': 'Insufficient funds for transaction',
            'SOL_INVALID_SIGNATURE': 'Invalid transaction signature',
            'SOL_TRANSACTION_ERROR': 'Transaction failed to confirm',
            'default': 'Blockchain operation failed'
        };

        return errorMessages[error.code] || errorMessages.default;
    }

    private async logError(error: any, context: any) {
        const logData = {
            ...error,
            context,
            stack: error.details?.stack,
            timestamp: new Date().toISOString()
        };

        this.logger.error(
            `Error in ${context.method} ${context.path}`,
            logData
        );

        // Send to Sentry for external error tracking
        Sentry.withScope(scope => {
            scope.setExtras(context);
            scope.setLevel(this.getSentryLevel(error));
            Sentry.captureException(error.details || error);
        });
    }

    private async trackErrorMetrics(error: any, context: any) {
        await this.metricsService.recordError({
            type: error.type,
            code: error.code,
            path: context.path,
            method: context.method,
            duration: context.duration,
            timestamp: new Date()
        });

        // Track error rates for circuit breaking
        const errorKey = `errors:${error.type}:${context.path}`;
        await this.metricsService.incrementErrorCount(errorKey);
    }

    private isCriticalError(error: any): boolean {
        return (
            error.code === ErrorCode.INTERNAL_SERVER_ERROR ||
            error.code === ErrorCode.SERVICE_UNAVAILABLE ||
            error.code === ErrorCode.BLOCKCHAIN_ERROR
        );
    }

    private async handleCriticalError(error: any, context: any) {
        await this.notificationService.sendSecurityAlert(
            'admin',
            {
                type: 'CRITICAL_ERROR',
                error: error,
                context: context
            }
        );
    }

    private formatErrorResponse(error: any) {
        return new HttpException(
            {
                status: this.getHttpStatus(error.code),
                error: error.type,
                message: error.message,
                details: this.sanitizeErrorDetails(error.details),
                timestamp: new Date().toISOString()
            },
            this.getHttpStatus(error.code)
        );
    }

    private getHttpStatus(errorCode: number): number {
        const statusMap = {
            [ErrorCode.VALIDATION_ERROR]: HttpStatus.BAD_REQUEST,
            [ErrorCode.UNAUTHORIZED]: HttpStatus.UNAUTHORIZED,
            [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
            [ErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
            [ErrorCode.CONFLICT]: HttpStatus.CONFLICT,
            [ErrorCode.SERVICE_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
            [ErrorCode.BLOCKCHAIN_ERROR]: HttpStatus.BAD_GATEWAY
        };

        return statusMap[errorCode] || HttpStatus.INTERNAL_SERVER_ERROR;
    }

    private getSentryLevel(error: any): Sentry.Severity {
        if (error.code >= 500) return Sentry.Severity.Error;
        if (error.code >= 400) return Sentry.Severity.Warning;
        return Sentry.Severity.Info;
    }

    private sanitizeErrorDetails(details: any): any {
        // Remove sensitive information before sending to client
        if (typeof details === 'object') {
            const sanitized = { ...details };
            const sensitiveFields = ['password', 'token', 'secret', 'key'];
            
            sensitiveFields.forEach(field => {
                if (field in sanitized) {
                    delete sanitized[field];
                }
            });

            return sanitized;
        }

        return details;
    }
}
