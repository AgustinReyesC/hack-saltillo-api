import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CatalogHandlers } from '../catalog/catalog.handlers.js';
import { InspectionHandlers } from '../inspections/inspections.handlers.js';
import { EventEnvelope } from '../outbox/event-envelope.js';
import { PurchasingHandlers } from '../purchasing/purchasing.handlers.js';
import { WorkOrderHandlers } from '../work-orders/work-orders.handlers.js';
import { NOTIFICATIONS_TOPIC } from './ingest.config.js';

// Escribe el dominio dentro de la transacción del evento y devuelve los eventos de salida que
// encoló en `outbox_event`.
type EventHandler = (
  manager: EntityManager,
  event: EventEnvelope<any>,
) => Promise<EventEnvelope[]>;

// Elige la función de cada `event_type`.
@Injectable()
export class EventDispatcher {
  private readonly handlers: Record<string, EventHandler>;

  constructor(
    catalog: CatalogHandlers,
    workOrders: WorkOrderHandlers,
    inspections: InspectionHandlers,
    purchasing: PurchasingHandlers,
  ) {
    this.handlers = {
      'part.upserted': (m, e) => catalog.partUpserted(m, e),
      'location.upserted': (m, e) => catalog.locationUpserted(m, e),
      'bom.upserted': (m, e) => catalog.bomUpserted(m, e),
      'work_order.opened': (m, e) => workOrders.opened(m, e),
      'work_order.stage_changed': (m, e) => workOrders.stageChanged(m, e),
      'work_order.deleted': (m, e) => workOrders.deleted(m, e),
      'inspection.submitted': (m, e) => inspections.submitted(m, e),
      'inspection.approved': (m, e) => inspections.approved(m, e),
      'inspection.rejected': (m, e) => inspections.rejected(m, e),
      'inspection.discarded': (m, e) => inspections.discarded(m, e),
      'inspection.voided': (m, e) => inspections.voided(m, e),
      'purchase.item_received': (m, e) => purchasing.itemReceived(m, e),
    };
  }

  async dispatch(
    manager: EntityManager,
    topic: string,
    event: EventEnvelope,
  ): Promise<EventEnvelope[]> {
    // Los de `notifications` no tocan el dominio: se guardan y se reenvían al agente.
    if (topic === NOTIFICATIONS_TOPIC) {
      return [];
    }
    const handler = this.handlers[event.event_type];
    if (!handler) {
      throw new Error(`Sin función para ${event.event_type}`);
    }
    return handler(manager, event);
  }
}
