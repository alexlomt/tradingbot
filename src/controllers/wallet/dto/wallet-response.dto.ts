import { ApiProperty } from '@nestjs/swagger';
import { Wallet } from '../../../database/schemas/Wallet.schema';

export class WalletResponseDto {
    @ApiProperty()
    public publicKey: string;

    @ApiProperty()
    public isActive: boolean;

    @ApiProperty()
    public lastUsed: Date;

    @ApiProperty()
    public metadata: {
        name?: string;
        tags?: string[];
        createdFrom?: string;
    };

    @ApiProperty()
    public tradingVolume: number;

    @ApiProperty()
    public dailyTradeCount: number;

    constructor(wallet: Wallet) {
        this.publicKey = wallet.publicKey;
        this.isActive = wallet.isActive;
        this.lastUsed = wallet.lastUsed;
        this.metadata = wallet.metadata;
        this.tradingVolume = wallet.tradingVolume;
        this.dailyTradeCount = wallet.dailyTradeCount;
    }
}
