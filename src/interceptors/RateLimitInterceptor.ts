import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    HttpException,
    HttpStatus
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { RedisService } from '../services/redis/RedisService';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { MetricsService } from '../services/metrics/MetricsService';
import { AuditService } from '../services/audit/AuditService';

interface RateLimitConfig {
    points: number;      // Number of requests allowed
    duration: number;    // Time window in seconds
    blockDuration: number; // Duration of block if limit exceeded (seconds)
}

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
    private readonly rateLimits: Map<string, RateLimitConfig>;
    private readonly defaultLimit: RateLimitConfig;

    constructor(
        private readonly redisService: RedisService,
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly auditService: AuditService
    ) {
        // Initialize rate limit configurations
        this.defaultLimit = {
            points: 60,
            duration: 60,
            blockDuration: 300
        };

        this.rateLimits = new Map([
            ['auth', { points: 5, duration: 60, blockDuration: 600 }],
            ['trading', { points: 100, duration: 60, blockDuration: 300 }],
            ['admin', { points: 30, duration: 60, blockDuration: 600 }],
            ['api', { points: 1000, duration: 60, blockDuration: 300 }]
        ]);
    }

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
        const request = context.switchToHttp().getRequest<Request>();
        const clientIp = this.getClientIp(request);
        const path = request.path;
        const userId = request.user?.id || 'anonymous';

        // Determine which rate limit to apply
        const limitConfig = this.getLimitConfig(path);

        // Generate unique keys for rate limiting
        const rateLimitKey = `ratelimit:${clientIp}:${path}`;
        const blockKey = `ratelimit:block:${clientIp}:${path}`;

        try {
            // Check if client is blocked
            const isBlocked = await this.redisService.get(blockKey);
            if (isBlocked) {
                const ttl = await this.redisService.ttl(blockKey);
                throw new HttpException({
                    statusCode: HttpStatus.TOO_MANY_REQUESTS,
                    message: 'Rate limit exceeded. Please try again later.',
                    retryAfter: ttl
                }, HttpStatus.TOO_MANY_REQUESTS);
            }

            // Increment request counter
            const multi = this.redisService.multi();
            multi.incr(rateLimitKey);
            multi.ttl(rateLimitKey);

            const [requestCount, ttl] = await multi.exec();

            // Set expiry for new keys
            if (ttl === -1) {
                await this.redisService.expire(rateLimitKey, limitConfig.duration);
            }

            // Check if limit exceeded
            if (requestCount > limitConfig.points) {
                // Block the client
                await this.redisService.setex(
                    blockKey,
                    limitConfig.blockDuration,
                    'blocked'
                );

                // Log rate limit violation
                await this.auditService.logSystemEvent({
                    event: 'RATE_LIMIT_EXCEEDED',
                    details: {
                        clientIp,
                        path,
                        userId,
                        requestCount,
                        limit: limitConfig.points
                    },
                    severity: 'WARNING'
                });

                // Update metrics
                await this.metricsService.incrementRateLimitViolation(path);

                throw new HttpException({
                    statusCode: HttpStatus.TOO_MANY_REQUESTS,
                    message: 'Rate limit exceeded. Please try again later.',
                    retryAfter: limitConfig.blockDuration
                }, HttpStatus.TOO_MANY_REQUESTS);
            }

            // Set rate limit headers
            const response = context.switchToHttp().getResponse();
            response.header('X-RateLimit-Limit', limitConfig.points);
            response.header('X-RateLimit-Remaining', limitConfig.points - requestCount);
            response.header('X-RateLimit-Reset', Math.ceil(Date.now() / 1000) + ttl);

            // Update metrics
            await this.metricsService.incrementRequestCount(path);

            return next.handle();
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }
            
            // Log unexpected errors
            await this.auditService.logSystemEvent({
                event: 'RATE_LIMIT_ERROR',
                details: {
                    clientIp,
                    path,
                    userId,
                    error: error.message
                },
                severity: 'ERROR'
            });

            throw new HttpException(
                'Internal server error',
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    private getLimitConfig(path: string): RateLimitConfig {
        // Determine rate limit based on path
        if (path.startsWith('/api/auth')) {
            return this.rateLimits.get('auth');
        }
        if (path.startsWith('/api/trading')) {
            return this.rateLimits.get('trading');
        }
        if (path.startsWith('/api/admin')) {
            return this.rateLimits.get('admin');
        }
        if (path.startsWith('/api')) {
            return this.rateLimits.get('api');
        }
        return this.defaultLimit;
    }

    private getClientIp(request: Request): string {
        // Get IP from proxy headers if behind proxy
        const forwardedFor = request.headers['x-forwarded-for'];
        if (forwardedFor) {
            return Array.isArray(forwardedFor)
                ? forwardedFor[0]
                : forwardedFor.split(',')[0];
        }
        return request.ip;
    }
}
