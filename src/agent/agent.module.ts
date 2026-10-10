import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AgentController } from './agent.controller.js';

@Module({
  imports: [RealtimeModule],
  controllers: [AgentController],
})
export class AgentModule {}
