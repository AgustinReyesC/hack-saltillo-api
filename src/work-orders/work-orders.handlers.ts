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
  WorkOrderDeleted,
  WorkOrderOpened,
  WorkOrderStageChanged,
} from '../ingest/input-events.js';
import { EventEnvelope } from '../outbox/event-envelope.js';

// Eventos de `shop.work_orders`.
@Injectable()
export class WorkOrderHandlers {
  constructor(private readonly commitments: CommitmentsService) {}

  // Necesita su modelo (FK): si aún no llega, el evento se reintenta. Un upsert repetido no pisa
  // la etapa ni la baja que ya trajeron otros eventos.
  async opened(
    manager: EntityManager,
    event: InputEvent<WorkOrderOpened>,
  ): Promise<EventEnvelope[]> {
    const order = event.data;
    await manager.query(
      `INSERT INTO work_order (work_order_id, code, model_id, department, received_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (work_order_id) DO UPDATE
         SET code = EXCLUDED.code, model_id = EXCLUDED.model_id,
             department = EXCLUDED.department, received_at = EXCLUDED.received_at,
             updated_at = now()`,
      [
        order.work_order_id,
        order.code,
        order.model_id,
        order.department,
        order.received_at,
      ],
    );
    return [];
  }

  async stageChanged(
    manager: EntityManager,
    event: InputEvent<WorkOrderStageChanged>,
  ): Promise<EventEnvelope[]> {
    const change = event.data;
    const updated = await updateReturning<{ work_order_id: number }>(
      manager,
      `UPDATE work_order SET stage = $2, updated_at = now()
       WHERE work_order_id = $1 RETURNING work_order_id`,
      [change.work_order_id, change.to_stage],
    );
    if (updated.length === 0) {
      throw new MissingDependencyError(`la orden ${change.work_order_id}`);
    }
    await manager.query(
      `INSERT INTO work_order_stage (work_order_id, from_stage, to_stage, occurred_at, event_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        change.work_order_id,
        change.from_stage,
        change.to_stage,
        event.occurred_at,
        event.event_id,
      ],
    );
    return [];
  }

  // Regla 14: libera las reservas activas y cierra los faltantes de la orden. Una compra
  // posterior con su código entra como existencia general (`fillShortages` ignora órdenes dadas
  // de baja).
  async deleted(
    manager: EntityManager,
    event: InputEvent<WorkOrderDeleted>,
  ): Promise<EventEnvelope[]> {
    const [order] = await updateReturning<WorkOrderRef>(
      manager,
      `UPDATE work_order SET deleted = TRUE, updated_at = now()
       WHERE work_order_id = $1 RETURNING work_order_id, code`,
      [event.data.work_order_id],
    );
    if (!order) {
      throw new MissingDependencyError(`la orden ${event.data.work_order_id}`);
    }
    return this.commitments.releaseWorkOrder(manager, order);
  }
}
