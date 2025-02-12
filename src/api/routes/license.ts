// src/api/routes/license.ts
import { Router } from 'express';
import { LicenseController } from '../controllers/license.controller';
import { authenticateJWT } from '../../middleware/auth';

const router = Router();
const licenseController = new LicenseController();

router.use(authenticateJWT);

router.get('/', licenseController.getLicense);
router.get('/plans', licenseController.getPlans);
router.post('/subscribe', licenseController.createSubscription);
router.post('/cancel', licenseController.cancelSubscription);

export { router as licenseRouter };