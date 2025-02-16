import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MasterKeyService } from './services/encryption/MasterKeyService';
import { KeyManagementService } from './services/encryption/KeyManagementService';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  providers: [
    MasterKeyService,
    KeyManagementService,
  ],
  exports: [
    MasterKeyService,
    KeyManagementService,
  ],
})
export class AppModule {}
