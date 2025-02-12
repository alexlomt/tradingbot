// src/api/controllers/license.controller.ts
import { Request, Response } from 'express';
import { LicenseService } from '../../services/license.service';
import { SUBSCRIPTION_PLANS } from '../../config/stripe';
import { logger } from '../../config/logger';

export class LicenseController {
    private licenseService: LicenseService;

    constructor() {
        this.licenseService = new LicenseService();
    }

    public getLicense = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const license = await this.licenseService.getLicense(userId);
            res.json(license);
        } catch (error) {
            logger.error('Get license error:', error);
            res.status(400).json({ error: error.message });
        }
    };

    public getPlans = async (_: Request, res: Response) => {
        try {
            res.json(SUBSCRIPTION_PLANS);
        } catch (error) {
            logger.error('Get plans error:', error);
            res.status(500).json({ error: error.message });
        }
    };

    public createSubscription = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const { priceId } = req.body;
            
            const subscription = await this.licenseService.createSubscription(userId, priceId);
            res.json(subscription);
        } catch (error) {
            logger.error('Create subscription error:', error);
            res.status(400).json({ error: error.message });
        }
    };

    public cancelSubscription = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            await this.licenseService.cancelSubscription(userId);
            res.json({ message: 'Subscription cancelled successfully' });
        } catch (error) {
            logger.error('Cancel subscription error:', error);
            res.status(400).json({ error: error.message });
        }
    };
}