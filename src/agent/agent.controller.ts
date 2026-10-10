import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { AgentMessage } from '../realtime/realtime.gateway.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { AgentMessageDto } from './dto/agent-message.dto.js';

// El agente habla con la API por REST; lo que genera se le reenvía a la UI por WebSocket.
@Controller('agent')
export class AgentController {
  constructor(private readonly realtime: RealtimeGateway) {}

  @Post('messages')
  @HttpCode(HttpStatus.ACCEPTED)
  sendMessage(@Body() body: AgentMessageDto): AgentMessage {
    const message: AgentMessage = {
      message: body.message,
      data: body.data ?? null,
      received_at: new Date().toISOString(),
    };
    this.realtime.sendAgentMessage(message);
    return message;
  }
}
