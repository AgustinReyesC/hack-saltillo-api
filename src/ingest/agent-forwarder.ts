import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEnvelope } from '../outbox/event-envelope.js';
import { INGEST_CONFIG, type IngestConfig } from './ingest.config.js';

const TIMEOUT_MS = 5000;

// Flujo "pregunta del agente": el mensaje del usuario llega como evento a `notifications`; la API
// lo guarda y se lo entrega al agente por REST (`POST AGENT_URL` con el sobre). La respuesta del
// agente vuelve por `POST /agent/messages`. Es mejor esfuerzo: si el agente no contesta, el
// evento ya quedó en `event_inbox` y la UI ya lo recibió por WebSocket.
@Injectable()
export class AgentForwarder {
  private readonly logger = new Logger(AgentForwarder.name);

  constructor(@Inject(INGEST_CONFIG) private readonly config: IngestConfig) {}

  async forward(event: EventEnvelope): Promise<void> {
    if (!this.config.agentUrl) {
      return;
    }
    try {
      const response = await fetch(this.config.agentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(
          `El agente respondió ${response.status} al evento ${event.event_id}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `No se pudo entregar el evento ${event.event_id} al agente: ${(error as Error).message}`,
      );
    }
  }
}
