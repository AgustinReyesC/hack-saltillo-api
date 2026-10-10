import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CommitmentsService } from '../commitments/commitments.service.js';
import { toInt, toIso, toMovement } from '../common/serialization.js';
import {
  LedgerService,
  RECEIVING_LOCATION_ID,
} from '../ledger/ledger.service.js';
import { EventEnvelope } from '../outbox/event-envelope.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { ResolveReceiptDto } from './dto/resolve-receipt.dto.js';

// `purchase_request_id` y `line_id` son INTEGER sin secuencia: la API usa un rango propio para no
// chocar con los ids del taller ni con los de las pruebas de contrato (API README §12).
const API_ID_START = 1_500_000_000;
const ID_LOCK = [2, 1] as const;

interface ReceiptRow {
  id: string;
  purchase_line_id: number;
  part_number: string;
  description: string | null;
  quantity: number;
  unit_price: string | null;
  currency: string | null;
  received_at: Date;
  work_order_code: string | null;
  status: string;
}

@Injectable()
export class PurchasingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly commitments: CommitmentsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async listUnmatchedReceipts() {
    const rows: Omit<ReceiptRow, 'status'>[] = await this.dataSource.query(
      `SELECT id, purchase_line_id, part_number, COALESCE(description, '') AS description,
              quantity, unit_price, currency, received_at, work_order_code
       FROM v_unmatched_receipts
       ORDER BY received_at, id`,
    );
    return {
      items: rows.map((row) => {
        const { unit_price, currency, ...rest } = row;
        // `unit_price` y `currency` son opcionales en el contrato: se omiten si no hay dato.
        return {
          ...rest,
          id: toInt(row.id),
          received_at: toIso(row.received_at),
          ...(unit_price !== null && { unit_price }),
          ...(currency !== null && { currency }),
        };
      }),
    };
  }

  // Relaciona a mano una recepción: registra la entrada como si hubiera coincidido desde el
  // principio (emite `stock.received`) y surte los faltantes de la pieza.
  async resolveReceipt(receiptId: number, dto: ResolveReceiptDto) {
    const events: EventEnvelope[] = [];
    const movement = await this.dataSource.transaction(async (manager) => {
      const [receipt]: ReceiptRow[] = await manager.query(
        `SELECT id, purchase_line_id, part_number, description, quantity, unit_price, currency,
                received_at, work_order_code, status
         FROM unmatched_receipt WHERE id = $1
         FOR UPDATE`,
        [receiptId],
      );
      if (!receipt) {
        throw new NotFoundException('Unmatched receipt not found');
      }
      if (receipt.status === 'resolved') {
        throw new ConflictException('Unmatched receipt already resolved');
      }
      const locationId = dto.location_id ?? RECEIVING_LOCATION_ID;
      await this.ledger.assertPartsExist(manager, [dto.part_id]);
      await this.ledger.assertLocationExists(manager, locationId);
      await this.ledger.lockParts(manager, [dto.part_id]);

      const [line]: { unit_price: string; currency: string }[] =
        await manager.query(
          'SELECT unit_price::text, currency FROM purchase_line WHERE line_id = $1',
          [receipt.purchase_line_id],
        );
      const unitCost = line?.unit_price ?? receipt.unit_price ?? '0.00';
      const currency = line?.currency ?? receipt.currency ?? 'MXN';

      const event = this.outbox.build('stock.received', `part:${dto.part_id}`, {
        part_id: dto.part_id,
        location_id: locationId,
        quantity: receipt.quantity,
        unit_cost: unitCost,
        currency,
        purchase_line_id: receipt.purchase_line_id,
      });
      const row = await this.ledger.addMovement(manager, {
        type: 'receipt',
        partId: dto.part_id,
        locationId,
        quantity: receipt.quantity,
        unitCost,
        currency,
        reference: `purchase_line:${receipt.purchase_line_id}`,
        occurredAt: receipt.received_at,
        eventId: event.event_id,
      });
      await this.outbox.save(manager, event);
      events.push(event);

      await manager.query(
        `UPDATE unmatched_receipt
         SET status = 'resolved', resolved_part_id = $2, resolved_location_id = $3,
             resolved_at = now()
         WHERE id = $1`,
        [receipt.id, dto.part_id, locationId],
      );
      await manager.query(
        `UPDATE purchase_line
         SET part_id = $2, match_status = 'resolved', updated_at = now()
         WHERE line_id = $1`,
        [receipt.purchase_line_id, dto.part_id],
      );

      events.push(
        ...(await this.commitments.fillShortages(
          manager,
          dto.part_id,
          receipt.work_order_code,
        )),
      );
      const suggestion = await this.commitments.recomputeSuggestion(
        manager,
        dto.part_id,
      );
      if (suggestion) {
        events.push(suggestion);
      }
      return toMovement(row);
    });

    this.realtime.notify(events);
    return movement;
  }

  async listSuppliers() {
    const items: unknown[] = await this.dataSource.query(
      `SELECT supplier_id, code, name, contact_name, email, phone, active
       FROM supplier
       ORDER BY supplier_id`,
    );
    return { items };
  }

  // Extensión: crea `purchase_request` + `purchase_order` + `purchase_line`. No emite eventos
  // `stock.*` (el contrato no define "orden creada").
  async createPurchaseOrder(dto: CreatePurchaseOrderDto) {
    return this.dataSource.transaction(async (manager) => {
      const suppliers: unknown[] = await manager.query(
        'SELECT 1 FROM supplier WHERE supplier_id = $1',
        [dto.supplier_id],
      );
      if (suppliers.length === 0) {
        throw new NotFoundException(`Supplier ${dto.supplier_id} not found`);
      }
      const partIds = dto.lines.map((line) => line.part_id);
      await this.ledger.assertPartsExist(manager, partIds);
      const parts: { part_id: number; sku: string | null; name: string }[] =
        await manager.query(
          'SELECT part_id, sku, name FROM part WHERE part_id = ANY($1::int[])',
          [partIds],
        );
      const partById = new Map(parts.map((part) => [part.part_id, part]));

      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [...ID_LOCK]);
      const requestId = await this.nextId(
        manager,
        'purchase_request',
        'purchase_request_id',
      );
      const requestNumber = `API-${requestId}`;
      const currency = dto.currency ?? 'MXN';

      await manager.query(
        `INSERT INTO purchase_request
           (purchase_request_id, request_number, supplier_id, status, requested_at)
         VALUES ($1, $2, $3, 'open', now())`,
        [requestId, requestNumber, dto.supplier_id],
      );
      const [order]: {
        purchase_order_id: number;
        po_number: string;
        status: string;
        ordered_at: Date;
        expected_at: Date | null;
      }[] = await manager.query(
        `INSERT INTO purchase_order
           (po_number, supplier_id, purchase_request_id, status, currency, ordered_at, expected_at)
         VALUES ($1, $2, $3, 'open', $4, now(), $5)
         RETURNING purchase_order_id, po_number, status, ordered_at, expected_at`,
        [
          `PO-${requestId}`,
          dto.supplier_id,
          requestId,
          currency,
          dto.expected_at ?? null,
        ],
      );

      let lineId = await this.nextId(manager, 'purchase_line', 'line_id');
      const lines = [];
      for (const line of dto.lines) {
        const part = partById.get(line.part_id)!;
        const created = {
          line_id: lineId++,
          part_id: line.part_id,
          part_number: line.part_number ?? part.sku ?? `P-${part.part_id}`,
          quantity: line.quantity,
          unit_price: line.unit_price,
          purpose: line.purpose ?? 'restock',
          work_order_code: line.work_order_code ?? null,
        };
        await manager.query(
          `INSERT INTO purchase_line
             (line_id, purchase_request_id, purchase_order_id, part_number, part_id, description,
              quantity, unit_price, currency, purpose, work_order_code, match_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'matched')`,
          [
            created.line_id,
            requestId,
            order.purchase_order_id,
            created.part_number,
            created.part_id,
            part.name,
            created.quantity,
            created.unit_price,
            currency,
            created.purpose,
            created.work_order_code,
          ],
        );
        lines.push(created);
      }

      return {
        purchase_order_id: order.purchase_order_id,
        po_number: order.po_number,
        purchase_request_id: requestId,
        request_number: requestNumber,
        supplier_id: dto.supplier_id,
        status: order.status,
        currency,
        ordered_at: toIso(order.ordered_at),
        expected_at: toIso(order.expected_at),
        lines,
      };
    });
  }

  private async nextId(
    manager: EntityManager,
    table: 'purchase_request' | 'purchase_line',
    column: 'purchase_request_id' | 'line_id',
  ): Promise<number> {
    const [row]: { next_id: number }[] = await manager.query(
      `SELECT GREATEST(COALESCE(MAX(${column}), 0) + 1, $1)::int AS next_id
       FROM ${table} WHERE ${column} >= $1`,
      [API_ID_START],
    );
    return row.next_id;
  }
}
