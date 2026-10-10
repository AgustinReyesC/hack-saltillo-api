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

export interface WorkOrderRef {
  work_order_id: number;
  code: string;
}

// Renglón de una inspección aprobada (contrato: `inspection.approved.items[]`).
export interface ApprovedItem {
  inspection_item_id: number;
  bom_line_id: number;
  part_id: number | null;
  name: string;
  action: 'buy' | 'repair' | null;
  quantity: number | null;
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

// Reservas, faltantes y sugerencias de reabasto. Todo método que cambia reservas espera la pieza
// candada (`LedgerService.lockParts`); los que reciben una orden completa toman ellos los candados.
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

  // Reglas 2 a 8: cada renglón `buy` de una aprobación fija la necesidad de su línea
  // (orden, bom_line_id) en `work_order_need` y la REEMPLAZA. Si sube se reserva la diferencia
  // con lo disponible y lo que no alcance es faltante; si baja se libera el excedente. Las
  // líneas que la aprobación no menciona conservan su necesidad (una `full` con `items: []` no
  // cambia nada). `repair` y `ok` no generan necesidad.
  async applyApproval(
    manager: EntityManager,
    workOrder: WorkOrderRef,
    items: ApprovedItem[],
  ): Promise<EventEnvelope[]> {
    const buys = items
      .filter((item) => item.action === 'buy')
      .sort((a, b) => a.bom_line_id - b.bom_line_id);
    if (buys.length === 0) {
      return [];
    }

    const lineIds = buys.map((item) => item.bom_line_id);
    const previous: { bom_line_id: number; part_id: number | null }[] =
      await manager.query(
        `SELECT bom_line_id, part_id FROM work_order_need
         WHERE work_order_id = $1 AND bom_line_id = ANY($2::int[])`,
        [workOrder.work_order_id, lineIds],
      );
    const previousPart = new Map(
      previous.map((need) => [need.bom_line_id, need.part_id]),
    );
    await this.ledger.lockParts(
      manager,
      [...buys.map((item) => item.part_id), ...previousPart.values()].filter(
        (id): id is number => id !== null,
      ),
    );
    await this.ledger.lockWorkOrder(manager, workOrder.work_order_id);

    const qtyRows: { bom_line_id: number; qty_per_unit: number | null }[] =
      await manager.query(
        'SELECT bom_line_id, qty_per_unit FROM model_line WHERE bom_line_id = ANY($1::int[])',
        [lineIds],
      );
    const qtyPerUnit = new Map(
      qtyRows.map((row) => [row.bom_line_id, row.qty_per_unit]),
    );

    const events: EventEnvelope[] = [];
    const touched = new Set<number>();
    for (const item of buys) {
      // Regla 5: sin cantidad se usa la de la lista de partes; si tampoco hay, queda en null.
      const need = item.quantity ?? qtyPerUnit.get(item.bom_line_id) ?? null;
      const line = item.bom_line_id;

      // Si la línea cambió de pieza, lo apartado para la anterior ya no le sirve.
      const oldPart = previousPart.get(line);
      if (oldPart !== undefined && oldPart !== item.part_id) {
        await this.releaseLine(manager, workOrder.work_order_id, line);
        if (oldPart !== null) {
          touched.add(oldPart);
        }
      }

      await manager.query(
        `INSERT INTO work_order_need
           (work_order_id, bom_line_id, part_id, quantity, inspection_item_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (work_order_id, bom_line_id) DO UPDATE
           SET part_id = EXCLUDED.part_id, quantity = EXCLUDED.quantity,
               inspection_item_id = EXCLUDED.inspection_item_id, updated_at = now()`,
        [
          workOrder.work_order_id,
          line,
          item.part_id,
          need,
          item.inspection_item_id,
        ],
      );
      // Reservas y faltantes de la línea apuntan al renglón vigente: así `voided` sabe de qué
      // inspección vino la necesidad.
      await this.repointLine(
        manager,
        workOrder.work_order_id,
        line,
        item.inspection_item_id,
      );

      // Regla 6 y regla 5 sin cantidad: faltante sin reservar nada.
      if (item.part_id === null || need === null) {
        if (item.part_id !== null) {
          await this.releaseLine(manager, workOrder.work_order_id, line);
          touched.add(item.part_id);
        }
        events.push(
          ...(await this.setShortage(manager, workOrder, item, need)),
        );
        continue;
      }

      const { active, fulfilled } = await this.lineReservations(
        manager,
        workOrder.work_order_id,
        line,
        item.part_id,
      );
      // Lo ya entregado de la línea cuenta para la necesidad.
      const rest = Math.max(need - fulfilled, 0);
      let missing = 0;
      if (rest < active) {
        await this.releaseLineQuantity(
          manager,
          workOrder.work_order_id,
          line,
          item.part_id,
          active - rest,
        );
      } else {
        const available = Math.max(
          await this.ledger.availableTotal(manager, item.part_id),
          0,
        );
        const grant = Math.min(rest - active, available);
        if (grant > 0) {
          events.push(
            await this.reserveFor(
              manager,
              workOrder,
              item.part_id,
              item.inspection_item_id,
              grant,
            ),
          );
        }
        missing = rest - active - grant;
      }
      events.push(
        ...(await this.setShortage(manager, workOrder, item, missing)),
      );
      touched.add(item.part_id);
    }

    events.push(...(await this.recomputeSuggestions(manager, [...touched])));
    return events;
  }

