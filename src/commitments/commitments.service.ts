import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { updateReturning } from '../common/db.js';
import { toIso } from '../common/serialization.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { EventEnvelope } from '../outbox/event-envelope.js';
import { OutboxService } from '../outbox/outbox.service.js';

export interface ShortageFilters {
  work_order_code?: string;
  part_id?: number;
}

interface ShortageRow {
  work_order_id: number;
  work_order_code: string;
  part_id: number | null;
  name: string;
  missing_quantity: number | null;
  inspection_item_id: number | null;
  opened_at: Date;
}

interface OpenShortage {
  shortage_id: string;
  work_order_id: number;
  code: string;
  missing_quantity: number;
  inspection_item_id: number;
}

@Injectable()
export class CommitmentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
  ) {}

  async listShortages(filters: ShortageFilters) {
    const rows: ShortageRow[] = await this.dataSource.query(
      `SELECT work_order_id, work_order_code, part_id, name, missing_quantity,
              inspection_item_id, opened_at
       FROM v_open_shortages
       WHERE ($1::text IS NULL OR work_order_code = $1)
         AND ($2::int IS NULL OR part_id = $2)
       ORDER BY opened_at, shortage_id`,
      [filters.work_order_code ?? null, filters.part_id ?? null],
    );
    return {
      items: rows.map((row) => ({ ...row, opened_at: toIso(row.opened_at) })),
    };
  }

  async listReorderSuggestions() {
    const items: unknown[] = await this.dataSource.query(
      `SELECT part_id, sku, name, suggested_quantity, work_order_ids
       FROM v_reorder_suggestions
       ORDER BY part_id`,
    );
    return { items };
  }

  // Surte faltantes abiertos de la pieza con lo disponible (regla 12): primero la orden de la
  // compra, si sigue viva, y luego del más antiguo al más nuevo. Cada uno emite
  // `stock.reserved` + `stock.shortage_resolved`. La pieza ya debe estar candada.
  async fillShortages(
    manager: EntityManager,
    partId: number,
    priorityWorkOrderCode: string | null,
  ): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];
    let available = Math.max(
      await this.ledger.availableTotal(manager, partId),
      0,
    );
    if (available === 0) {
      return events;
    }

    const shortages: OpenShortage[] = await manager.query(
      `SELECT s.shortage_id, s.work_order_id, w.code, s.missing_quantity, s.inspection_item_id
       FROM shortage s
       JOIN work_order w ON w.work_order_id = s.work_order_id
       WHERE s.part_id = $1 AND s.status = 'open' AND s.missing_quantity IS NOT NULL
         AND NOT w.deleted
       ORDER BY (w.code = $2) DESC NULLS LAST, s.opened_at, s.shortage_id
       FOR UPDATE OF s`,
      [partId, priorityWorkOrderCode],
    );

    for (const shortage of shortages) {
      if (available === 0) {
        break;
      }
      const fill = Math.min(shortage.missing_quantity, available);
      available -= fill;

      const reservationId = await this.reserve(
        manager,
        shortage.work_order_id,
        partId,
        shortage.inspection_item_id,
        fill,
      );
      await this.ledger.addReserved(manager, partId, fill);
      events.push(
        await this.outbox.enqueue(manager, 'stock.reserved', shortage.code, {
          reservation_id: reservationId,
          work_order_id: shortage.work_order_id,
          part_id: partId,
          quantity: fill,
          inspection_item_id: shortage.inspection_item_id,
        }),
      );

      const remaining = shortage.missing_quantity - fill;
      await manager.query(
        `UPDATE shortage
         SET missing_quantity = $2,
             status = CASE WHEN $2 = 0 THEN 'closed' ELSE status END,
             closed_at = CASE WHEN $2 = 0 THEN now() ELSE closed_at END
         WHERE shortage_id = $1`,
        [shortage.shortage_id, remaining],
      );
      events.push(
        await this.outbox.enqueue(
          manager,
          'stock.shortage_resolved',
          shortage.code,
          {
            work_order_id: shortage.work_order_id,
            part_id: partId,
            quantity: fill,
          },
        ),
      );
    }
    return events;
  }

  // Recalcula la sugerencia de reabasto de la pieza (API README §6.6). Emite
  // `stock.reorder_suggested` solo si nace o cambia. La pieza ya debe estar candada.
  async recomputeSuggestion(
    manager: EntityManager,
    partId: number,
  ): Promise<EventEnvelope | null> {
    const [open]: {
      open_count: number;
      missing: number;
      work_order_ids: number[];
    }[] = await manager.query(
      `SELECT COUNT(*)::int AS open_count,
              COALESCE(SUM(missing_quantity), 0)::int AS missing,
              COALESCE(array_agg(DISTINCT work_order_id ORDER BY work_order_id), '{}') AS work_order_ids
       FROM shortage
       WHERE part_id = $1 AND status = 'open'`,
      [partId],
    );
    const [policy]: {
      min_quantity: number;
      reorder_quantity: number | null;
    }[] = await manager.query(
      'SELECT min_quantity, reorder_quantity FROM reorder_policy WHERE part_id = $1',
      [partId],
    );
    const available = await this.ledger.availableTotal(manager, partId);

    const belowMinimum =
      policy !== undefined && available < policy.min_quantity;
    const suggested =
      open.open_count > 0 || belowMinimum
        ? Math.max(
            open.missing,
            policy?.reorder_quantity ?? 0,
            policy ? policy.min_quantity - available : 0,
          )
        : 0;

    if (suggested < 1) {
      await manager.query('DELETE FROM reorder_suggestion WHERE part_id = $1', [
        partId,
      ]);
      return null;
    }

    const [current]: {
      suggested_quantity: number;
      work_order_ids: number[];
    }[] = await manager.query(
      'SELECT suggested_quantity, work_order_ids FROM reorder_suggestion WHERE part_id = $1',
      [partId],
    );
    const unchanged =
      current !== undefined &&
      current.suggested_quantity === suggested &&
      current.work_order_ids.join(',') === open.work_order_ids.join(',');
    if (unchanged) {
      return null;
    }

    await manager.query(
      `INSERT INTO reorder_suggestion (part_id, suggested_quantity, work_order_ids)
       VALUES ($1, $2, $3)
       ON CONFLICT (part_id) DO UPDATE
         SET suggested_quantity = EXCLUDED.suggested_quantity,
             work_order_ids = EXCLUDED.work_order_ids,
             updated_at = now()`,
      [partId, suggested, open.work_order_ids],
    );
    return this.outbox.enqueue(
      manager,
      'stock.reorder_suggested',
      `part:${partId}`,
      {
        part_id: partId,
        suggested_quantity: suggested,
        work_order_ids: open.work_order_ids,
      },
    );
  }

  // Reserva activa de una orden para una pieza (lo "propio" que puede sacar en `POST /issues`).
  async activeReserved(
    manager: EntityManager,
    workOrderId: number,
    partId: number,
  ): Promise<number> {
    const [row]: { reserved: number }[] = await manager.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS reserved
       FROM reservation
       WHERE work_order_id = $1 AND part_id = $2 AND status = 'active'`,
      [workOrderId, partId],
    );
    return row.reserved;
  }

  // Consume `quantity` de las reservas activas de la orden para la pieza (regla 16). Una reserva
  // entregada completa pasa a `fulfilled`; si se entrega en parte, lo entregado se separa en una
  // fila `fulfilled` para que la necesidad de la línea sepa cuánto ya salió (API README §6.3).
  async consumeReservations(
    manager: EntityManager,
    workOrderId: number,
    partId: number,
    quantity: number,
  ): Promise<void> {
    const reservations: {
      reservation_id: string;
      quantity: number;
      inspection_item_id: number | null;
    }[] = await manager.query(
      `SELECT reservation_id, quantity, inspection_item_id
       FROM reservation
       WHERE work_order_id = $1 AND part_id = $2 AND status = 'active'
       ORDER BY reservation_id
       FOR UPDATE`,
      [workOrderId, partId],
    );

    let remaining = quantity;
    for (const reservation of reservations) {
      if (remaining === 0) {
        break;
      }
      const take = Math.min(remaining, reservation.quantity);
      remaining -= take;
      if (take === reservation.quantity) {
        await manager.query(
          `UPDATE reservation SET status = 'fulfilled', updated_at = now()
           WHERE reservation_id = $1`,
          [reservation.reservation_id],
        );
        continue;
      }
      await manager.query(
        `UPDATE reservation SET quantity = quantity - $2, updated_at = now()
         WHERE reservation_id = $1`,
        [reservation.reservation_id, take],
      );
      await manager.query(
        `INSERT INTO reservation (work_order_id, part_id, inspection_item_id, quantity, status)
         VALUES ($1, $2, $3, $4, 'fulfilled')`,
        [workOrderId, partId, reservation.inspection_item_id, take],
      );
    }
  }

  // Sube la reserva activa de la línea o crea una nueva. Devuelve su id.
  private async reserve(
    manager: EntityManager,
    workOrderId: number,
    partId: number,
    inspectionItemId: number,
    quantity: number,
  ): Promise<number> {
    const updated = await updateReturning<{ reservation_id: string }>(
      manager,
      `UPDATE reservation SET quantity = quantity + $4, updated_at = now()
       WHERE reservation_id = (
         SELECT reservation_id FROM reservation
         WHERE work_order_id = $1 AND part_id = $2 AND inspection_item_id = $3 AND status = 'active'
         ORDER BY reservation_id LIMIT 1)
       RETURNING reservation_id`,
      [workOrderId, partId, inspectionItemId, quantity],
    );
    if (updated.length > 0) {
      return Number(updated[0].reservation_id);
    }
    const [created]: { reservation_id: string }[] = await manager.query(
      `INSERT INTO reservation (work_order_id, part_id, inspection_item_id, quantity)
       VALUES ($1, $2, $3, $4)
       RETURNING reservation_id`,
      [workOrderId, partId, inspectionItemId, quantity],
    );
    return Number(created.reservation_id);
  }
}
