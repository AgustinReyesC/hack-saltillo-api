import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { EventEnvelope } from '../outbox/event-envelope.js';

export interface AgentMessage {
  message: string;
  data: Record<string, unknown> | null;
  received_at: string;
}

// Servidor de WebSocket con la UI (socket.io, mismos puertos que HTTP y HTTPS). Este gateway solo
// emite; los mensajes que manda la UI los atienden los gateways de cada módulo (p. ej. `parts:list`).
// El CORS y los servidores los fija `MultiServerIoAdapter` en main.ts.
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private readonly server?: Server;

  handleConnection(client: Socket): void {
    this.logger.debug(`UI conectada: ${client.id}`);
  }

  // Se llama después del COMMIT: una transacción revertida no notifica nada.
  notify(events: EventEnvelope[]): void {
    for (const event of events) {
      this.server?.emit('notification', event);
    }
  }

  sendAgentMessage(message: AgentMessage): void {
    this.server?.emit('agent:message', message);
  }
}
