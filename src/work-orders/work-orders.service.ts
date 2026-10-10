import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toIso } from '../common/serialization.js';
import { WorkOrdersQueryDto } from './dto/work-orders-query.dto.js';

const DEFAULT_LIMIT = 100;

interface WorkOrderRow {
  work_order_id: number;
  code: string;
  model_id: number | null;
  model_name: string | null;
  department: string | null;
  stage: string;
  received_at: Date | null;
  deleted: boolean;
}

interface MaterialRow {
  inspection_item_id: number;
  bom_line_id: number;
  part_id: number | null;
  name: string;
  required: number | null;
  reserved: number;
  issued: number;
}

@Injectable()
export class WorkOrdersService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: WorkOrdersQueryDto) {
    const rows: WorkOrderRow[] = await this.dataSource.query(
      `SELECT w.work_order_id, w.code, w.model_id, m.model_name, w.department, w.stage,
              w.received_at, w.deleted
       FROM work_order w
       LEFT JOIN model m ON m.model_id = w.model_id
       WHERE w.deleted = $1
         AND ($2::text IS NULL OR w.stage = $2)
         AND ($3::text IS NULL OR w.department = $3)
       ORDER BY w.received_at DESC NULLS LAST, w.work_order_id DESC
       LIMIT $4 OFFSET $5`,
      [
        query.deleted ?? false,
        query.stage ?? null,
        query.department ?? null,
        query.limit ?? DEFAULT_LIMIT,
        query.offset ?? 0,
      ],
    );
    return { items: rows.map((row) => this.toWorkOrder(row)) };
  }

  async get(code: string) {
    const workOrder = await this.findByCode(code);
    const stages: {
      from_stage: string | null;
      to_stage: string;
      occurred_at: Date;
    }[] = await this.dataSource.query(
      `SELECT from_stage, to_stage, occurred_at
       FROM work_order_stage
       WHERE work_order_id = $1
       ORDER BY occurred_at, id`,
      [workOrder.work_order_id],
    );
    return {
      ...this.toWorkOrder(workOrder),
      stages: stages.map((stage) => ({
        ...stage,
        occurred_at: toIso(stage.occurred_at),
      })),
    };
  }

  // Una línea por `bom_line_id` con necesidad vigente: el último item `buy` de las inspecciones
  // aprobadas de la orden (API README §7).
  async materials(code: string) {
    const workOrder = await this.findByCode(code);
    const lines: MaterialRow[] = await this.dataSource.query(
      `WITH lines AS (
         SELECT DISTINCT ON (ii.bom_line_id)
                ii.inspection_item_id, ii.bom_line_id, ii.part_id, ii.name,
                COALESCE(ii.quantity, ml.qty_per_unit) AS required
         FROM inspection_item ii
         JOIN inspection i  ON i.inspection_id = ii.inspection_id
         JOIN model_line ml ON ml.bom_line_id = ii.bom_line_id
         WHERE i.work_order_id = $1 AND i.status = 'approved' AND ii.action = 'buy'
         ORDER BY ii.bom_line_id, i.approved_at DESC NULLS LAST, i.inspection_id DESC
       )
       SELECT l.*,
              (SELECT COALESCE(SUM(r.quantity), 0)::int
               FROM reservation r
               JOIN inspection_item ri ON ri.inspection_item_id = r.inspection_item_id
               WHERE r.work_order_id = $1 AND r.status = 'active'
                 AND ri.bom_line_id = l.bom_line_id) AS reserved,
              (SELECT COALESCE(SUM(-m.quantity), 0)::int
               FROM movement m
               WHERE m.type = 'issue' AND m.reference = $2 AND m.part_id = l.part_id) AS issued
       FROM lines l
       ORDER BY l.bom_line_id`,
      [workOrder.work_order_id, workOrder.code],
    );

    return {
      work_order_id: workOrder.work_order_id,
      code: workOrder.code,
      lines: lines.map((line) => ({
        ...line,
        missing:
          line.required === null
            ? null
            : Math.max(line.required - line.reserved - line.issued, 0),
      })),
    };
  }

  private async findByCode(code: string): Promise<WorkOrderRow> {
    const [row]: WorkOrderRow[] = await this.dataSource.query(
      `SELECT w.work_order_id, w.code, w.model_id, m.model_name, w.department, w.stage,
              w.received_at, w.deleted
       FROM work_order w
       LEFT JOIN model m ON m.model_id = w.model_id
       WHERE w.code = $1`,
      [code],
    );
    if (!row) {
      throw new NotFoundException('Work order not found');
    }
    return row;
  }

  private toWorkOrder(row: WorkOrderRow) {
    return { ...row, received_at: toIso(row.received_at) };
  }
}
