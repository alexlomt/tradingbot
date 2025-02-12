import { Request, Response } from 'express';
import { AuthService } from '../../services/auth.service';
import { logger } from '../../config/logger';

export class AuthController {
    private authService: AuthService;

    constructor() {
        this.authService = new AuthService();
    }

    public register = async (req: Request, res: Response) => {
        try {
            const { email, password } = req.body;
            const result = await this.authService.register(email, password);
            res.status(201).json(result);
        } catch (error) {
            logger.error('Registration error:', error);
            res.status(400).json({ error: error.message });
        }
    };

    public login = async (req: Request, res: Response) => {
        try {
            const { email, password } = req.body;
            const result = await this.authService.login(email, password);
            res.json(result);
        } catch (error) {
            logger.error('Login error:', error);
            res.status(401).json({ error: error.message });
        }
    };

    public refreshToken = async (req: Request, res: Response) => {
        try {
            const { refreshToken } = req.body;
            const result = await this.authService.refreshToken(refreshToken);
            res.json(result);
        } catch (error) {
            logger.error('Token refresh error:', error);
            res.status(401).json({ error: error.message });
        }
    };

    public logout = async (req: Request, res: Response) => {
        try {
            const { refreshToken } = req.body;
            await this.authService.logout(refreshToken);
            res.status(200).json({ message: 'Logged out successfully' });
        } catch (error) {
            logger.error('Logout error:', error);
            res.status(400).json({ error: error.message });
        }
    };
}
