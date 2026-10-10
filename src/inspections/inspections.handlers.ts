import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { updateReturning } from '../common/db.js';
import {
  CommitmentsService,
  WorkOrderRef,
} from '../commitments/commitments.service.js';
import { MissingDependencyError } from '../ingest/ingest-errors.js';
import {
  InputEvent,
  InspectionApproved,
  InspectionClosed,
  InspectionItem,
  InspectionSubmitted,
} from '../ingest/input-events.js';
import { EventEnvelope } from '../outbox/event-envelope.js';

type ClosedStatus = 'rejected' | 'discarded' | 'voided';

interface WorkOrderRow extends WorkOrderRef {
  deleted: boolean;
}

// Eventos de `shop.inspections`. Solo `approved` crea necesidad (regla 1); `voided` la libera.
@Injectable()
export class InspectionHandlers {
  constructor(private readonly commitments: CommitmentsService) {}

  async submitted(
    manager: EntityManager,
    event: InputEvent<InspectionSubmitted>,
  ): Promise<EventEnvelope[]> {
    const inspection = event.data;
    await this.findWorkOrder(manager, inspection.work_order_id);
    // No regresa de estado una inspección que ya se aprobó o cerró.
    await manager.query(
      `INSERT INTO inspection (inspection_id, work_order_id, kind, status, submitted_at)
       VALUES ($1, $2, $3, 'submitted', $4)
       ON CONFLICT (inspection_id) DO UPDATE
         SET work_order_id = EXCLUDED.work_order_id, kind = EXCLUDED.kind,
             submitted_at = COALESCE(inspection.submitted_at, EXCLUDED.submitted_at),
             updated_at = now()`,
      [
        inspection.inspection_id,
        inspection.work_order_id,
        inspection.kind,
        event.occurred_at,
      ],
    );
    await this.upsertItems(manager, inspection.inspection_id, inspection.items);
    return [];
  }

  async approved(
    manager: EntityManager,
    event: InputEvent<InspectionApproved>,
  ): Promise<EventEnvelope[]> {
    const inspection = event.data;
    const workOrder = await this.findWorkOrder(
      manager,
      inspection.work_order_id,
    );
    // Crea la fila si no llegó el `submitted`.
    await manager.query(
      `INSERT INTO inspection
         (inspection_id, work_order_id, kind, status, approved_by, approved_at, submitted_at)
       VALUES ($1, $2, $3, 'approved', $4, $5, $5)
       ON CONFLICT (inspection_id) DO UPDATE
         SET work_order_id = EXCLUDED.work_order_id, kind = EXCLUDED.kind, status = 'approved',
             approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
             updated_at = now()`,
      [
        inspection.inspection_id,
        inspection.work_order_id,
        inspection.kind,
        inspection.approved_by,
        inspection.approved_at,
      ],
    );
    await this.upsertItems(manager, inspection.inspection_id, inspection.items);
    // Una orden dada de baja ya no aparta material.
    if (workOrder.deleted) {
      return [];
    }
    return this.commitments.applyApproval(manager, workOrder, inspection.items);
  }

  // Rechazo y descarte no mueven inventario (regla 1): tras un rechazo llega otra inspección.
  async rejected(
    manager: EntityManager,
    event: InputEvent<InspectionClosed>,
  ): Promise<EventEnvelope[]> {
    await this.close(manager, event, 'rejected');
    return [];
  }

  async discarded(
    manager: EntityManager,
    event: InputEvent<InspectionClosed>,
  ): Promise<EventEnvelope[]> {
    await this.close(manager, event, 'discarded');
    return [];
  }

  // Regla 13: la orden regresó de etapa; se libera lo que venía de esta inspección.
  async voided(
    manager: EntityManager,
    event: InputEvent<InspectionClosed>,
  ): Promise<EventEnvelope[]> {
    const workOrderId = await this.close(manager, event, 'voided');
    const workOrder = await this.findWorkOrder(manager, workOrderId);
    return this.commitments.releaseInspection(
      manager,
      workOrder,
      event.data.inspection_id,
    );
  }

  private async close(
    manager: EntityManager,
    event: InputEvent<InspectionClosed>,
    status: ClosedStatus,
  ): Promise<number> {
    const [inspection] = await updateReturning<{ work_order_id: number }>(
      manager,
      `UPDATE inspection SET status = $2, reason = COALESCE($3, reason), updated_at = now()
       WHERE inspection_id = $1 RETURNING work_order_id`,
      [event.data.inspection_id, status, event.data.reason ?? null],
    );
    if (!inspection) {
      throw new MissingDependencyError(
        `la inspección ${event.data.inspection_id}`,
      );
    }
    return inspection.work_order_id;
  }

  // La inspección puede llegar antes que su orden (regla 20): se reintenta.
  private async findWorkOrder(
    manager: EntityManager,
    workOrderId: number,
  ): Promise<WorkOrderRow> {
    const [workOrder]: WorkOrderRow[] = await manager.query(
      'SELECT work_order_id, code, deleted FROM work_order WHERE work_order_id = $1',
      [workOrderId],
    );
    if (!workOrder) {
      throw new MissingDependencyError(`la orden ${workOrderId}`);
    }
    return workOrder;
  }

  // Upsert por `inspection_item_id` (no borrar y reinsertar: reservas y faltantes lo referencian).
  // Necesita la línea de la lista de partes y la pieza (FK): si faltan, se reintenta.
  private async upsertItems(
    manager: EntityManager,
    inspectionId: number,
    items: InspectionItem[],
  ): Promise<void> {
    for (const item of items) {
      await manager.query(
        `INSERT INTO inspection_item
           (inspection_item_id, inspection_id, bom_line_id, part_id, name, group_name, condition,
            action, quantity, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (inspection_item_id) DO UPDATE
           SET inspection_id = EXCLUDED.inspection_id, bom_line_id = EXCLUDED.bom_line_id,
               part_id = EXCLUDED.part_id, name = EXCLUDED.name,
               group_name = EXCLUDED.group_name, condition = EXCLUDED.condition,
               action = EXCLUDED.action, quantity = EXCLUDED.quantity, note = EXCLUDED.note`,
        [
          item.inspection_item_id,
          inspectionId,
          item.bom_line_id,
          item.part_id,
          item.name,
          item.group_name,
          item.condition,
          item.action,
          item.quantity,
          item.note,
        ],
      );
    }
  }
}
