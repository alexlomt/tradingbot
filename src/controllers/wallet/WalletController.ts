import { 
    Controller, 
    Post, 
    Get, 
    Body, 
    Param, 
    UseGuards, 
    Req, 
    HttpStatus, 
    Delete,
    Put,
    UseInterceptors,
    RateLimit
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../../guards/auth.guard';
import { SubscriptionGuard } from '../../guards/subscription.guard';
import { RateLimitGuard } from '../../guards/rate-limit.guard';
import { WalletService } from '../../services/wallet/WalletService';
import { LoggingInterceptor } from '../../interceptors/logging.interceptor';
import { CreateWalletDto, ImportWalletDto, UpdateWalletMetadataDto } from './dto';
import { Request } from 'express';
import { WalletResponseDto } from './dto/wallet-response.dto';

@ApiTags('Wallets')
@Controller('api/v1/wallets')
@UseGuards(AuthGuard, SubscriptionGuard)
@UseInterceptors(LoggingInterceptor)
@ApiBearerAuth()
export class WalletController {
    constructor(private readonly walletService: WalletService) {}

    @Post()
    @RateLimit({
        windowMs: 24 * 60 * 60 * 1000, // 24 hours
        max: 3, // Limit each IP to 3 wallet creations per day
        message: 'Too many wallet creation attempts, please try again later'
    })
    @ApiOperation({ summary: 'Create a new wallet' })
    @ApiResponse({ status: HttpStatus.CREATED, type: WalletResponseDto })
    @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid input' })
    @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, description: 'Rate limit exceeded' })
    async createWallet(
        @Req() req: Request,
        @Body() createWalletDto: CreateWalletDto
    ): Promise<WalletResponseDto> {
        const userId = req.user.id;
        const wallet = await this.walletService.createWallet(
            userId,
            createWalletDto.metadata
        );
        
        // Automatically authorize the IP that created the wallet
        await this.walletService.authorizeIp(
            userId,
            wallet.publicKey,
            req.ip
        );

        return new WalletResponseDto(wallet);
    }

    @Post('import')
    @RateLimit({
        windowMs: 24 * 60 * 60 * 1000,
        max: 3,
        message: 'Too many wallet import attempts, please try again later'
    })
    @ApiOperation({ summary: 'Import existing wallet' })
    @ApiResponse({ status: HttpStatus.CREATED, type: WalletResponseDto })
    @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid private key' })
    async importWallet(
        @Req() req: Request,
        @Body() importWalletDto: ImportWalletDto
    ): Promise<WalletResponseDto> {
        const userId = req.user.id;
        const wallet = await this.walletService.importWallet(
            userId,
            importWalletDto.privateKey,
            importWalletDto.metadata
        );

        await this.walletService.authorizeIp(
            userId,
            wallet.publicKey,
            req.ip
        );

        return new WalletResponseDto(wallet);
    }

    @Get()
    @ApiOperation({ summary: 'Get all user wallets' })
    @ApiResponse({ status: HttpStatus.OK, type: [WalletResponseDto] })
    async getUserWallets(@Req() req: Request): Promise<WalletResponseDto[]> {
        const wallets = await this.walletService.getUserWallets(req.user.id);
        return wallets.map(wallet => new WalletResponseDto(wallet));
    }

    @Get(':publicKey')
    @ApiOperation({ summary: 'Get wallet by public key' })
    @ApiResponse({ status: HttpStatus.OK, type: WalletResponseDto })
    @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Wallet not found' })
    async getWallet(
        @Req() req: Request,
        @Param('publicKey') publicKey: string
    ): Promise<WalletResponseDto> {
        const wallet = await this.walletService.getWallet(
            req.user.id,
            publicKey
        );
        return new WalletResponseDto(wallet);
    }

    @Put(':publicKey/metadata')
    @ApiOperation({ summary: 'Update wallet metadata' })
    @ApiResponse({ status: HttpStatus.OK, type: WalletResponseDto })
    @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Wallet not found' })
    async updateWalletMetadata(
        @Req() req: Request,
        @Param('publicKey') publicKey: string,
        @Body() updateDto: UpdateWalletMetadataDto
    ): Promise<WalletResponseDto> {
        const wallet = await this.walletService.updateWalletMetadata(
            req.user.id,
            publicKey,
            updateDto
        );
        return new WalletResponseDto(wallet);
    }

    @Delete(':publicKey')
    @ApiOperation({ summary: 'Deactivate wallet' })
    @ApiResponse({ status: HttpStatus.NO_CONTENT })
    @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Wallet not found' })
    async deactivateWallet(
        @Req() req: Request,
        @Param('publicKey') publicKey: string
    ): Promise<void> {
        await this.walletService.deactivateWallet(
            req.user.id,
            publicKey
        );
    }

    @Post(':publicKey/authorize-ip')
    @ApiOperation({ summary: 'Authorize new IP for wallet access' })
    @ApiResponse({ status: HttpStatus.NO_CONTENT })
    @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Wallet not found' })
    async authorizeNewIp(
        @Req() req: Request,
        @Param('publicKey') publicKey: string,
        @Body('ip') ip: string
    ): Promise<void> {
        await this.walletService.authorizeIp(
            req.user.id,
            publicKey,
            ip
        );
    }
}
