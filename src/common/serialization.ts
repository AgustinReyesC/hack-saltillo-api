// `pg` entrega BIGINT/BIGSERIAL y los SUM/COUNT como texto: se convierten a número para responder.
export function toInt(value: string | number): number;
export function toInt(value: string | number | null): number | null;
export function toInt(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

// TIMESTAMPTZ llega como Date; el contrato pide ISO 8601 en UTC terminado en Z.
export function toIso(value: Date | string): string;
export function toIso(value: Date | string | null): string | null;
export function toIso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export interface MovementRow {
  movement_id: string | number;
  type: string;
  part_id: number;
  location_id: number;
  quantity: number;
  occurred_at: Date | string;
  reference: string | null;
}

export interface Movement {
  movement_id: number;
  type: string;
  part_id: number;
  location_id: number;
  quantity: number;
  occurred_at: string;
  reference: string | null;
}

export function toMovement(row: MovementRow): Movement {
  return {
    movement_id: toInt(row.movement_id),
    type: row.type,
    part_id: row.part_id,
    location_id: row.location_id,
    quantity: row.quantity,
    occurred_at: toIso(row.occurred_at),
    reference: row.reference,
  };
}
