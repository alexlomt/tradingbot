import { 
    Processor, 
    Process, 
    OnQueueError,
    OnQueueFailed 
} from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { Stripe } from 'stripe';
import { PaymentService } from './PaymentService';
import { SubscriptionService } from '../subscription/SubscriptionService';
import { NotificationService } from '../notification/NotificationService';
import { MetricsService } from '../metrics/MetricsService';

@Processor('payment-processing')
export class PaymentProcessor {
    private readonly logger = new Logger(PaymentProcessor.name);

    constructor(
        private readonly paymentService: PaymentService,
        private readonly subscriptionService: SubscriptionService,
        private readonly notificationService: NotificationService,
        private readonly metricsService: MetricsService
    ) {}

    @Process('process-webhook')
    async processWebhook(job: Job<{ event: Stripe.Event; timestamp: number }>) {
        const { event } = job.data;
        const startTime = Date.now();

        try {
            switch (event.type) {
                case 'invoice.payment_succeeded':
                    await this.handleInvoicePaymentSucceeded(event.data.object);
                    break;

                case 'invoice.payment_failed':
                    await this.handleInvoicePaymentFailed(event.data.object);
                    break;

                case 'customer.subscription.deleted':
                    await this.handleSubscriptionDeleted(event.data.object);
                    break;

                case 'customer.subscription.updated':
                    await this.handleSubscriptionUpdated(event.data.object);
                    break;

                case 'charge.succeeded':
                    await this.handleChargeSucceeded(event.data.object);
                    break;

                case 'charge.failed':
                    await this.handleChargeFailed(event.data.object);
                    break;

                default:
                    this.logger.warn(`Unhandled event type: ${event.type}`);
            }

            // Track processing metrics
            await this.metricsService.recordWebhookProcessing(
                event.type,
                Date.now() - startTime,
                true
            );

            return { processed: true };
        } catch (error) {
            this.logger.error(`Failed to process webhook: ${event.type}`, error);
            
            await this.metricsService.recordWebhookProcessing(
                event.type,
                Date.now() - startTime,
                false
            );

            throw error;
        }
    }

    private async handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
        const subscriptionId = invoice.subscription as string;
        const customerId = invoice.customer as string;

        await Promise.all([
            this.subscriptionService.updateSubscriptionStatus(
                subscriptionId,
                'active',
                invoice.paid_at
            ),
            this.paymentService.recordSuccessfulPayment(invoice),
            this.notificationService.sendPaymentSuccessNotification(
                customerId,
                invoice.amount_paid
            )
        ]);
    }

    private async handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
        const subscriptionId = invoice.subscription as string;
        const customerId = invoice.customer as string;

        await Promise.all([
            this.subscriptionService.handleFailedPayment(subscriptionId),
            this.paymentService.recordFailedPayment(invoice),
            this.notificationService.sendPaymentFailureNotification(
                customerId,
                invoice.amount_due,
                invoice.next_payment_attempt
            )
        ]);
    }

    private async handleSubscriptionDeleted(subscription: Stripe.Subscription) {
        await Promise.all([
            this.subscriptionService.deactivateSubscription(subscription.id),
            this.notificationService.sendSubscriptionCancelledNotification(
                subscription.customer as string
            )
        ]);
    }

    private async handleSubscriptionUpdated(subscription: Stripe.Subscription) {
        await this.subscriptionService.updateSubscriptionDetails(
            subscription.id,
            {
                status: subscription.status,
                currentPeriodEnd: subscription.current_period_end,
                cancelAtPeriodEnd: subscription.cancel_at_period_end
            }
        );
    }

    private async handleChargeSucceeded(charge: Stripe.Charge) {
        await Promise.all([
            this.paymentService.recordChargeSuccess(charge),
            this.metricsService.incrementRevenueMetrics(charge.amount)
        ]);
    }

    private async handleChargeFailed(charge: Stripe.Charge) {
        await Promise.all([
            this.paymentService.recordChargeFail(charge),
            this.notificationService.sendChargeFailureNotification(
                charge.customer as string,
                charge.amount,
                charge.failure_message
            )
        ]);
    }

    @OnQueueError()
    onError(error: Error) {
        this.logger.error('Payment queue error', error);
    }

    @OnQueueFailed()
    async onFailed(job: Job, error: Error) {
        this.logger.error(
            `Payment job ${job.id} failed`,
            {
                error,
                data: job.data
            }
        );

        await this.notificationService.sendAdminAlert(
            'Payment Processing Failure',
            {
                jobId: job.id,
                error: error.message,
                data: job.data
            }
        );
    }
}
