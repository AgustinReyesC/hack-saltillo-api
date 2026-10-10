import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

// Etiqueta de una pieza sin `sku` (contrato §5). Hasta 9 dígitos: cabe en INTEGER.
const PART_ID_LABEL = /^P-(\d{1,9})$/i;

const PART_COLUMNS = `
  p.part_id, p.sku, p.name, p.family, p.active,
  COALESCE(a.on_hand, 0)::int AS on_hand, COALESCE(a.reserved, 0)::int AS reserved,
  COALESCE(a.available, 0)::int AS available`;

export interface ScanResult {
  code: string;
  kind: 'location' | 'part' | 'unknown';
  // Más de una coincidencia (un `sku` compartido): la UI pide elegir (contrato §5).
  ambiguous: boolean;
  matches: unknown[];
}

// Resuelve lo que leyó la cámara del celular (Code 128). La decodificación es del navegador; aquí
// solo se identifica: ubicación por `code`, pieza por `sku` tal cual (con sus espacios, puntos,
// comas y diagonales), por `P-<part_id>` o, si nada coincide, por `sku` sin mayúsculas ni
// espacios en los extremos.
@Injectable()
export class ScanService {
  constructor(private readonly dataSource: DataSource) {}

  async resolve(raw: string): Promise<ScanResult> {
    // Algunos lectores agregan un salto de línea al final; el contenido no se toca.
    const code = raw.replace(/[\r\n]+$/, '');

    const locations: unknown[] = await this.dataSource.query(
      `SELECT location_id, code, name, is_workbench, is_receiving, active
       FROM location WHERE upper(code) = upper($1) ORDER BY location_id`,
      [code],
    );
    if (locations.length > 0) {
      return this.result(code, 'location', locations);
    }

    let parts = await this.parts('p.sku = $1', code);
    const label = PART_ID_LABEL.exec(code);
    if (parts.length === 0 && label) {
      parts = await this.parts('p.part_id = $1::int', label[1]);
    }
    if (parts.length === 0) {
      parts = await this.parts('p.sku_norm = lower(btrim($1))', code);
    }
    return this.result(code, parts.length > 0 ? 'part' : 'unknown', parts);
  }

  private parts(condition: string, value: string): Promise<unknown[]> {
    return this.dataSource.query(
      `SELECT ${PART_COLUMNS}
       FROM part p
       LEFT JOIN v_part_availability a ON a.part_id = p.part_id
       WHERE ${condition}
       ORDER BY p.part_id`,
      [value],
    );
  }

  private result(
    code: string,
    kind: ScanResult['kind'],
    matches: unknown[],
  ): ScanResult {
    return { code, kind, ambiguous: matches.length > 1, matches };
  }
}
