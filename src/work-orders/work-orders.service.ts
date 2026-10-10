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
  fulfilled: number;
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

  // Una línea por `bom_line_id` con necesidad vigente (`work_order_need`, que fija cada
  // aprobación). Entregado = lo que salió contra las reservas de la línea más lo que salió contra
  // la orden sin reserva (eso se le cuenta a la primera línea de la pieza, porque `movement` no
  // sabe de líneas). En una orden dada de baja ya no falta nada.
  async materials(code: string) {
    const workOrder = await this.findByCode(code);
    const lines: MaterialRow[] = await this.dataSource.query(
      `SELECT n.inspection_item_id, n.bom_line_id, n.part_id,
              COALESCE(ii.name, ml.name) AS name, n.quantity AS required,
              COALESCE(r.reserved, 0)::int AS reserved,
              COALESCE(r.fulfilled, 0)::int AS fulfilled
       FROM work_order_need n
       JOIN model_line ml ON ml.bom_line_id = n.bom_line_id
       LEFT JOIN inspection_item ii ON ii.inspection_item_id = n.inspection_item_id
       LEFT JOIN LATERAL (
         SELECT SUM(res.quantity) FILTER (WHERE res.status = 'active') AS reserved,
                SUM(res.quantity) FILTER (WHERE res.status = 'fulfilled') AS fulfilled
         FROM reservation res
         JOIN inspection_item ri ON ri.inspection_item_id = res.inspection_item_id
         WHERE res.work_order_id = n.work_order_id AND ri.bom_line_id = n.bom_line_id
       ) r ON TRUE
       WHERE n.work_order_id = $1
       ORDER BY n.bom_line_id`,
      [workOrder.work_order_id],
    );
    // Las salidas viejas (antes de `movement.work_order_id`) se reconocen por `reference`.
    const issuedRows: { part_id: number; issued: number }[] =
      await this.dataSource.query(
        `SELECT part_id, COALESCE(SUM(-quantity), 0)::int AS issued
         FROM movement
         WHERE type = 'issue'
           AND (work_order_id = $1 OR (work_order_id IS NULL AND reference = $2))
         GROUP BY part_id`,
        [workOrder.work_order_id, workOrder.code],
      );

    const unattributed = new Map(
      issuedRows.map((row) => [row.part_id, row.issued]),
    );
    for (const line of lines) {
      if (line.part_id !== null && unattributed.has(line.part_id)) {
        unattributed.set(
          line.part_id,
          unattributed.get(line.part_id)! - line.fulfilled,
        );
      }
    }

    return {
      work_order_id: workOrder.work_order_id,
      code: workOrder.code,
      deleted: workOrder.deleted,
      lines: lines.map(({ fulfilled, ...line }) => {
        const extra =
          line.part_id === null
            ? 0
            : Math.max(unattributed.get(line.part_id) ?? 0, 0);
        if (line.part_id !== null) {
          unattributed.delete(line.part_id);
        }
        const issued = fulfilled + extra;
        return {
          ...line,
          issued,
          missing:
            line.required === null
              ? null
              : workOrder.deleted
                ? 0
                : Math.max(line.required - line.reserved - issued, 0),
        };
      }),
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
