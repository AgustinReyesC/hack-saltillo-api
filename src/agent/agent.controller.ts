import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AgentMessage } from '../realtime/realtime.gateway.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { AgentLambda } from './agent-lambda.js';
import { AgentMessageDto } from './dto/agent-message.dto.js';
import { ChatMessageDto } from './dto/chat-message.dto.js';

// El agente habla con la API por REST; lo que genera se le reenvía a la UI por WebSocket.
@Controller()
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly realtime: RealtimeGateway,
    private readonly agent: AgentLambda,
  ) {}

  @Post('agent/messages')
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

  // Chat de la UI (`{message}` → `{answer}`): la API le pasa la pregunta a la Lambda del agente.
  @Post('chat')
  @HttpCode(HttpStatus.OK)
  async chat(@Body() body: ChatMessageDto): Promise<{ answer: string }> {
    if (!this.agent.enabled) {
      throw new ServiceUnavailableException('El agente no está configurado');
    }
    try {
      return { answer: await this.agent.ask(body.message) };
    } catch (error) {
      this.logger.warn(`Chat sin respuesta del agente: ${(error as Error).message}`);
      throw new ServiceUnavailableException('El agente no respondió');
    }
  }
}
