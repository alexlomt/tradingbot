import { captureException, withScope, Severity } from '@sentry/browser';
import { PerformanceMonitor } from './performance';
import { logger } from './logger';

interface ErrorContext {
    user?: {
        id?: string;
        username?: string;
        email?: string;
    };
    tags?: Record<string, string>;
    extra?: Record<string, any>;
    level?: Severity;
}

export class ErrorReporter {
    private static readonly ERROR_THRESHOLD = 3;
    private static readonly TIME_WINDOW = 60000; // 1 minute
    private static errorCount: Map<string, number> = new Map();
    private static errorTimestamps: Map<string, number[]> = new Map();

    static initialize(dsn: string, environment: string): void {
        try {
            Sentry.init({
                dsn,
                environment,
                tracesSampleRate: 1.0,
                integrations: [
                    new Sentry.BrowserTracing(),
                    new Sentry.Replay()
                ],
                beforeSend(event) {
                    if (event.exception) {
                        PerformanceMonitor.recordMetric('error', {
                            timestamp: new Date(),
                            duration: 0,
                            context: {
                                type: event.exception.values?.[0]?.type,
                                value: event.exception.values?.[0]?.value
                            }
                        });
                    }
                    return event;
                }
            });
        } catch (error) {
            logger.error('Failed to initialize error reporting:', error);
        }
    }

    static reportError(
        error: Error,
        context: ErrorContext = {}
    ): void {
        try {
            const errorKey = `${error.name}:${error.message}`;
            
            // Update error count and timestamps
            this.updateErrorStats(errorKey);

            // Check for error threshold
            if (this.shouldThrottleError(errorKey)) {
                logger.warn('Error reporting throttled:', { errorKey });
                return;
            }

            withScope(scope => {
                // Set user context
                if (context.user) {
                    scope.setUser(context.user);
                }

                // Set tags
                if (context.tags) {
                    Object.entries(context.tags).forEach(([key, value]) => {
                        scope.setTag(key, value);
                    });
                }

                // Set extra context
                if (context.extra) {
                    Object.entries(context.extra).forEach(([key, value]) => {
                        scope.setExtra(key, value);
                    });
                }

                // Set error level
                if (context.level) {
                    scope.setLevel(context.level);
                }

                captureException(error);
            });

            // Log to local logger
            logger.error('Error captured:', {
                error: error.message,
                stack: error.stack,
                context
            });
        } catch (reportingError) {
            logger.error('Failed to report error:', reportingError);
        }
    }

    private static updateErrorStats(errorKey: string): void {
        const currentTime = Date.now();
        
        // Update error count
        this.errorCount.set(
            errorKey,
            (this.errorCount.get(errorKey) || 0) + 1
        );

        // Update timestamps
        if (!this.errorTimestamps.has(errorKey)) {
            this.errorTimestamps.set(errorKey, []);
        }
        
        const timestamps = this.errorTimestamps.get(errorKey);
        timestamps.push(currentTime);

        // Clean up old timestamps
        const cutoff = currentTime - this.TIME_WINDOW;
        this.errorTimestamps.set(
            errorKey,
            timestamps.filter(t => t > cutoff)
        );
    }

    private static shouldThrottleError(errorKey: string): boolean {
        const timestamps = this.errorTimestamps.get(errorKey) || [];
        return timestamps.length > this.ERROR_THRESHOLD;
    }

    static clearErrorStats(): void {
        this.errorCount.clear();
        this.errorTimestamps.clear();
    }
}

export const handleGlobalErrors = (): void => {
    window.onerror = (message, source, lineno, colno, error) => {
        ErrorReporter.reportError(error || new Error(String(message)), {
            extra: { source, lineno, colno }
        });
        return false;
    };

    window.onunhandledrejection = (event) => {
        ErrorReporter.reportError(
            event.reason instanceof Error ? event.reason : new Error(String(event.reason)),
            {
                tags: { type: 'unhandled_promise' }
            }
        );
    };
};
