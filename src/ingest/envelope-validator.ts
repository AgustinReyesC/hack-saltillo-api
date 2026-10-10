import { Injectable } from '@nestjs/common';
import ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEnvelope } from '../outbox/event-envelope.js';
import { NOTIFICATIONS_TOPIC } from './ingest.config.js';

// ajv y ajv-formats son CommonJS: con `nodenext`, TypeScript ve su `default` como el módulo
// entero; en ejecución llega la clase (o la función) directa o envuelta en `default`.
const Ajv2020 = ((ajv2020 as { default?: unknown }).default ??
  ajv2020) as typeof ajv2020.default;
const addFormats = ((ajvFormats as { default?: unknown }).default ??
  ajvFormats) as typeof ajvFormats.default;

// `contract/schemas` es copia del kit del reto. La ruta sirve igual desde `src/ingest` y desde
// `dist/ingest`: los dos están a dos niveles de la raíz del repo.
const SCHEMAS_DIR = fileURLToPath(
  new URL('../../contract/schemas/', import.meta.url),
);

interface SchemaIndex {
  input: Record<string, { topic: string; schema: string }>;
  output: Record<string, { topic: string; schema: string }>;
}

export type Validation =
  { ok: true; envelope: EventEnvelope } | { ok: false; error: string };

// Sobre de `notifications`: el contrato no define esos eventos, así que solo se revisa el sobre.
const ENVELOPE_SCHEMA = {
  type: 'object',
  required: [
    'event_id',
    'event_type',
    'event_version',
    'occurred_at',
    'source',
    'key',
    'data',
  ],
  properties: {
    event_id: { type: 'string', format: 'uuid' },
    event_type: { type: 'string', minLength: 1 },
    event_version: { type: 'integer' },
    occurred_at: { type: 'string', format: 'date-time' },
    source: { type: 'string' },
    key: { type: 'string', minLength: 1 },
    data: { type: 'object' },
  },
};

// Revisa cada evento de entrada contra su JSON Schema del contrato (`contract/schemas/input`).
@Injectable()
export class EnvelopeValidator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly input = new Map<
    string,
    { topic: string; validate: ValidateFunction }
  >();
  private readonly output = new Map<string, ValidateFunction>();
  private readonly envelope: ValidateFunction;

  constructor() {
    addFormats(this.ajv);
    this.ajv.addSchema(this.read('common.schema.json'));
    const index = this.read('index.json') as SchemaIndex;
    for (const [type, entry] of Object.entries(index.input)) {
      this.input.set(type, {
        topic: entry.topic,
        validate: this.ajv.compile(this.read(entry.schema)),
      });
    }
    for (const [type, entry] of Object.entries(index.output)) {
      this.output.set(type, this.ajv.compile(this.read(entry.schema)));
    }
    this.envelope = this.ajv.compile(ENVELOPE_SCHEMA);
  }

  validate(topic: string, event: unknown): Validation {
    if (topic === NOTIFICATIONS_TOPIC) {
      return this.check(this.envelope, event);
    }
    const type = (event as { event_type?: unknown })?.event_type;
    const entry = typeof type === 'string' ? this.input.get(type) : undefined;
    if (!entry) {
      return { ok: false, error: `event_type desconocido: ${String(type)}` };
    }
    if (entry.topic !== topic) {
      return {
        ok: false,
        error: `${String(type)} llegó por ${topic}; su tópico es ${entry.topic}`,
      };
    }
    return this.check(entry.validate, event);
  }

  // Para las pruebas: revisa un evento de salida contra `contract/schemas/output`.
  validateOutput(event: unknown): string[] {
    const type = (event as { event_type?: unknown })?.event_type;
    const validate =
      typeof type === 'string' ? this.output.get(type) : undefined;
    if (!validate) {
      return [`event_type desconocido: ${String(type)}`];
    }
    return validate(event) ? [] : this.errors(validate);
  }

  private check(validate: ValidateFunction, event: unknown): Validation {
    if (validate(event)) {
      return { ok: true, envelope: event as EventEnvelope };
    }
    return { ok: false, error: this.errors(validate).join('; ') };
  }

  private errors(validate: ValidateFunction): string[] {
    return (validate.errors ?? []).map((error) =>
      `${error.instancePath || '/'} ${error.message ?? ''}`.trim(),
    );
  }

  private read(file: string): object {
    return JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8'));
  }
}
