// src/middleware/license.ts
import { Request, Response, NextFunction } from 'express';
import { LicenseService } from '../services/license.service';
import { logger } from '../config/logger';

export const validateLicense = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const userId = req.user!.id;
        const licenseService = new LicenseService();
        
        const license = await licenseService.getLicense(userId);
        if (!license) {
            return res.status(403).json({
                error: 'No active license found'
            });
        }

        if (license.status !== 'active') {
            return res.status(403).json({
                error: 'License is not active'
            });
        }

        // Check bot limits based on license type
        if (req.method === 'POST' && req.path === '/bots') {
            const currentBots = await licenseService.getCurrentBotCount(userId);
            const maxBots = await licenseService.getMaxBots(license.type);
            
            if (currentBots >= maxBots) {
                return res.status(403).json({
                    error: `Maximum number of bots (${maxBots}) reached for your license tier`
                });
            }
        }

        next();
    } catch (error) {
        logger.error('License validation error:', error);
        res.status(500).json({ error: 'License validation failed' });
    }
};