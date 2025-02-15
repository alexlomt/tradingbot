import { IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ImportWalletDto {
    @ApiProperty()
    @IsString()
    privateKey: string;

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
