import { DataSource } from 'typeorm';

// Datos propios de las pruebas e2e, con ids altos para no chocar con la semilla ni con el taller.
// Se crean antes y se borran después, para no dejar rastro en la base de desarrollo.
export const TEST_PART = 990_000_001;
export const TEST_PART_SKU = 'E2E-PART-1';
export const TEST_WORK_ORDER = 990_000_001;
export const TEST_WORK_ORDER_CODE = 'R999999901';
export const TEST_INSPECTION_ITEM = 990_000_001;
export const TEST_PURCHASE_REQUEST = 990_000_001;
export const TEST_PURCHASE_LINE = 990_000_001;
// Id que no existe en ningún catálogo; nunca usar un id bajo: el catálogo real empieza en 1.
export const MISSING_PART = 989_999_999;
export const RECEIVING = 100;
export const SHELF = 101;

const TEST_KEYS = [`part:${TEST_PART}`, TEST_WORK_ORDER_CODE];

export async function createFixtures(db: DataSource): Promise<void> {
  await removeFixtures(db);
  await db.query(
    `INSERT INTO part (part_id, sku, name, family, active)
     VALUES ($1, $2, 'PIEZA DE PRUEBA E2E', 'REFACCIÓN', TRUE)`,
    [TEST_PART, TEST_PART_SKU],
  );
  await db.query(
    `INSERT INTO work_order (work_order_id, code, department, received_at)
     VALUES ($1, $2, 'spindles', now())`,
    [TEST_WORK_ORDER, TEST_WORK_ORDER_CODE],
  );
  await db.query(
    `INSERT INTO inspection (inspection_id, work_order_id, kind, status, approved_at)
     VALUES ($1, $2, 'quick', 'approved', now())`,
    [TEST_INSPECTION_ITEM, TEST_WORK_ORDER],
  );
  await db.query(
    `INSERT INTO inspection_item
       (inspection_item_id, inspection_id, part_id, name, condition, action, quantity)
     VALUES ($1, $1, $2, 'PIEZA DE PRUEBA E2E', 'missing', 'buy', 3)`,
    [TEST_INSPECTION_ITEM, TEST_PART],
  );
  // Recepción que el taller no pudo relacionar con el catálogo.
  await db.query(
    `INSERT INTO purchase_request (purchase_request_id, request_number)
     VALUES ($1, 'E2E-PR-1')`,
    [TEST_PURCHASE_REQUEST],
  );
  await db.query(
    `INSERT INTO purchase_line
       (line_id, purchase_request_id, part_number, description, quantity, unit_price, currency,
        purpose, match_status, received_at, work_order_code)
     VALUES ($1, $2, 'E2E-DESCONOCIDA', 'Pieza sin relacionar', 4, 12.50, 'MXN',
             'restock', 'unmatched', now(), $3)`,
    [TEST_PURCHASE_LINE, TEST_PURCHASE_REQUEST, TEST_WORK_ORDER_CODE],
  );
  await db.query(
    `INSERT INTO unmatched_receipt
       (purchase_line_id, part_number, description, quantity, unit_price, currency, received_at,
        work_order_code)
     VALUES ($1, 'E2E-DESCONOCIDA', 'Pieza sin relacionar', 4, 12.50, 'MXN', now(), $2)`,
    [TEST_PURCHASE_LINE, TEST_WORK_ORDER_CODE],
  );
}

// Faltante abierto de la orden de prueba, como lo dejaría una inspección aprobada.
export async function openShortage(
  db: DataSource,
  missing: number,
): Promise<void> {
  await db.query(
    `INSERT INTO shortage (work_order_id, part_id, name, missing_quantity, inspection_item_id)
     VALUES ($1, $2, 'PIEZA DE PRUEBA E2E', $3, $4)`,
    [TEST_WORK_ORDER, TEST_PART, missing, TEST_INSPECTION_ITEM],
  );
}

export async function unmatchedReceiptId(db: DataSource): Promise<number> {
  const [row]: { id: string }[] = await db.query(
    'SELECT id FROM unmatched_receipt WHERE purchase_line_id = $1',
    [TEST_PURCHASE_LINE],
  );
  return Number(row.id);
}

export async function removeFixtures(db: DataSource): Promise<void> {
  const requests: { purchase_request_id: number }[] = await db.query(
    `SELECT DISTINCT purchase_request_id FROM purchase_line
     WHERE part_id = $1 OR line_id = $2`,
    [TEST_PART, TEST_PURCHASE_LINE],
  );
  const requestIds = [
    TEST_PURCHASE_REQUEST,
    ...requests.map((row) => row.purchase_request_id),
  ];

  await db.query('DELETE FROM outbox_event WHERE event_key = ANY($1)', [
    TEST_KEYS,
  ]);
  await db.query('DELETE FROM reorder_suggestion WHERE part_id = $1', [
    TEST_PART,
  ]);
  await db.query('DELETE FROM reorder_policy WHERE part_id = $1', [TEST_PART]);
  await db.query(
    'DELETE FROM reservation WHERE work_order_id = $1 OR part_id = $2',
    [TEST_WORK_ORDER, TEST_PART],
  );
  await db.query('DELETE FROM shortage WHERE work_order_id = $1', [
    TEST_WORK_ORDER,
  ]);
  await db.query('DELETE FROM unmatched_receipt WHERE purchase_line_id = $1', [
    TEST_PURCHASE_LINE,
  ]);
  await db.query(
    'DELETE FROM purchase_line WHERE purchase_request_id = ANY($1::int[])',
    [requestIds],
  );
  await db.query(
    'DELETE FROM purchase_order WHERE purchase_request_id = ANY($1::int[])',
    [requestIds],
  );
  await db.query(
    'DELETE FROM purchase_request WHERE purchase_request_id = ANY($1::int[])',
    [requestIds],
  );
  await db.query('DELETE FROM movement WHERE part_id = $1', [TEST_PART]);
  await db.query('DELETE FROM stock_balance WHERE part_id = $1', [TEST_PART]);
  await db.query('DELETE FROM inspection_item WHERE inspection_item_id = $1', [
    TEST_INSPECTION_ITEM,
  ]);
  await db.query('DELETE FROM inspection WHERE inspection_id = $1', [
    TEST_INSPECTION_ITEM,
  ]);
  await db.query('DELETE FROM work_order WHERE work_order_id = $1', [
    TEST_WORK_ORDER,
  ]);
  await db.query('DELETE FROM part WHERE part_id = $1', [TEST_PART]);
}

export async function hasPartInstances(db: DataSource): Promise<boolean> {
  const [row]: { exists: boolean }[] = await db.query(
    "SELECT to_regclass('public.part_instance') IS NOT NULL AS exists",
  );
  return row.exists;
}
