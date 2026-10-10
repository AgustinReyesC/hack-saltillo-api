import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { EventEnvelope } from '../outbox/event-envelope.js';

// El agente (`hack-saltillo-events`) es una Lambda sin URL pública: la API la invoca con el rol de
// la tarea de ECS (`lambda:InvokeFunction`). `AGENT_FUNCTION_NAME` vacía = no hay agente.
@Injectable()
export class AgentLambda {
  private readonly functionName: string | undefined;
  private readonly client: LambdaClient | undefined;

  constructor(config: ConfigService) {
    this.functionName =
      config.get<string>('AGENT_FUNCTION_NAME')?.trim() || undefined;
    this.client = this.functionName
      ? new LambdaClient({ region: config.get<string>('AWS_REGION') })
      : undefined;
  }

  get enabled(): boolean {
    return this.client !== undefined;
  }

  // Pregunta del chat de la UI: espera la respuesta del agente.
  async ask(message: string): Promise<string> {
    const result = await this.invoke({ action: 'chat', message }, false);
    const answer = (result as { answer?: unknown } | null)?.answer;
    if (typeof answer !== 'string') {
      throw new Error('El agente no devolvió una respuesta');
    }
    return answer;
  }

  // Evento de `notifications`: se entrega sin esperar; el agente contesta por POST /agent/messages.
  async notify(event: EventEnvelope): Promise<void> {
    await this.invoke({ action: 'notification', event }, true);
  }

  private async invoke(payload: unknown, async: boolean): Promise<unknown> {
    if (!this.client || !this.functionName) {
      throw new Error('AGENT_FUNCTION_NAME no está configurada');
    }
    const response = await this.client.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        InvocationType: async ? 'Event' : 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    if (response.FunctionError) {
      throw new Error(`El agente falló: ${response.FunctionError}`);
    }
    if (async || !response.Payload) {
      return null;
    }
    return JSON.parse(Buffer.from(response.Payload).toString('utf8'));
  }
}
