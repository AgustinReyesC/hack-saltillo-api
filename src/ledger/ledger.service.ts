import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MovementRow } from '../common/serialization.js';

// Ubicación de recepción U-100: ahí entran las compras.
export const RECEIVING_LOCATION_ID = 100;

// Espacios de llaves de `pg_advisory_xact_lock(int, int)` para no chocar con otros candados
// (el 2 lo usa compras para asignar ids).
const PART_LOCK = 1;
const WORK_ORDER_LOCK = 3;

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
  // Trazabilidad (hack-saltillo-db 012): de dónde sale cada evento de salida.
  workOrderId?: number | null;
  issuedBy?: string | null;
  purchaseLineId?: number | null;
  transferGroupId?: string | null;
}

interface BalanceRow {
  location_id: number;
  on_hand: number;
  reserved: number;
}

// Única puerta para cambiar existencias. `stock_balance.on_hand` lo recalcula el trigger
// `trg_movement_apply_balance` con cada `movement`; la API solo administra `reserved`.
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  // Candados por pieza, en orden ascendente para evitar deadlocks. Duran hasta el COMMIT. Quien
  // toque reservas o faltantes de una pieza los toma antes que cualquier otro candado.
  async lockParts(manager: EntityManager, partIds: number[]): Promise<void> {
    const ids = [...new Set(partIds)].sort((a, b) => a - b);
    for (const id of ids) {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
        PART_LOCK,
        id,
      ]);
    }
  }

  // Candado de una orden de trabajo; siempre después de los de pieza.
  async lockWorkOrder(
    manager: EntityManager,
    workOrderId: number,
  ): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
      WORK_ORDER_LOCK,
      workOrderId,
    ]);
  }

  async addMovement(
    manager: EntityManager,
    movement: NewMovement,
  ): Promise<MovementRow> {
    const [row]: MovementRow[] = await manager.query(
      `INSERT INTO movement
         (type, part_id, location_id, quantity, unit_cost, currency, reference, occurred_at,
          event_id, work_order_id, issued_by, purchase_line_id, transfer_group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()), $9, $10, $11, $12, $13)
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
        movement.workOrderId ?? null,
        movement.issuedBy ?? null,
        movement.purchaseLineId ?? null,
        movement.transferGroupId ?? null,
      ],
    );
    return row;
  }

  // Aparta `quantity` de la pieza. La reserva es de la pieza, no de una ubicación, pero la base
  // exige `reserved <= on_hand` en cada fila de `stock_balance` (trigger
  // `trg_stock_balance_reserved_guard`): se reparte entre las ubicaciones con existencia libre,
  // primero U-100 y luego la de más libre. Quien llama ya comprobó el disponible con la pieza
  // candada, y la suma de lo libre por fila nunca es menor que el disponible total.
  async reserve(
    manager: EntityManager,
    partId: number,
    quantity: number,
  ): Promise<void> {
    if (quantity <= 0) {
      return;
    }
    const rows = (await this.balances(manager, partId))
      .filter((row) => row.on_hand > row.reserved)
      .sort(
        (a, b) =>
          Number(b.location_id === RECEIVING_LOCATION_ID) -
            Number(a.location_id === RECEIVING_LOCATION_ID) ||
          b.on_hand - b.reserved - (a.on_hand - a.reserved) ||
          a.location_id - b.location_id,
      );

    let remaining = quantity;
    for (const row of rows) {
      const take = Math.min(remaining, row.on_hand - row.reserved);
      await this.setReserved(
        manager,
        partId,
        row.location_id,
        row.reserved + take,
      );
      remaining -= take;
      if (remaining === 0) {
        return;
      }
    }
    throw new Error(
      `No hay existencia libre para reservar ${quantity} de la pieza ${partId}`,
    );
  }

  // Devuelve `quantity` apartada de la pieza: primero de las filas que tienen más apartado que
  // existencia (después de una salida o un conteo), luego de las que más tienen.
  async release(
    manager: EntityManager,
    partId: number,
    quantity: number,
  ): Promise<void> {
    if (quantity <= 0) {
      return;
    }
    const rows = (await this.balances(manager, partId))
      .filter((row) => row.reserved > 0)
      .sort(
        (a, b) =>
          b.reserved - b.on_hand - (a.reserved - a.on_hand) ||
          b.reserved - a.reserved,
      );

    let remaining = quantity;
    for (const row of rows) {
      const take = Math.min(remaining, row.reserved);
      await this.setReserved(
        manager,
        partId,
        row.location_id,
        row.reserved - take,
      );
      remaining -= take;
      if (remaining === 0) {
        return;
      }
    }
    // La suma de `reserved` es la proyección de las reservas activas: si no alcanza, la
    // proyección ya venía mal. Se libera lo que hay en lugar de tumbar el evento.
    this.logger.warn(
      `Se liberaron ${quantity - remaining} de ${quantity} apartadas de la pieza ${partId}: no había más en stock_balance`,
    );
  }

  // Tras bajar la existencia de una ubicación (salida, transferencia o conteo), mueve lo
  // apartado de más a ubicaciones con existencia libre, para que cada ubicación muestre un
  // disponible real. Lo que no quepa en ninguna (el conteo dejó menos que lo reservado) se queda.
  async rebalance(manager: EntityManager, partId: number): Promise<void> {
    const rows = await this.balances(manager, partId);
    const over = rows.filter((row) => row.reserved > Math.max(row.on_hand, 0));
    const free = rows.filter((row) => row.on_hand > row.reserved);
    if (over.length === 0 || free.length === 0) {
      return;
    }

    const target = new Map(rows.map((row) => [row.location_id, row.reserved]));
    for (const from of over) {
      let excess = from.reserved - Math.max(from.on_hand, 0);
      for (const to of free) {
        const room = to.on_hand - target.get(to.location_id)!;
        const take = Math.min(excess, room);
        if (take <= 0) {
          continue;
        }
        target.set(to.location_id, target.get(to.location_id)! + take);
        target.set(from.location_id, target.get(from.location_id)! - take);
        excess -= take;
        if (excess === 0) {
          break;
        }
      }
    }
    // Primero las bajas y luego las subidas: así ninguna fila supera su existencia en el camino.
    const changes = rows
      .filter((row) => target.get(row.location_id) !== row.reserved)
      .sort(
        (a, b) =>
          target.get(a.location_id)! -
          a.reserved -
          (target.get(b.location_id)! - b.reserved),
      );
    for (const row of changes) {
      await this.setReserved(
        manager,
        partId,
        row.location_id,
        target.get(row.location_id)!,
      );
    }
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

  private async balances(
    manager: EntityManager,
    partId: number,
  ): Promise<BalanceRow[]> {
    return manager.query(
      `SELECT location_id, on_hand, reserved FROM stock_balance
       WHERE part_id = $1 ORDER BY location_id FOR UPDATE`,
      [partId],
    );
  }

  private async setReserved(
    manager: EntityManager,
    partId: number,
    locationId: number,
    reserved: number,
  ): Promise<void> {
    await manager.query(
      `UPDATE stock_balance SET reserved = $3, updated_at = now()
       WHERE part_id = $1 AND location_id = $2`,
      [partId, locationId, reserved],
    );
  }
}
