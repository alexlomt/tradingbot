// src/websocket/message-handler.ts
import { BotManagerService } from '../services/bot-manager.service';
import { logger } from '../config/logger';

export class WebSocketMessageHandler {
    private botManager: BotManagerService;

    constructor() {
        this.botManager = new BotManagerService();
    }

    async handleMessage(userId: string, message: any) {
        switch (message.type) {
            case 'subscribe':
                await this.handleSubscribe(userId, message.data);
                break;

            case 'botCommand':
                await this.handleBotCommand(userId, message.data);
                break;

            default:
                logger.warn('Unknown message type:', message.type);
        }
    }

    private async handleSubscribe(userId: string, data: any) {
        const { botId } = data;
        await this.botManager.subscribeToBotUpdates(userId, botId);
    }

    private async handleBotCommand(userId: string, data: any) {
        const { botId, command, params } = data;
        
        switch (command) {
            case 'start':
                await this.botManager.startBot(userId, botId);
                break;

            case 'stop':
                await this.botManager.stopBot(userId, botId);
                break;

            case 'updateConfig':
                await this.botManager.updateBot(userId, botId, params);
                break;

            default:
                logger.warn('Unknown bot command:', command);
        }
    }

    async getInitialState(userId: string) {
        try {
            const bots = await this.botManager.getUserBots(userId);
            const botsWithStatus = await Promise.all(
                bots.map(async (bot) => ({
                    ...bot.toObject(),
                    status: await this.botManager.getBotStatus(userId, bot.id)
                }))
            );

            return {
                bots: botsWithStatus
            };
        } catch (error) {
            logger.error('Error getting initial state:', error);
            throw error;
        }
    }
}
