import { 
    Controller, 
    Post, 
    Get, 
    Body, 
    UseGuards, 
    UseInterceptors,
    Req,
    HttpStatus,
    ValidationPipe,
    Query,
    Param,
    Logger
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { RateLimit } from '@nestjs/throttler';
import { AuthGuard } from '../../guards/auth.guard';
import { SubscriptionGuard } from '../../guards/subscription.guard';
import { WalletGuard } from '../../guards/wallet.guard';
import { LoggingInterceptor } from '../../interceptors/logging.interceptor';
import { TransformInterceptor } from '../../interceptors/transform.interceptor';
import { MarketService } from '../../services/market/MarketService';
import { TransactionService } from '../../services/transaction/TransactionService';
import { WalletService } from '../../services/wallet/WalletService';
import { SubscriptionService } from '../../services/subscription/SubscriptionService';
import { 
    CreateTradeDto,
    TradeHistoryQueryDto,
    MarketDataQueryDto,
    TradeResultDto
} from './dto';
import { Request } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';

@ApiTags('Trading')
@Controller('api/v1/trading')
@UseGuards(AuthGuard, SubscriptionGuard, WalletGuard)
@UseInterceptors(LoggingInterceptor, TransformInterceptor)
@ApiBearerAuth()
export class TradingController {
    private readonly logger = new Logger(TradingController.name);

    constructor(
        private readonly marketService: MarketService,
        private readonly transactionService: TransactionService,
        private readonly walletService: WalletService,
        private readonly subscriptionService: SubscriptionService,
        private readonly eventEmitter: EventEmitter2
    ) {}

    @Post('execute')
    @RateLimit({
        windowMs: 1000, // 1 second
        max: 5
    })
    @ApiOperation({ summary: 'Execute a trade' })
    @ApiResponse({ status: HttpStatus.CREATED, type: TradeResultDto })
    async executeTrade(
        @Req() req: Request,
        @Body(new ValidationPipe({ transform: true })) tradeDto: CreateTradeDto
    ): Promise<TradeResultDto> {
        const userId = req.user.id;
        
        // Validate subscription limits
        await this.validateTradingLimits(userId, tradeDto);

        // Get wallet details and validate balance
        const wallet = await this.walletService.getWallet(userId, tradeDto.walletPublicKey);
        await this.validateWalletBalance(wallet, tradeDto);

        try {
            // Get market data and calculate optimal route
            const marketData = await this.marketService.getMarketData(
                tradeDto.inputToken,
                tradeDto.outputToken
            );

            // Prepare and execute transaction
            const transaction = await this.marketService.prepareTradeTransaction(
                tradeDto,
                marketData,
                wallet
            );

            const result = await this.transactionService.sendTransaction(
                transaction,
                {
                    payerPublicKey: tradeDto.walletPublicKey,
                    marketAddress: marketData.address,
                    transactionValue: tradeDto.amount,
                    skipPreflight: tradeDto.skipPreflight,
                    maxRetries: 3
                }
            );

            // Update trading metrics
            await this.updateTradingMetrics(userId, result);

            // Emit trade event for real-time updates
            this.eventEmitter.emit('trade.executed', {
                userId,
                tradeData: tradeDto,
                result
            });

            return new TradeResultDto(result);
        } catch (error) {
            this.logger.error('Trade execution failed', {
                userId,
                tradeDto,
                error
            });
            throw error;
        }
    }

    @Get('markets')
    @ApiOperation({ summary: 'Get market data' })
    @ApiResponse({ status: HttpStatus.OK })
    async getMarketData(
        @Query(new ValidationPipe({ transform: true })) query: MarketDataQueryDto
    ) {
        const marketData = await this.marketService.getMarketData(
            query.inputToken,
            query.outputToken
        );

        const liquidityData = await this.marketService.getLiquidityData(
            query.inputToken,
            query.outputToken
        );

        return {
            price: marketData.price,
            priceChange24h: marketData.priceChange24h,
            volume24h: marketData.volume24h,
            liquidity: liquidityData,
            orderbook: await this.marketService.getOrderbook(marketData.address)
        };
    }

    @Get('history')
    @ApiOperation({ summary: 'Get trading history' })
    @ApiResponse({ status: HttpStatus.OK })
    async getTradingHistory(
        @Req() req: Request,
        @Query(new ValidationPipe({ transform: true })) query: TradeHistoryQueryDto
    ) {
        const userId = req.user.id;
        const history = await this.marketService.getTradingHistory(
            userId,
            query.walletPublicKey,
            {
                startDate: query.startDate,
                endDate: query.endDate,
                limit: query.limit,
                offset: query.offset
            }
        );

        return {
            trades: history.trades,
            totalTrades: history.total,
            totalVolume: history.volume
        };
    }

    @Get('price/:inputToken/:outputToken')
    @ApiOperation({ summary: 'Get token price' })
    @ApiResponse({ status: HttpStatus.OK })
    async getTokenPrice(
        @Param('inputToken') inputToken: string,
        @Param('outputToken') outputToken: string
    ) {
        const price = await this.marketService.getPrice(inputToken, outputToken);
        const priceImpact = await this.marketService.calculatePriceImpact(
            inputToken,
            outputToken,
            1
        );

        return {
            price,
            priceImpact,
            timestamp: new Date()
        };
    }

    private async validateTradingLimits(
        userId: string,
        tradeDto: CreateTradeDto
    ): Promise<void> {
        const subscription = await this.subscriptionService.getUserSubscription(userId);
        
        if (tradeDto.amount > subscription.limits.maxTradeAmount) {
            throw new Error(
                `Trade amount exceeds subscription limit of ${subscription.limits.maxTradeAmount}`
            );
        }

        const dailyTrades = await this.marketService.getDailyTradeCount(userId);
        if (dailyTrades >= subscription.limits.maxDailyTrades) {
            throw new Error(
                `Daily trade limit of ${subscription.limits.maxDailyTrades} reached`
            );
        }
    }

    private async validateWalletBalance(wallet: any, tradeDto: CreateTradeDto): Promise<void> {
        const balance = await this.walletService.getTokenBalance(
            wallet.publicKey,
            tradeDto.inputToken
        );

        if (balance < tradeDto.amount) {
            throw new Error('Insufficient balance for trade');
        }
    }

    private async updateTradingMetrics(
        userId: string,
        tradeResult: any
    ): Promise<void> {
        await Promise.all([
            this.marketService.updateTradingMetrics(userId, tradeResult),
            this.walletService.updateWalletMetrics(userId, tradeResult)
        ]);
    }
}
