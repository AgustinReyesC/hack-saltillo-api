import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  LocationsQueryDto,
  StockBalancesQueryDto,
} from './dto/locations-query.dto.js';

const LOCATION_COLUMNS =
  'location_id, code, name, is_workbench, is_receiving, active';

// Ubicaciones y existencias por ubicación para la UI: catálogo para resolver etiquetas, lo que el
// sistema espera en una ubicación (conteo cíclico) y la tabla de existencias del almacén.
@Injectable()
export class LocationsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: LocationsQueryDto) {
    const items: unknown[] = await this.dataSource.query(
      `SELECT ${LOCATION_COLUMNS} FROM location
       WHERE ($1::text IS NULL OR upper(code) = upper($1))
         AND ($2::boolean IS NULL OR active = $2)
       ORDER BY code`,
      [query.code ?? null, query.active ?? null],
    );
    return { items };
  }

  async stock(locationId: number) {
    const [location]: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT ${LOCATION_COLUMNS} FROM location WHERE location_id = $1`,
      [locationId],
    );
    if (!location) {
      throw new NotFoundException('Location not found');
    }
    const items: unknown[] = await this.dataSource.query(
      `SELECT b.part_id, p.sku, p.name, b.on_hand, b.reserved, b.available
       FROM stock_balance b
       JOIN part p ON p.part_id = b.part_id
       WHERE b.location_id = $1 AND (b.on_hand <> 0 OR b.reserved <> 0)
       ORDER BY p.name, b.part_id`,
      [locationId],
    );
    return { ...location, items };
  }

  async balances(query: StockBalancesQueryDto) {
    const items: unknown[] = await this.dataSource.query(
      `SELECT b.part_id, p.sku, p.name, b.location_id, l.code AS location_code,
              b.on_hand, b.reserved, b.available
       FROM stock_balance b
       JOIN part p     ON p.part_id = b.part_id
       JOIN location l ON l.location_id = b.location_id
       WHERE (b.on_hand <> 0 OR b.reserved <> 0)
         AND ($1::int IS NULL OR b.location_id = $1)
         AND ($2::int IS NULL OR b.part_id = $2)
       ORDER BY b.part_id, b.location_id`,
      [query.location_id ?? null, query.part_id ?? null],
    );
    return { items };
  }
}
