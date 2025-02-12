// src/api/routes/bots.ts
import { Router } from 'express';
import { BotController } from '../controllers/bot.controller';
import { authenticateJWT } from '../../middleware/auth';
import { validateLicense } from '../../middleware/license';
import { validateRequest } from '../../middleware/validation';
import { createBotSchema, updateBotSchema } from '../schemas/bot.schema';

const router = Router();
const botController = new BotController();

router.use(authenticateJWT);
router.use(validateLicense);

router.post('/',
    validateRequest(createBotSchema),
    botController.createBot
);

router.get('/', botController.getUserBots);
router.get('/:botId', botController.getBotStatus);
router.put('/:botId', validateRequest(updateBotSchema), botController.updateBot);
router.post('/:botId/start', botController.startBot);
router.post('/:botId/stop', botController.stopBot);
router.get('/:botId/metrics', botController.getBotMetrics);

export { router as botRouter };