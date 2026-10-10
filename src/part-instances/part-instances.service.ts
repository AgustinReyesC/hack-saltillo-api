import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { updateReturning } from '../common/db.js';
import { toInt } from '../common/serialization.js';
import { PartInstancesQueryDto } from './dto/part-instances-query.dto.js';
import {
  PART_INSTANCE_FIELDS,
  UpdatePartInstanceDto,
} from './dto/update-part-instance.dto.js';

const DEFAULT_LIMIT = 100;

const INSTANCE_SELECT = `
  SELECT v.instance_id, v.part_id, v.sku, v.name, v.condition_code, v.condition_name,
         v.is_available, v.location_id, l.code AS location_code, v.work_order_id,
         w.code AS work_order_code, v.serial_number, v.note, v.tools, v.missing_components
  FROM v_part_instance_agent v
  LEFT JOIN location l   ON l.location_id = v.location_id
  LEFT JOIN work_order w ON w.work_order_id = v.work_order_id`;

interface InstanceRow {
  instance_id: string;
  part_id: number;
  condition_code: string;
  work_order_id: number | null;
  note: string | null;
  [column: string]: unknown;
}

// Capa de unidades físicas: cada unidad tiene su estado y su receta de reparación. No toca
// `movement` ni `stock_balance`.
@Injectable()
export class PartInstancesService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: PartInstancesQueryDto) {
    const rows: InstanceRow[] = await this.dataSource.query(
      `${INSTANCE_SELECT}
       WHERE ($1::int IS NULL OR v.part_id = $1)
         AND ($2::text IS NULL OR v.condition_code = $2)
         AND ($3::text IS NULL OR w.code = $3)
       ORDER BY v.instance_id
       LIMIT $4 OFFSET $5`,
      [
        query.part_id ?? null,
        query.condition ?? null,
        query.work_order_code ?? null,
        query.limit ?? DEFAULT_LIMIT,
        query.offset ?? 0,
      ],
    );
    return { items: rows.map((row) => this.toInstance(row)) };
  }

  async get(instanceId: number) {
    const [row]: InstanceRow[] = await this.dataSource.query(
      `${INSTANCE_SELECT} WHERE v.instance_id = $1`,
      [instanceId],
    );
    if (!row) {
      throw new NotFoundException('Part instance not found');
    }
    // Detalle de la receta: con cantidades y el disponible de cada repuesto, que es lo que
    // necesita el agente para decir si la unidad se puede reparar y cuánto costaría.
    const repairTools: unknown[] = await this.dataSource.query(
      `SELECT t.tool_id, t.code, t.name, rt.quantity, rt.notes
       FROM part_instance_repair_tool rt
       JOIN repair_tool t ON t.tool_id = rt.tool_id
       WHERE rt.instance_id = $1
       ORDER BY t.name`,
      [instanceId],
    );
    const repairComponents: unknown[] = await this.dataSource.query(
      `SELECT c.component_part_id AS part_id, p.sku, p.name, c.quantity, c.notes,
              COALESCE(a.available, 0)::int AS available
       FROM part_instance_repair_component c
       JOIN part p ON p.part_id = c.component_part_id
       LEFT JOIN v_part_availability a ON a.part_id = c.component_part_id
       WHERE c.instance_id = $1
       ORDER BY p.name`,
      [instanceId],
    );
    return {
      ...this.toInstance(row),
      repair_tools: repairTools,
      repair_components: repairComponents,
    };
  }

  async update(instanceId: number, dto: UpdatePartInstanceDto) {
    // Los campos del DTO existen siempre (en `undefined`); `null` sí es un valor enviado.
    const fields = PART_INSTANCE_FIELDS.filter(
      (field) => dto[field] !== undefined,
    );
    if (fields.length === 0) {
      throw new UnprocessableEntityException(
        `At least one of ${PART_INSTANCE_FIELDS.join(', ')} is required`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const [current]: InstanceRow[] = await manager.query(
        `SELECT instance_id, part_id, condition_code, work_order_id, note
         FROM part_instance WHERE instance_id = $1
         FOR UPDATE`,
        [instanceId],
      );
      if (!current) {
        throw new NotFoundException('Part instance not found');
      }
      await this.assertReferences(manager, dto);

      const [updated] = await updateReturning<InstanceRow>(
        manager,
        `UPDATE part_instance
         SET ${fields.map((field, i) => `${field} = $${i + 2}`).join(', ')}, updated_at = now()
         WHERE instance_id = $1
         RETURNING instance_id, part_id, condition_code, work_order_id, note`,
        [instanceId, ...fields.map((field) => dto[field])],
      );
      if (updated.condition_code !== current.condition_code) {
        await manager.query(
          `INSERT INTO part_status_history (part_id, instance_id, condition_code, work_order_id, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            updated.part_id,
            instanceId,
            updated.condition_code,
            updated.work_order_id,
            updated.note,
          ],
        );
      }
    });

    return this.get(instanceId);
  }

  private async assertReferences(
    manager: EntityManager,
    dto: UpdatePartInstanceDto,
  ): Promise<void> {
    if (dto.condition_code !== undefined) {
      const rows: unknown[] = await manager.query(
        'SELECT 1 FROM part_condition WHERE condition_code = $1',
        [dto.condition_code],
      );
      if (rows.length === 0) {
        throw new UnprocessableEntityException(
          `condition_code ${dto.condition_code} does not exist`,
        );
      }
    }
    if (dto.location_id != null) {
      const rows: unknown[] = await manager.query(
        'SELECT 1 FROM location WHERE location_id = $1',
        [dto.location_id],
      );
      if (rows.length === 0) {
        throw new NotFoundException(`Location ${dto.location_id} not found`);
      }
    }
    if (dto.work_order_id != null) {
      const rows: unknown[] = await manager.query(
        'SELECT 1 FROM work_order WHERE work_order_id = $1',
        [dto.work_order_id],
      );
      if (rows.length === 0) {
        throw new NotFoundException(
          `Work order ${dto.work_order_id} not found`,
        );
      }
    }
  }

  private toInstance(row: InstanceRow) {
    return { ...row, instance_id: toInt(row.instance_id) };
  }
}
