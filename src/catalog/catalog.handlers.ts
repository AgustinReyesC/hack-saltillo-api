import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  BomUpserted,
  InputEvent,
  LocationUpserted,
  PartUpserted,
  UnitData,
} from '../ingest/input-events.js';
import { EventEnvelope } from '../outbox/event-envelope.js';

const RECEIVING_CODE = 'U-100';

// Eventos de `shop.catalog`. Solo escriben catálogo: no mueven inventario ni emiten salidas.
@Injectable()
export class CatalogHandlers {
  async partUpserted(
    manager: EntityManager,
    event: InputEvent<PartUpserted>,
  ): Promise<EventEnvelope[]> {
    const part = event.data;
    await this.upsertUnit(manager, part.unit);
    // `sku_norm` es columna generada: no se escribe.
    await manager.query(
      `INSERT INTO part
         (part_id, sku, name, family, group_name, subgroup, unit_id, image_url, is_service, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (part_id) DO UPDATE
         SET sku = EXCLUDED.sku, name = EXCLUDED.name, family = EXCLUDED.family,
             group_name = EXCLUDED.group_name, subgroup = EXCLUDED.subgroup,
             unit_id = EXCLUDED.unit_id, image_url = EXCLUDED.image_url,
             is_service = EXCLUDED.is_service, active = EXCLUDED.active, updated_at = now()`,
      [
        part.part_id,
        part.sku,
        part.name,
        part.family,
        part.group,
        part.subgroup,
        part.unit?.id ?? null,
        part.image_url,
        part.family === 'SERVICIO',
        part.active,
      ],
    );
    return [];
  }

  async locationUpserted(
    manager: EntityManager,
    event: InputEvent<LocationUpserted>,
  ): Promise<EventEnvelope[]> {
    const location = event.data;
    // `location.code` es UNIQUE, pero el código lo trae el evento más reciente: si otra ubicación
    // lo tenía, se le aparta (`U-020~20`) hasta que llegue su propio upsert. Pasa, por ejemplo,
    // con los estantes que crean las pruebas de contrato (`U-0xx`) sobre el catálogo cargado.
    await manager.query(
      `UPDATE location SET code = code || '~' || location_id, updated_at = now()
       WHERE code = $2 AND location_id <> $1`,
      [location.location_id, location.code],
    );
    await manager.query(
      `INSERT INTO location (location_id, code, name, is_workbench, is_receiving, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (location_id) DO UPDATE
         SET code = EXCLUDED.code, name = EXCLUDED.name, is_workbench = EXCLUDED.is_workbench,
             is_receiving = EXCLUDED.is_receiving, active = EXCLUDED.active, updated_at = now()`,
      [
        location.location_id,
        location.code,
        location.name,
        location.is_workbench,
        location.code === RECEIVING_CODE,
        location.active,
      ],
    );
    return [];
  }

  // La lista de partes se reemplaza completa: las líneas que ya no vienen pasan a `active =
  // FALSE` (no se borran: las inspecciones las referencian).
  async bomUpserted(
    manager: EntityManager,
    event: InputEvent<BomUpserted>,
  ): Promise<EventEnvelope[]> {
    const bom = event.data;
    await manager.query(
      `INSERT INTO model (model_id, model_name, brand) VALUES ($1, $2, $3)
       ON CONFLICT (model_id) DO UPDATE
         SET model_name = EXCLUDED.model_name, brand = EXCLUDED.brand, updated_at = now()`,
      [bom.model_id, bom.model_name, bom.brand],
    );
    for (const line of bom.lines) {
      await this.upsertUnit(manager, line.unit);
      await manager.query(
        `INSERT INTO model_line
           (bom_line_id, model_id, part_id, name, group_name, unit_id, qty_per_unit, sort_order,
            active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
         ON CONFLICT (bom_line_id) DO UPDATE
           SET model_id = EXCLUDED.model_id, part_id = EXCLUDED.part_id, name = EXCLUDED.name,
               group_name = EXCLUDED.group_name, unit_id = EXCLUDED.unit_id,
               qty_per_unit = EXCLUDED.qty_per_unit, sort_order = EXCLUDED.sort_order,
               active = TRUE, updated_at = now()`,
        [
          line.bom_line_id,
          bom.model_id,
          line.part_id,
          line.name,
          line.group_name,
          line.unit?.id ?? null,
          line.qty_per_unit,
          line.sort_order,
        ],
      );
    }
    await manager.query(
      `UPDATE model_line SET active = FALSE, updated_at = now()
       WHERE model_id = $1 AND active AND NOT (bom_line_id = ANY($2::int[]))`,
      [bom.model_id, bom.lines.map((line) => line.bom_line_id)],
    );
    return [];
  }

  private async upsertUnit(
    manager: EntityManager,
    unit: UnitData | null,
  ): Promise<void> {
    if (!unit) {
      return;
    }
    await manager.query(
      `INSERT INTO unit (unit_id, name) VALUES ($1, $2)
       ON CONFLICT (unit_id) DO UPDATE SET name = EXCLUDED.name`,
      [unit.id, unit.name],
    );
  }
}
