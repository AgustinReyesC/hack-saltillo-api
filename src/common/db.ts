import { EntityManager } from 'typeorm';

// En Postgres, TypeORM devuelve `[filas, afectadas]` para UPDATE/DELETE (no solo las filas),
// incluso con RETURNING. Este helper devuelve siempre las filas.
export async function updateReturning<T>(
  manager: EntityManager,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const [rows]: [T[], number] = await manager.query(sql, params);
  return rows;
}
