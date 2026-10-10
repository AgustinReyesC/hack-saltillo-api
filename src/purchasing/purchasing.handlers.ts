import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { InputEvent, PurchaseItemReceived } from '../ingest/input-events.js';
import { RECEIVING_LOCATION_ID } from '../ledger/ledger.service.js';
import { EventEnvelope } from '../outbox/event-envelope.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PurchasingService } from './purchasing.service.js';

// Eventos de `shop.purchasing`.
@Injectable()
export class PurchasingHandlers {
  constructor(
    private readonly purchasing: PurchasingService,
    private readonly outbox: OutboxService,
  ) {}

  // Reglas 9 a 12. `customer_order` no entra al inventario ni emite nada. `restock` se relaciona
  // con el catálogo por `sku_norm` (sin mayúsculas ni espacios al inicio y al final, como
  // `match_part_by_sku` de la base): una sola pieza ⇒ entrada en U-100; ninguna o varias ⇒
  // revisión manual.
  async itemReceived(
    manager: EntityManager,
    event: InputEvent<PurchaseItemReceived>,
  ): Promise<EventEnvelope[]> {
    const line = event.data;
    const [workOrder]: { work_order_id: number }[] = line.work_order_code
      ? await manager.query(
          'SELECT work_order_id FROM work_order WHERE code = $1',
          [line.work_order_code],
        )
      : [];

    await manager.query(
      `INSERT INTO purchase_request
         (purchase_request_id, request_number, work_order_id, status, requested_at)
       VALUES ($1, $2, $3, 'received', $4)
       ON CONFLICT (purchase_request_id) DO UPDATE
         SET work_order_id = COALESCE(purchase_request.work_order_id, EXCLUDED.work_order_id),
             updated_at = now()`,
      [
        line.purchase_request_id,
        line.request_number,
        workOrder?.work_order_id ?? null,
        line.received_at,
      ],
    );

    // La misma línea de compra nunca entra dos veces, aunque llegue en otro evento.
    const [existing]: { match_status: string }[] = await manager.query(
      'SELECT match_status FROM purchase_line WHERE line_id = $1 FOR UPDATE',
      [line.line_id],
    );
    if (existing && existing.match_status !== 'pending') {
      return [];
    }
    if (!existing) {
      await manager.query(
        `INSERT INTO purchase_line
           (line_id, purchase_request_id, part_number, description, quantity, unit_price,
            currency, purpose, work_order_code, received_at, match_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
        [
          line.line_id,
          line.purchase_request_id,
          line.part_number,
          line.description,
          line.quantity,
          line.unit_price,
          line.currency,
          line.purpose,
          line.work_order_code,
          line.received_at,
        ],
      );
    }

    // Regla 9: material para revender; se distingue por `purpose` y queda en `pending`.
    if (line.purpose === 'customer_order') {
      return [];
    }

    const candidates: { part_id: number }[] = await manager.query(
      'SELECT part_id FROM part WHERE sku_norm = lower(btrim($1)) ORDER BY part_id',
      [line.part_number],
    );
    if (candidates.length !== 1) {
      return this.unmatched(manager, line);
    }

    const partId = candidates[0].part_id;
    await manager.query(
      `UPDATE purchase_line SET part_id = $2, match_status = 'matched', updated_at = now()
       WHERE line_id = $1`,
      [line.line_id, partId],
    );
    const { events } = await this.purchasing.registerReceipt(manager, {
      partId,
      locationId: RECEIVING_LOCATION_ID,
      quantity: line.quantity,
      unitCost: line.unit_price,
      currency: line.currency,
      purchaseLineId: line.line_id,
      receivedAt: line.received_at,
      workOrderCode: line.work_order_code,
    });
    return events;
  }

  // Regla 10: sin pieza única queda para `POST /unmatched-receipts/{id}/resolve`.
  private async unmatched(
    manager: EntityManager,
    line: PurchaseItemReceived,
  ): Promise<EventEnvelope[]> {
    await manager.query(
      `INSERT INTO unmatched_receipt
         (purchase_line_id, part_number, description, quantity, unit_price, currency,
          received_at, work_order_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (purchase_line_id) DO NOTHING`,
      [
        line.line_id,
        line.part_number,
        line.description,
        line.quantity,
        line.unit_price,
        line.currency,
        line.received_at,
        line.work_order_code,
      ],
    );
    await manager.query(
      `UPDATE purchase_line SET match_status = 'unmatched', updated_at = now()
       WHERE line_id = $1`,
      [line.line_id],
    );
    return [
      await this.outbox.enqueue(
        manager,
        'stock.unmatched_receipt',
        `purchase_line:${line.line_id}`,
        {
          purchase_line_id: line.line_id,
          part_number: line.part_number,
          description: line.description,
          quantity: line.quantity,
        },
      ),
    ];
  }
}
