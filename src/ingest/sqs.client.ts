import { SQSClient } from '@aws-sdk/client-sqs';
import { IngestConfig } from './ingest.config.js';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

// null si no hay colas: la API arranca igual (rutas HTTP) y avisa que no consume ni publica.
// Las credenciales salen de la cadena por defecto del SDK: variables de entorno en local, el rol
// de la tarea en ECS.
export function createSqsClient(config: IngestConfig): SQSClient | null {
  if (config.inputs.length === 0 && config.outputs.size === 0) {
    return null;
  }
  return new SQSClient({ region: config.region, endpoint: config.endpoint });
}
