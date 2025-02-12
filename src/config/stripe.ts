// src/config/stripe.ts
import Stripe from 'stripe';
import { logger } from './logger';

if (!process.env.STRIPE_SECRET_KEY) {
    logger.error('STRIPE_SECRET_KEY is not defined');
    process.exit(1);
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    typescript: true,
});

export const SUBSCRIPTION_PLANS = {
    BASIC: {
        id: process.env.STRIPE_PRICE_BASIC,
        name: 'Basic Plan',
        maxBots: 1,
        features: ['Single bot instance', 'Basic analytics', 'Email support']
    },
    PRO: {
        id: process.env.STRIPE_PRICE_PRO,
        name: 'Pro Plan',
        maxBots: 5,
        features: ['Up to 5 bot instances', 'Advanced analytics', 'Priority support']
    },
    ENTERPRISE: {
        id: process.env.STRIPE_PRICE_ENTERPRISE,
        name: 'Enterprise Plan',
        maxBots: Infinity,
        features: ['Unlimited bot instances', 'Custom analytics', 'Dedicated support']
    }
};
