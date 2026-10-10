import { HttpStatus, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentModule } from './agent/agent.module.js';
import { CommitmentsModule } from './commitments/commitments.module.js';
import { DetailExceptionFilter } from './common/filters/detail-exception.filter.js';
import { EventsModule } from './events/events.module.js';
import { HealthModule } from './health/health.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { PartInstancesModule } from './part-instances/part-instances.module.js';
import { PartsModule } from './parts/parts.module.js';
import { PurchasingModule } from './purchasing/purchasing.module.js';
import { WorkOrdersModule } from './work-orders/work-orders.module.js';

@Module({
  imports: [
    // El archivo de entorno lo carga el script (`node --env-file`), no ConfigModule.
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('DATABASE_HOST'),
        port: Number(config.getOrThrow<string>('DATABASE_PORT')),
        database: config.getOrThrow<string>('DATABASE_NAME'),
        username: config.getOrThrow<string>('DATABASE_USER'),
        password: config.getOrThrow<string>('DATABASE_PASSWORD'),
        ssl: config.get<string>('DATABASE_SSL') === 'true',
        // El esquema lo crea Liquibase en hack-saltillo-db.
        synchronize: false,
        autoLoadEntities: true,
      }),
    }),
    HealthModule,
    PartsModule,
    PartInstancesModule,
    WorkOrdersModule,
    CommitmentsModule,
    InventoryModule,
    PurchasingModule,
    EventsModule,
    AgentModule,
  ],
  providers: [
    // Globales vía DI (no en main.ts) para que también apliquen en las pruebas e2e.
    { provide: APP_FILTER, useClass: DetailExceptionFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    },
  ],
})
export class AppModule {}
