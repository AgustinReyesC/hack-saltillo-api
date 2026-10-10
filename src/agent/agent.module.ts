import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AgentLambda } from './agent-lambda.js';
import { AgentController } from './agent.controller.js';

@Module({
  imports: [RealtimeModule],
  controllers: [AgentController],
  providers: [AgentLambda],
  exports: [AgentLambda],
})
export class AgentModule {}
