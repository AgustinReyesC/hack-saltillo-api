import { NotFoundException } from '@nestjs/common';

// El evento referencia algo que todavía no llega (pieza, orden, línea de la lista de partes,
// inspección). No se descarta: queda en `event_inbox` como `failed` y se reintenta (regla 20).
export class MissingDependencyError extends Error {
  constructor(what: string) {
    super(`Falta ${what}`);
    this.name = 'MissingDependencyError';
  }
}

// Un evento anterior con la misma llave sigue pendiente: este espera su turno para respetar el
// orden por llave dentro del tópico.
export class WaitingForPredecessorError extends Error {
  constructor(eventId: string) {
    super(`Espera al evento ${eventId}, anterior con la misma llave`);
    this.name = 'WaitingForPredecessorError';
  }
}

export type FailureKind = 'connection' | 'dependency' | 'transient' | 'error';

// Códigos de Postgres: https://www.postgresql.org/docs/16/errcodes-appendix.html
const FOREIGN_KEY_VIOLATION = '23503';
const TRANSIENT = new Set(['40001', '40P01']); // serialización, deadlock
const CONNECTION = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  '08000',
  '08003',
  '08006',
  '57P01',
  '57P02',
  '57P03',
]);

export function classifyFailure(error: unknown): FailureKind {
  if (
    error instanceof MissingDependencyError ||
    error instanceof WaitingForPredecessorError ||
    // Fuera de HTTP, un 404 de los servicios es algo que no ha llegado (p. ej. la ubicación U-100).
    error instanceof NotFoundException
  ) {
    return 'dependency';
  }
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') {
    if (code === FOREIGN_KEY_VIOLATION) {
      return 'dependency';
    }
    if (TRANSIENT.has(code)) {
      return 'transient';
    }
    if (CONNECTION.has(code)) {
      return 'connection';
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i.test(
      message,
    )
  ) {
    return 'connection';
  }
  return 'error';
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = (error as { detail?: unknown })?.detail;
  return typeof detail === 'string' ? `${message} (${detail})` : message;
}
