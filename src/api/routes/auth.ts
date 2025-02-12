// src/api/routes/auth.ts
import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { validateRequest } from '../../middleware/validation';
import { loginSchema, registerSchema } from '../schemas/auth.schema';
import { rateLimiter } from '../../middleware/rate-limiter';
import { RATE_LIMITS } from '../../config/constants';

const router = Router();
const authController = new AuthController();

router.post('/register',
    rateLimiter(RATE_LIMITS.LOGIN),
    validateRequest(registerSchema),
    authController.register
);

router.post('/login',
    rateLimiter(RATE_LIMITS.LOGIN),
    validateRequest(loginSchema),
    authController.login
);

router.post('/refresh-token', authController.refreshToken);
router.post('/logout', authController.logout);

export { router as authRouter };