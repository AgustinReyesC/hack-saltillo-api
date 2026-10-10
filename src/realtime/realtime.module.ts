import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';

@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
