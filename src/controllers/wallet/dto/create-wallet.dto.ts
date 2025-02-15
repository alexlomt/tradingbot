import { IsOptional, IsString, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWalletDto {
    @ApiProperty({ required: false })
    @IsOptional()
    metadata?: {
        @IsString()
        @IsOptional()
        name?: string;

        @IsArray()
        @IsString({ each: true })
        @IsOptional()
        tags?: string[];
    };
}
