import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MovementRow } from '../common/serialization.js';

// Ubicación de recepción U-100: ahí entran las compras y ahí se anota toda la reserva de una pieza.
export const RECEIVING_LOCATION_ID = 100;

// Espacio de llaves de `pg_advisory_xact_lock(int, int)` para no chocar con otros candados.
const PART_LOCK = 1;

export type MovementType =
  'receipt' | 'issue' | 'transfer_out' | 'transfer_in' | 'adjustment';

export interface NewMovement {
  type: MovementType;
  partId: number;
  locationId: number;
  quantity: number;
  reference: string | null;
  eventId: string;
  occurredAt?: Date | string;
  unitCost?: string | null;
  currency?: string | null;
}

// Única puerta para cambiar existencias: cada variación es un `movement` y su `stock_balance`.
@Injectable()
export class LedgerService {
  // Candados por pieza, en orden ascendente para evitar deadlocks. Duran hasta el COMMIT.
  async lockParts(manager: EntityManager, partIds: number[]): Promise<void> {
    const ids = [...new Set(partIds)].sort((a, b) => a - b);
    for (const id of ids) {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
        PART_LOCK,
        id,
      ]);
    }
  }

  async addMovement(
    manager: EntityManager,
    movement: NewMovement,
  ): Promise<MovementRow> {
    const [row]: MovementRow[] = await manager.query(
      `INSERT INTO movement
         (type, part_id, location_id, quantity, unit_cost, currency, reference, occurred_at, event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()), $9)
       RETURNING movement_id, type, part_id, location_id, quantity, occurred_at, reference`,
      [
        movement.type,
        movement.partId,
        movement.locationId,
        movement.quantity,
        movement.unitCost ?? null,
        movement.currency ?? null,
        movement.reference,
        movement.occurredAt ?? null,
        movement.eventId,
      ],
    );
    await manager.query(
      `INSERT INTO stock_balance (part_id, location_id, on_hand)
       VALUES ($1, $2, $3)
       ON CONFLICT (part_id, location_id)
       DO UPDATE SET on_hand = stock_balance.on_hand + EXCLUDED.on_hand, updated_at = now()`,
      [movement.partId, movement.locationId, movement.quantity],
    );
    return row;
  }

  // La reserva no tiene ubicación: se anota en la fila de U-100 de la pieza (API README §6.7).
  async addReserved(
    manager: EntityManager,
    partId: number,
    delta: number,
  ): Promise<void> {
    if (delta === 0) {
      return;
    }
    await manager.query(
      `INSERT INTO stock_balance (part_id, location_id, on_hand, reserved)
       VALUES ($1, $2, 0, $3)
       ON CONFLICT (part_id, location_id)
       DO UPDATE SET reserved = stock_balance.reserved + EXCLUDED.reserved, updated_at = now()`,
      [partId, RECEIVING_LOCATION_ID, delta],
    );
  }

  async onHandAt(
    manager: EntityManager,
    partId: number,
    locationId: number,
  ): Promise<number> {
    const rows: { on_hand: number }[] = await manager.query(
      'SELECT on_hand FROM stock_balance WHERE part_id = $1 AND location_id = $2',
      [partId, locationId],
    );
    return rows[0]?.on_hand ?? 0;
  }

  // Disponible total de la pieza en todas las ubicaciones. Puede ser negativo tras un conteo.
  async availableTotal(
    manager: EntityManager,
    partId: number,
  ): Promise<number> {
    const [row]: { available: number }[] = await manager.query(
      `SELECT (COALESCE(SUM(on_hand), 0) - COALESCE(SUM(reserved), 0))::int AS available
       FROM stock_balance WHERE part_id = $1`,
      [partId],
    );
    return row.available;
  }

  async assertPartsExist(
    manager: EntityManager,
    partIds: number[],
  ): Promise<void> {
    const ids = [...new Set(partIds)];
    const rows: { part_id: number }[] = await manager.query(
      'SELECT part_id FROM part WHERE part_id = ANY($1::int[])',
      [ids],
    );
    const found = new Set(rows.map((row) => row.part_id));
    const missing = ids.find((id) => !found.has(id));
    if (missing !== undefined) {
      throw new NotFoundException(`Part ${missing} not found`);
    }
  }

  async assertLocationExists(
    manager: EntityManager,
    locationId: number,
  ): Promise<void> {
    const rows: unknown[] = await manager.query(
      'SELECT 1 FROM location WHERE location_id = $1',
      [locationId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`Location ${locationId} not found`);
    }
  }
}
