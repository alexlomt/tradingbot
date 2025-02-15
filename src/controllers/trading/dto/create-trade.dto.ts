import { IsString, IsNumber, IsOptional, IsBoolean, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTradeDto {
    @ApiProperty()
    @IsString()
    inputToken: string;

    @ApiProperty()
    @IsString()
    outputToken: string;

    @ApiProperty()
    @IsNumber()
    @Min(0)
    amount: number;

    @ApiProperty()
    @IsString()
    walletPublicKey: string;

    @ApiProperty({ required: false })
    @IsNumber()
    @Min(0)
    @Max(100)
    @IsOptional()
    slippageTolerance?: number = 1; // Default 1%

    @ApiProperty({ required: false })
    @IsBoolean()
    @IsOptional()
    skipPreflight?: boolean = false;

    @ApiProperty({ required: false })
    @IsString()
    @IsOptional()
    referralCode?: string;
}
