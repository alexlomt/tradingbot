import { 
    Controller, 
    Post, 
    Headers, 
    Body, 
    RawBodyRequest, 
    Req,
    HttpStatus,
    HttpException,
    Logger
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';
import { Stripe } from 'stripe';
import { PaymentService } from '../../services/payment/PaymentService';
import { SubscriptionService } from '../../services/subscription/SubscriptionService';
import { RedisService } from '../../services/cache/RedisService';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

@ApiTags('Payment Webhooks')
@Controller('api/v1/webhooks/stripe')
export class StripeWebhookController {
    private readonly stripe: Stripe;
    private readonly logger = new Logger(StripeWebhookController.name);
    private readonly webhookSecret: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly paymentService: PaymentService,
        private readonly subscriptionService: SubscriptionService,
        private readonly redisService: RedisService,
        private readonly eventEmitter: EventEmitter2,
        @InjectQueue('payment-processing') private paymentQueue: Queue
    ) {
        this.stripe = new Stripe(this.configService.get('STRIPE_SECRET_KEY')!, {
            apiVersion: '2023-10-16'
        });
        this.webhookSecret = this.configService.get('STRIPE_WEBHOOK_SECRET')!;
    }

    @Post()
    @ApiOperation({ summary: 'Handle Stripe webhook events' })
    async handleWebhook(
        @Headers('stripe-signature') signature: string,
        @Req() request: RawBodyRequest<Request>,
        @Body() body: any
    ) {
        if (!signature) {
            throw new HttpException('Missing stripe-signature header', HttpStatus.BAD_REQUEST);
        }

        try {
            // Verify webhook signature
            const event = await this.verifyWebhookSignature(request.rawBody, signature);
            
            // Process event with idempotency
            const idempotencyKey = event.id;
            const processed = await this.redisService.get(`webhook:${idempotencyKey}`);
            
            if (processed) {
                return { status: 'Already processed' };
            }

            // Add to processing queue with high priority for important events
            const priority = this.getEventPriority(event.type);
            await this.paymentQueue.add('process-webhook', {
                event,
                timestamp: Date.now()
            }, {
                priority,
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000
                },
                removeOnComplete: true
            });

            // Mark as processed
            await this.redisService.set(
                `webhook:${idempotencyKey}`, 
                'processed',
                86400 // 24 hours TTL
            );

            return { received: true };
        } catch (error) {
            this.logger.error('Webhook processing error', error);
            
            // Track failed webhooks for monitoring
            await this.redisService.incr('webhook:failures:count');
            await this.redisService.lpush('webhook:failures', JSON.stringify({
                timestamp: Date.now(),
                error: error.message,
                signature
            }));

            throw new HttpException(
                'Webhook processing failed',
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    private async verifyWebhookSignature(
        payload: Buffer,
        signature: string
    ): Promise<Stripe.Event> {
        try {
            return this.stripe.webhooks.constructEvent(
                payload,
                signature,
                this.webhookSecret
            );
        } catch (error) {
            this.logger.error('Webhook signature verification failed', error);
            throw new HttpException(
                'Invalid webhook signature',
                HttpStatus.BAD_REQUEST
            );
        }
    }

    private getEventPriority(eventType: string): number {
        const priorityMap = {
            'charge.failed': 1,
            'customer.subscription.deleted': 1,
            'invoice.payment_failed': 1,
            'charge.succeeded': 2,
            'customer.subscription.updated': 2,
            'invoice.paid': 2,
            'default': 3
        };

        return priorityMap[eventType] || priorityMap.default;
    }
}