  // Regla 13: libera las reservas activas y cierra los faltantes de las líneas cuya necesidad
  // vigente venía de esa inspección. La necesidad de esas líneas se borra: la orden regresó de
  // etapa y la siguiente aprobación la vuelve a fijar.
  async releaseInspection(
    manager: EntityManager,
    workOrder: WorkOrderRef,
    inspectionId: number,
  ): Promise<EventEnvelope[]> {
    const lines: { bom_line_id: number; part_id: number | null }[] =
      await manager.query(
        `SELECT n.bom_line_id, n.part_id
         FROM work_order_need n
         JOIN inspection_item ii ON ii.inspection_item_id = n.inspection_item_id
         WHERE n.work_order_id = $1 AND ii.inspection_id = $2`,
        [workOrder.work_order_id, inspectionId],
      );
    if (lines.length === 0) {
      return [];
    }
    const partIds = await this.linePartIds(
      manager,
      workOrder.work_order_id,
      lines.map((line) => line.bom_line_id),
    );
    await this.ledger.lockParts(manager, partIds);
    await this.ledger.lockWorkOrder(manager, workOrder.work_order_id);

    for (const line of lines) {
      await this.releaseLine(
        manager,
        workOrder.work_order_id,
        line.bom_line_id,
      );
      await this.closeLineShortages(
        manager,
        workOrder.work_order_id,
        line.bom_line_id,
      );
    }
    await manager.query(
      'DELETE FROM work_order_need WHERE work_order_id = $1 AND bom_line_id = ANY($2::int[])',
      [workOrder.work_order_id, lines.map((line) => line.bom_line_id)],
    );
    return this.recomputeSuggestions(manager, partIds);
  }

  // Regla 14: libera todas las reservas activas de la orden y cierra sus faltantes.
  async releaseWorkOrder(
    manager: EntityManager,
    workOrder: WorkOrderRef,
  ): Promise<EventEnvelope[]> {
    const parts: { part_id: number }[] = await manager.query(
      `SELECT part_id FROM reservation WHERE work_order_id = $1 AND status = 'active'
       UNION
       SELECT part_id FROM shortage
       WHERE work_order_id = $1 AND status = 'open' AND part_id IS NOT NULL`,
      [workOrder.work_order_id],
    );
    const partIds = parts.map((row) => row.part_id);
    await this.ledger.lockParts(manager, partIds);
    await this.ledger.lockWorkOrder(manager, workOrder.work_order_id);

    const released = await updateReturning<{
      part_id: number;
      quantity: number;
    }>(
      manager,
      `UPDATE reservation SET status = 'cancelled', updated_at = now()
       WHERE work_order_id = $1 AND status = 'active'
       RETURNING part_id, quantity`,
      [workOrder.work_order_id],
    );
    await this.releaseByPart(manager, released);
    await manager.query(
      `UPDATE shortage SET status = 'closed', closed_at = now()
       WHERE work_order_id = $1 AND status = 'open'`,
      [workOrder.work_order_id],
    );
    return this.recomputeSuggestions(manager, partIds);
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

      events.push(
        await this.reserveFor(
          manager,
          { work_order_id: shortage.work_order_id, code: shortage.code },
          partId,
          shortage.inspection_item_id,
          fill,
        ),
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

  async recomputeSuggestions(
    manager: EntityManager,
    partIds: number[],
  ): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];
    for (const partId of new Set(partIds)) {
      const suggestion = await this.recomputeSuggestion(manager, partId);
      if (suggestion) {
        events.push(suggestion);
      }
    }
    return events;
  }

