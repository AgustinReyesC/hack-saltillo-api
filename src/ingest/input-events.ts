import { EventEnvelope } from '../outbox/event-envelope.js';

// `data` de los eventos que publica el taller, tal cual los define `contract/schemas/input`. En la
// entrada todos los campos vienen siempre: los opcionales llegan como null.

export interface UnitData {
  id: number;
  name: string;
}

export interface PartUpserted {
  part_id: number;
  sku: string | null;
  name: string;
  family: string;
  group: string;
  subgroup: string | null;
  unit: UnitData | null;
  image_url: string | null;
  active: boolean;
}

export interface LocationUpserted {
  location_id: number;
  code: string;
  name: string;
  is_workbench: boolean;
  active: boolean;
}

export interface BomLine {
  bom_line_id: number;
  part_id: number | null;
  name: string;
  group_name: string | null;
  unit: UnitData | null;
  qty_per_unit: number | null;
  sort_order: number;
}

export interface BomUpserted {
  model_id: number;
  model_name: string;
  brand: string;
  lines: BomLine[];
}

export interface WorkOrderOpened {
  work_order_id: number;
  code: string;
  model_id: number;
  department: string;
  received_at: string;
}

export interface WorkOrderStageChanged {
  work_order_id: number;
  from_stage: string;
  to_stage: string;
}

export interface WorkOrderDeleted {
  work_order_id: number;
  code: string;
}

export interface InspectionItem {
  inspection_item_id: number;
  bom_line_id: number;
  part_id: number | null;
  name: string;
  group_name: string | null;
  condition: 'ok' | 'damaged' | 'missing';
  action: 'buy' | 'repair' | null;
  quantity: number | null;
  note: string | null;
}

export interface InspectionSubmitted {
  inspection_id: number;
  work_order_id: number;
  kind: 'quick' | 'full';
  items: InspectionItem[];
}

export interface InspectionApproved extends InspectionSubmitted {
  approved_by: number;
  approved_at: string;
}

export interface InspectionClosed {
  inspection_id: number;
  work_order_id: number;
  reason?: string;
}

export interface PurchaseItemReceived {
  purchase_request_id: number;
  request_number: string;
  line_id: number;
  part_number: string;
  description: string;
  quantity: number;
  unit_price: string;
  currency: string;
  purpose: 'restock' | 'customer_order';
  received_at: string;
  work_order_code: string | null;
}

export type InputEvent<T extends object> = EventEnvelope<T>;
