import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommitmentsService } from '../commitments/commitments.service.js';
import {
  MovementRow,
  toInt,
  toIso,
  toMovement,
} from '../common/serialization.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { PartsQueryDto } from './dto/parts-query.dto.js';
import {
  REORDER_POLICY_FIELDS,
  UpdateReorderPolicyDto,
} from './dto/update-reorder-policy.dto.js';

const DEFAULT_LIMIT = 100;

// Columnas de `v_part_agent_summary`; los SUM/COUNT se convierten a int en SQL.
const SUMMARY_COLUMNS = `
  s.part_id, s.sku, s.name, s.family, s.active,
  s.on_hand::int, s.reserved::int, s.available::int,
  s.functional_units::int, s.defective_units::int, s.under_repair_units::int,
  s.total_units::int, s.open_shortages::int`;

interface PolicyRow {
  part_id: number;
  min_quantity: number;
  max_quantity: number | null;
  reorder_quantity: number | null;
  lead_time_days: number | null;
  updated_at: Date;
}

@Injectable()
export class PartsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly commitments: CommitmentsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async list(query: PartsQueryDto) {
    const where: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.q) {
      const like = param(`%${query.q}%`);
      where.push(`(s.sku ILIKE ${like} OR s.name ILIKE ${like})`);
    }
    if (query.sku) {
      where.push(
        `s.part_id IN (SELECT part_id FROM part WHERE sku_norm = lower(btrim(${param(query.sku)})))`,
      );
    }
    if (query.condition) {
      where.push(
        `EXISTS (SELECT 1 FROM part_instance i WHERE i.part_id = s.part_id AND i.condition_code = ${param(query.condition)})`,
      );
    }
    if (query.available !== undefined) {
      where.push(query.available ? 's.available > 0' : 's.available <= 0');
    }

    const items: unknown[] = await this.dataSource.query(
      `SELECT ${SUMMARY_COLUMNS}
       FROM v_part_agent_summary s
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.part_id
       LIMIT ${param(query.limit ?? DEFAULT_LIMIT)} OFFSET ${param(query.offset ?? 0)}`,
      params,
    );
    return { items };
  }

  async get(partId: number) {
    const [part]: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT p.part_id, p.sku, p.name, p.family, p.group_name, p.subgroup, p.image_url,
              p.is_service, p.active,
              CASE WHEN u.unit_id IS NULL THEN NULL
                   ELSE json_build_object('id', u.unit_id, 'name', u.name) END AS unit
       FROM part p
       LEFT JOIN unit u ON u.unit_id = p.unit_id
       WHERE p.part_id = $1`,
      [partId],
    );
    if (!part) {
      throw new NotFoundException('Part not found');
    }
    const [summary]: Record<string, number>[] = await this.dataSource.query(
      `SELECT ${SUMMARY_COLUMNS} FROM v_part_agent_summary s WHERE s.part_id = $1`,
      [partId],
    );
    const [policy]: PolicyRow[] = await this.dataSource.query(
      'SELECT * FROM reorder_policy WHERE part_id = $1',
      [partId],
    );

    return {
      ...part,
      on_hand: summary.on_hand,
      reserved: summary.reserved,
      available: summary.available,
      units: {
        functional: summary.functional_units,
        defective: summary.defective_units,
        under_repair: summary.under_repair_units,
        total: summary.total_units,
      },
      open_shortages: summary.open_shortages,
      reorder_policy: policy ? this.toPolicy(policy) : null,
    };
  }

  async availability(partId: number) {
    const [totals]: { on_hand: number; reserved: number; available: number }[] =
      await this.dataSource.query(
        `SELECT on_hand::int, reserved::int, available::int
         FROM v_part_availability WHERE part_id = $1`,
        [partId],
      );
    if (!totals) {
      throw new NotFoundException('Part not found');
    }
    // La reserva se lleva a nivel pieza: por ubicación se reporta en 0 (API README §6.7).
    const locations: { location_id: number; code: string; on_hand: number }[] =
      await this.dataSource.query(
        `SELECT b.location_id, l.code, b.on_hand
         FROM stock_balance b
         JOIN location l ON l.location_id = b.location_id
         WHERE b.part_id = $1 AND b.on_hand <> 0
         ORDER BY b.location_id`,
        [partId],
      );

    return {
      part_id: partId,
      ...totals,
      locations: locations.map((location) => ({
        ...location,
        reserved: 0,
        available: location.on_hand,
      })),
    };
  }

  async ledgerEntries(partId: number) {
    await this.assertPartExists(partId);
    const rows: (MovementRow & { balance: string })[] =
      await this.dataSource.query(
        `SELECT movement_id, type, part_id, location_id, quantity, occurred_at, reference, balance
         FROM v_part_ledger
         WHERE part_id = $1
         ORDER BY occurred_at DESC, movement_id DESC`,
        [partId],
      );
    return {
      part_id: partId,
      entries: rows.map((row) => ({
        ...toMovement(row),
        balance: toInt(row.balance),
      })),
    };
  }

  async updateReorderPolicy(partId: number, dto: UpdateReorderPolicyDto) {
    // Los campos del DTO existen siempre (en `undefined`); `null` sí es un valor enviado.
    const fields = REORDER_POLICY_FIELDS.filter(
      (field) => dto[field] !== undefined,
    );
    if (fields.length === 0) {
      throw new UnprocessableEntityException(
        `At least one of ${REORDER_POLICY_FIELDS.join(', ')} is required`,
      );
    }

    const { policy, events } = await this.dataSource.transaction(
      async (manager) => {
        await this.ledger.assertPartsExist(manager, [partId]);
        await this.ledger.lockParts(manager, [partId]);

        const values = fields.map((field) => dto[field]);
        const [row]: PolicyRow[] = await manager.query(
          `INSERT INTO reorder_policy (part_id, ${fields.join(', ')})
           VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')})
           ON CONFLICT (part_id) DO UPDATE SET
             ${fields.map((field) => `${field} = EXCLUDED.${field}`).join(', ')},
             updated_at = now()
           RETURNING *`,
          [partId, ...values],
        );
        // Cambiar el mínimo o la cantidad de reorden puede crear o cambiar la sugerencia.
        const suggestion = await this.commitments.recomputeSuggestion(
          manager,
          partId,
        );
        return { policy: row, events: suggestion ? [suggestion] : [] };
      },
    );

    this.realtime.notify(events);
    return this.toPolicy(policy);
  }

  private async assertPartExists(partId: number): Promise<void> {
    const rows: unknown[] = await this.dataSource.query(
      'SELECT 1 FROM part WHERE part_id = $1',
      [partId],
    );
    if (rows.length === 0) {
      throw new NotFoundException('Part not found');
    }
  }

  private toPolicy(row: PolicyRow) {
    return {
      part_id: row.part_id,
      min_quantity: row.min_quantity,
      max_quantity: row.max_quantity,
      reorder_quantity: row.reorder_quantity,
      lead_time_days: row.lead_time_days,
      updated_at: toIso(row.updated_at),
    };
  }
}