  // Recalcula la sugerencia de reabasto de la pieza (regla 18). Emite `stock.reorder_suggested`
  // solo si nace o cambia. La pieza ya debe estar candada.
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
  // fila `fulfilled` para que la necesidad de la línea sepa cuánto ya salió.
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

  // Aparta `quantity` para la orden (crea o sube su reserva activa de esa línea) y emite
  // `stock.reserved` con lo apartado en este paso.
  private async reserveFor(
    manager: EntityManager,
    workOrder: WorkOrderRef,
    partId: number,
    inspectionItemId: number,
    quantity: number,
  ): Promise<EventEnvelope> {
    const reservationId = await this.upsertReservation(
      manager,
      workOrder.work_order_id,
      partId,
      inspectionItemId,
      quantity,
    );
    await this.ledger.reserve(manager, partId, quantity);
    return this.outbox.enqueue(manager, 'stock.reserved', workOrder.code, {
      reservation_id: reservationId,
      work_order_id: workOrder.work_order_id,
      part_id: partId,
      quantity,
      inspection_item_id: inspectionItemId,
    });
  }

  // Sube la reserva activa de la línea o crea una nueva. Devuelve su id.
  private async upsertReservation(
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

  // Un solo faltante abierto por línea. `missing` 0 lo cierra (sin evento); un faltante nuevo o
  // con otra cantidad emite `stock.shortage_detected`.
  private async setShortage(
    manager: EntityManager,
    workOrder: WorkOrderRef,
    item: ApprovedItem,
    missing: number | null,
  ): Promise<EventEnvelope[]> {
    const open: {
      shortage_id: string;
      part_id: number | null;
      missing_quantity: number | null;
    }[] = await manager.query(
      `SELECT s.shortage_id, s.part_id, s.missing_quantity
       FROM shortage s
       JOIN inspection_item ii ON ii.inspection_item_id = s.inspection_item_id
       WHERE s.work_order_id = $1 AND ii.bom_line_id = $2 AND s.status = 'open'
       ORDER BY s.shortage_id
       FOR UPDATE OF s`,
      [workOrder.work_order_id, item.bom_line_id],
    );
    const [current, ...extra] = open;
    if (extra.length > 0) {
      await this.closeShortages(
        manager,
        extra.map((row) => row.shortage_id),
      );
    }

    if (missing === 0) {
      if (current) {
        await this.closeShortages(manager, [current.shortage_id]);
      }
      return [];
    }
    if (
      current &&
      current.part_id === item.part_id &&
      current.missing_quantity === missing
    ) {
      return [];
    }
    if (current) {
      await manager.query(
        `UPDATE shortage SET part_id = $2, name = $3, missing_quantity = $4, inspection_item_id = $5
         WHERE shortage_id = $1`,
        [
          current.shortage_id,
          item.part_id,
          item.name,
          missing,
          item.inspection_item_id,
        ],
      );
    } else {
      await manager.query(
        `INSERT INTO shortage (work_order_id, part_id, name, missing_quantity, inspection_item_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          workOrder.work_order_id,
          item.part_id,
          item.name,
          missing,
          item.inspection_item_id,
        ],
      );
    }
    return [
      await this.outbox.enqueue(
        manager,
        'stock.shortage_detected',
        workOrder.code,
        {
          work_order_id: workOrder.work_order_id,
          part_id: item.part_id,
          name: item.name,
          missing_quantity: missing,
          inspection_item_id: item.inspection_item_id,
        },
      ),
    ];
  }

  private async closeShortages(
    manager: EntityManager,
    shortageIds: string[],
  ): Promise<void> {
    await manager.query(
      `UPDATE shortage SET status = 'closed', closed_at = now()
       WHERE shortage_id = ANY($1::bigint[])`,
      [shortageIds],
    );
  }

  private async closeLineShortages(
    manager: EntityManager,
    workOrderId: number,
    bomLineId: number,
  ): Promise<void> {
    await manager.query(
      `UPDATE shortage s SET status = 'closed', closed_at = now()
       FROM inspection_item ii
       WHERE ii.inspection_item_id = s.inspection_item_id
         AND s.work_order_id = $1 AND ii.bom_line_id = $2 AND s.status = 'open'`,
      [workOrderId, bomLineId],
    );
  }

  private async repointLine(
    manager: EntityManager,
    workOrderId: number,
    bomLineId: number,
    inspectionItemId: number,
  ): Promise<void> {
    for (const table of ['reservation', 'shortage'] as const) {
      const status = table === 'reservation' ? 'active' : 'open';
      await manager.query(
        `UPDATE ${table} t SET inspection_item_id = $3
         FROM inspection_item ii
         WHERE ii.inspection_item_id = t.inspection_item_id
           AND t.work_order_id = $1 AND ii.bom_line_id = $2
           AND t.status = '${status}' AND t.inspection_item_id <> $3`,
        [workOrderId, bomLineId, inspectionItemId],
      );
    }
  }

  private async lineReservations(
    manager: EntityManager,
    workOrderId: number,
    bomLineId: number,
    partId: number,
  ): Promise<{ active: number; fulfilled: number }> {
    const [row]: { active: number; fulfilled: number }[] = await manager.query(
      `SELECT COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'active'), 0)::int AS active,
              COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'fulfilled'), 0)::int AS fulfilled
       FROM reservation r
       JOIN inspection_item ii ON ii.inspection_item_id = r.inspection_item_id
       WHERE r.work_order_id = $1 AND ii.bom_line_id = $2 AND r.part_id = $3`,
      [workOrderId, bomLineId, partId],
    );
    return row;
  }

  // Piezas con reservas activas o faltantes abiertos en esas líneas de la orden.
  private async linePartIds(
    manager: EntityManager,
    workOrderId: number,
    bomLineIds: number[],
  ): Promise<number[]> {
    const rows: { part_id: number }[] = await manager.query(
      `SELECT r.part_id FROM reservation r
       JOIN inspection_item ii ON ii.inspection_item_id = r.inspection_item_id
       WHERE r.work_order_id = $1 AND ii.bom_line_id = ANY($2::int[]) AND r.status = 'active'
       UNION
       SELECT s.part_id FROM shortage s
       JOIN inspection_item ii ON ii.inspection_item_id = s.inspection_item_id
       WHERE s.work_order_id = $1 AND ii.bom_line_id = ANY($2::int[]) AND s.status = 'open'
         AND s.part_id IS NOT NULL`,
      [workOrderId, bomLineIds],
    );
    return rows.map((row) => row.part_id);
  }

  // Cancela todas las reservas activas de la línea.
  private async releaseLine(
    manager: EntityManager,
    workOrderId: number,
    bomLineId: number,
  ): Promise<void> {
    const released = await updateReturning<{
      part_id: number;
      quantity: number;
    }>(
      manager,
      `UPDATE reservation r SET status = 'cancelled', updated_at = now()
       FROM inspection_item ii
       WHERE ii.inspection_item_id = r.inspection_item_id
         AND r.work_order_id = $1 AND ii.bom_line_id = $2 AND r.status = 'active'
       RETURNING r.part_id, r.quantity`,
      [workOrderId, bomLineId],
    );
    await this.releaseByPart(manager, released);
  }

  // Libera `quantity` de las reservas activas de la línea, de la más nueva a la más vieja.
  private async releaseLineQuantity(
    manager: EntityManager,
    workOrderId: number,
    bomLineId: number,
    partId: number,
    quantity: number,
  ): Promise<void> {
    const reservations: { reservation_id: string; quantity: number }[] =
      await manager.query(
        `SELECT r.reservation_id, r.quantity
         FROM reservation r
         JOIN inspection_item ii ON ii.inspection_item_id = r.inspection_item_id
         WHERE r.work_order_id = $1 AND ii.bom_line_id = $2 AND r.part_id = $3
           AND r.status = 'active'
         ORDER BY r.reservation_id DESC
         FOR UPDATE OF r`,
        [workOrderId, bomLineId, partId],
      );
    let remaining = quantity;
    for (const reservation of reservations) {
      if (remaining === 0) {
        break;
      }
      if (reservation.quantity <= remaining) {
        await manager.query(
          `UPDATE reservation SET status = 'cancelled', updated_at = now()
           WHERE reservation_id = $1`,
          [reservation.reservation_id],
        );
        remaining -= reservation.quantity;
        continue;
      }
      await manager.query(
        `UPDATE reservation SET quantity = quantity - $2, updated_at = now()
         WHERE reservation_id = $1`,
        [reservation.reservation_id, remaining],
      );
      remaining = 0;
    }
    await this.ledger.release(manager, partId, quantity - remaining);
  }

  private async releaseByPart(
    manager: EntityManager,
    released: { part_id: number; quantity: number }[],
  ): Promise<void> {
    const byPart = new Map<number, number>();
    for (const row of released) {
      byPart.set(row.part_id, (byPart.get(row.part_id) ?? 0) + row.quantity);
    }
    for (const [partId, quantity] of byPart) {
      await this.ledger.release(manager, partId, quantity);
    }
  }
}
