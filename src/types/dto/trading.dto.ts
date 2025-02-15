import { 
    IsString, 
    IsNumber, 
    IsOptional, 
    IsBoolean, 
    IsEnum, 
    IsArray, 
    IsDateString, 
    Min, 
    Max, 
    ValidateNested 
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export enum OrderType {
    MARKET = 'MARKET',
    LIMIT = 'LIMIT',
    STOP_LOSS = 'STOP_LOSS',
    TAKE_PROFIT = 'TAKE_PROFIT',
    DCA = 'DCA'
}

export enum OrderSide {
    BUY = 'BUY',
    SELL = 'SELL'
}

export enum TimeInForce {
    GTC = 'GTC', // Good Till Cancel
    IOC = 'IOC', // Immediate or Cancel
    FOK = 'FOK'  // Fill or Kill
}

export class TradeSettingsDto {
    @ApiProperty()
    @IsNumber()
    @Min(0)
    @Max(100)
    slippageTolerance: number;

    @ApiProperty()
    @IsNumber()
    @Min(0)
    deadline: number;

    @ApiProperty()
    @IsBoolean()
    @IsOptional()
    useSmartRouting?: boolean = true;

    @ApiProperty()
    @IsBoolean()
    @IsOptional()
    enableMEVProtection?: boolean = true;
}

export class OrderParamsDto {
    @ApiProperty({ enum: OrderType })
    @IsEnum(OrderType)
    type: OrderType;

    @ApiProperty({ enum: OrderSide })
    @IsEnum(OrderSide)
    side: OrderSide;

    @ApiProperty({ enum: TimeInForce })
    @IsEnum(TimeInForce)
    @IsOptional()
    timeInForce?: TimeInForce = TimeInForce.GTC;

    @ApiProperty()
    @IsNumber()
    @Min(0)
    price?: number;

    @ApiProperty()
    @IsNumber()
    @Min(0)
    @IsOptional()
    stopPrice?: number;
}

export class DCAParamsDto {
    @ApiProperty()
    @IsNumber()
    @Min(1)
    intervals: number;

    @ApiProperty()
    @IsNumber()
    @Min(0)
    intervalHours: number;

    @ApiProperty()
    @IsNumber()
    @Min(0)
    amountPerInterval: number;
}

export class CreateTradeDto {
    @ApiProperty()
    @IsString()
    inputToken: string;

    @ApiProperty()
    @IsString()
    outputToken: string;

    @ApiProperty()
    @IsString()
    walletPublicKey: string;

    @ApiProperty()
    @IsNumber()
    @Min(0)
    amount: number;

    @ApiProperty()
    @ValidateNested()
    @Type(() => OrderParamsDto)
    orderParams: OrderParamsDto;

    @ApiProperty()
    @ValidateNested()
    @Type(() => TradeSettingsDto)
    settings: TradeSettingsDto;

    @ApiProperty()
    @ValidateNested()
    @Type(() => DCAParamsDto)
    @IsOptional()
    dcaParams?: DCAParamsDto;

    @ApiProperty()
    @IsString()
    @IsOptional()
    referralCode?: string;
}

export class TradeHistoryQueryDto {
    @ApiProperty()
    @IsString()
    @IsOptional()
    walletPublicKey?: string;

    @ApiProperty()
    @IsDateString()
    @IsOptional()
    startDate?: string;

    @ApiProperty()
    @IsDateString()
    @IsOptional()
    endDate?: string;

    @ApiProperty()
    @IsNumber()
    @Min(1)
    @Max(100)
    @IsOptional()
    limit?: number = 50;

    @ApiProperty()
    @IsNumber()
    @Min(0)
    @IsOptional()
    offset?: number = 0;

    @ApiProperty({ enum: OrderType })
    @IsEnum(OrderType)
    @IsOptional()
    orderType?: OrderType;

    @ApiProperty({ enum: OrderSide })
    @IsEnum(OrderSide)
    @IsOptional()
    orderSide?: OrderSide;
}
