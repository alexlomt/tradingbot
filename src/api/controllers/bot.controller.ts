import { Request, Response } from 'express';
import { BotManagerService } from '../../services/bot-manager.service';
import { logger } from '../../config/logger';

export class BotController {
    private botManager: BotManagerService;

    constructor() {
        this.botManager = new BotManagerService();
    }

    public createBot = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const config = req.body;
            
            const bot = await this.botManager.createBot(userId, config);
            res.status(201).json(bot);
        } catch (error) {
            logger.error('Bot creation error:', error);
            res.status(400).json({ error: error.message });
        }
    };

    public getUserBots = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const bots = await this.botManager.getUserBots(userId);
            res.json(bots);
        } catch (error) {
            logger.error('Get user bots error:', error);
            res.status(500).json({ error: error.message });
        }
    };

    public getBotStatus = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const { botId } = req.params;
            
            const status = await this.botManager.getBotStatus(userId, botId);
            res.json(status);
        } catch (error) {
            logger.error('Get bot status error:', error);
            res.status(400).json({ error: error.message });
        }
    };

    public updateBot = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const { botId } = req.params;
            const config = req.body;
            
            const updatedBot = await this.botManager.updateBot(userId, botId, config);
            res.json(updatedBot);
        } catch (error) {
            logger.error('Bot update error:', error);
            res.status(400).json({ error: error.message });
        }
    };

    public startBot = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const { botId } = req.params;
            
            await this.botManager.startBot(userId, botId);
            res.json({ message: 'Bot started successfully' });
        } catch (error) {
            logger.error('Bot start error:', error);
            res.status(400).json({ error: error.message });
        }
    };

    public stopBot = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const { botId } = req.params;
            
            await this.botManager.stopBot(userId, botId);
            res.json({ message: 'Bot stopped successfully' });
        } catch (error) {
            logger.error('Bot stop error:', error);
            res.status(400).json({ error: error.message });
        }
    };

    public getBotMetrics = async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const { botId } = req.params;
            
            const metrics = await this.botManager.getBotMetrics(userId, botId);
            res.json(metrics);
        } catch (error) {
            logger.error('Get bot metrics error:', error);
            res.status(400).json({ error: error.message });
        }
    };
}