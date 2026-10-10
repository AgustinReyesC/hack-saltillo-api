import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { EnvelopeValidator } from '../src/ingest/envelope-validator.js';
import { IngestService } from '../src/ingest/ingest.service.js';
import { EventEnvelope } from '../src/outbox/event-envelope.js';
import { deleteMovements } from './fixtures.js';

// Los escenarios de `contract-tests/run_tests.py` del kit, con sus mismas comprobaciones, pero
// entregando los eventos al pipeline (`IngestService.process`) en vez de a la cola, y leyendo las
// salidas de `outbox_event`. Cada corrida usa ids propios (como las pruebas del kit) y al final
// borra lo suyo.

const RECEIVING = 100;
const STAGE = 'awaiting_full_inspection';

interface Part {
  part_id: number;
  sku: string | null;
  name: string;
  family: string;
  group: string;
  subgroup: null;
  unit: { id: number; name: string };
  image_url: null;
  active: boolean;
}

interface BomLine {
  bom_line_id: number;
  part_id: number | null;
  name: string;
  group_name: null;
  unit: { id: number; name: string };
  qty_per_unit: number | null;
  sort_order: number;
}

type Item = Record<string, unknown> & { inspection_item_id: number };

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('Pipeline de eventos: escenarios del contrato (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let ingest: IngestService;
  let validator: EnvelopeValidator;

  // 6 dígitos de corrida + 3 de consecutivo, como `run_tests.py`; por debajo de los ids de las
  // otras pruebas e2e (990 000 001).
  const run = randomInt(100_000, 900_000);
  let seq = 0;
  const id = () => run * 1000 + ++seq;
  const sku = (label: string) => `T${run}-${label}`;
  const published: string[] = [];
  const keys = new Set<string>();
  const codes = new Map<number, string>();

  const http = () => request(app.getHttpServer());

  // --- taller ---------------------------------------------------------------------------
  const publish = async (
    topic: string,
    eventType: string,
    key: string,
    data: object,
  ) => {
    const event: EventEnvelope = {
      event_id: randomUUID(),
      event_type: eventType,
      event_version: 1,
      occurred_at: nowIso(),
      source: 'shop-floor',
      key,
      data,
    };
    published.push(event.event_id);
    keys.add(key);
    return { event, outcome: await ingest.process(topic, event) };
  };

  const location = async (name: string, locationId?: number, code?: string) => {
    const lid = locationId ?? id();
    await publish('shop.catalog', 'location.upserted', `location:${lid}`, {
      location_id: lid,
      code:
        code ??
        (lid === RECEIVING
          ? 'U-100'
          : `U-${String(lid % 1000).padStart(3, '0')}`),
      name,
      is_workbench: false,
      active: true,
    });
    return lid;
  };

  const part = async (label: string, partSku: string | null = sku(label)) => {
    const created: Part = {
      part_id: id(),
      sku: partSku,
      name: `PIEZA DE PRUEBA ${label}`,
      family: 'REFACCIÓN',
      group: 'PRUEBAS',
      subgroup: null,
      unit: { id: 1, name: 'PIEZA' },
      image_url: null,
      active: true,
    };
    keys.add(`part:${created.part_id}`);
    await publish(
      'shop.catalog',
      'part.upserted',
      `part:${created.part_id}`,
      created,
    );
    return created;
  };

  const bom = async (lines: [Part | null, string, number | null][]) => {
    const modelId = id();
    const bomLines: BomLine[] = lines.map(([p, name, qty], index) => ({
      bom_line_id: id(),
      part_id: p?.part_id ?? null,
      name,
      group_name: null,
      unit: { id: 1, name: 'PIEZA' },
      qty_per_unit: qty,
      sort_order: index,
    }));
    await publish('shop.catalog', 'bom.upserted', `model:${modelId}`, {
      model_id: modelId,
      model_name: `MODELO ${run}`,
      brand: 'PRUEBA',
      lines: bomLines,
    });
    return { modelId, lines: bomLines };
  };

  const openWorkOrder = (workOrderId: number, modelId: number) =>
    publish('shop.work_orders', 'work_order.opened', codes.get(workOrderId)!, {
      work_order_id: workOrderId,
      code: codes.get(workOrderId),
      model_id: modelId,
      department: 'spindles',
      received_at: nowIso(),
    });

  const workOrder = async (modelId: number, open = true) => {
    const workOrderId = id();
    const code = `R${run}${String(seq % 1000).padStart(3, '0')}`;
    codes.set(workOrderId, code);
    keys.add(code);
    if (open) {
      await openWorkOrder(workOrderId, modelId);
    }
    return { workOrderId, code };
  };

  const item = (
    line: BomLine,
    condition = 'damaged',
    action: string | null = 'buy',
    quantity: number | null = 1,
  ): Item => ({
    inspection_item_id: id(),
    bom_line_id: line.bom_line_id,
    part_id: line.part_id,
    name: line.name,
    group_name: line.group_name,
    condition,
    action: condition === 'ok' ? null : action,
    quantity: condition === 'ok' ? null : quantity,
    note: null,
  });

  const inspect = async (
    workOrderId: number,
    items: Item[],
    kind = 'quick',
    approve = true,
  ) => {
    const inspectionId = id();
    const code = codes.get(workOrderId)!;
    const base = {
      inspection_id: inspectionId,
      work_order_id: workOrderId,
      kind,
      items,
    };
    await publish('shop.inspections', 'inspection.submitted', code, base);
    if (approve) {
      await publish('shop.inspections', 'inspection.approved', code, {
        ...base,
        approved_by: 12,
        approved_at: nowIso(),
      });
    }
    return inspectionId;
  };

  const receive = async (
    partNumber: string,
    quantity: number,
    workOrderCode: string | null = null,
    purpose = 'restock',
    price = '100.00',
  ) => {
    const number = String(id());
    const lineId = id() + 0;
    const requestId = id();
    keys.add(`purchase_line:${lineId}`);
    const { event } = await publish(
      'shop.purchasing',
      'purchase.item_received',
      `PR-${number}`,
      {
        purchase_request_id: requestId,
        request_number: number,
        line_id: lineId,
        part_number: partNumber,
        description: `compra ${partNumber}`,
        quantity,
        unit_price: price,
        currency: 'MXN',
        purpose,
        received_at: nowIso(),
        work_order_code: workOrderCode,
      },
    );
    return { event, lineId };
  };

  const stock = async (p: Part, quantity: number) => {
    const { lineId } = await receive(p.sku!, quantity);
    expect(
      await outputs('stock.received', { purchase_line_id: lineId }),
    ).toHaveLength(1);
  };

  // --- salidas ---------------------------------------------------------------------------
  const outputs = async (
    eventType: string,
    match: Record<string, unknown> = {},
  ): Promise<EventEnvelope<Record<string, unknown>>[]> => {
    const rows: { payload: EventEnvelope<Record<string, unknown>> }[] =
      await db.query(
        `SELECT payload FROM outbox_event
         WHERE topic = 'inventory.events' AND event_type = $1 AND event_key = ANY($2)
         ORDER BY created_at`,
        [eventType, [...keys]],
      );
    return rows
      .map((row) => row.payload)
      .filter((event) =>
        Object.entries(match).every(([k, v]) => event.data[k] === v),
      );
  };

  // --- API -------------------------------------------------------------------------------
  const availability = async (partId: number) =>
    (await http().get(`/parts/${partId}/availability`).expect(200)).body;

  const expectTotals = async (p: Part, onHand: number, reserved: number) => {
    const av = await availability(p.part_id);
    expect([av.on_hand, av.reserved, av.available]).toEqual([
      onHand,
      reserved,
      onHand - reserved,
    ]);
    return av;
  };

  const materials = async (code: string) =>
    (await http().get(`/work-orders/${code}/materials`).expect(200)).body;

  const lineOf = (
    body: { lines: { bom_line_id: number }[] },
    bomLineId: number,
  ) => body.lines.find((line) => line.bom_line_id === bomLineId);

  const waitFor = async <T>(check: () => Promise<T>, timeoutMs = 20_000) => {
    const start = Date.now();
    for (;;) {
      const result = await check();
      if (result) {
        return result;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error('Tiempo agotado esperando el resultado');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    db = app.get(DataSource);
    ingest = app.get(IngestService);
    validator = app.get(EnvelopeValidator);
    await location('Recepción de material', RECEIVING);
  });

  afterAll(async () => {
    if (db) {
      await cleanup(db, run, published, [...keys]);
    }
    await app?.close();
  });

  // --- libro mayor -----------------------------------------------------------------------
  it('recepcion_basica', async () => {
    const p = await part('A');
    const { lineId } = await receive(
      `  ${p.sku!.toLowerCase()} `,
      5,
      null,
      'restock',
      '1850.00',
    );
    const [received] = await outputs('stock.received', {
      purchase_line_id: lineId,
    });
    expect(received.data).toMatchObject({
      part_id: p.part_id,
      location_id: RECEIVING,
      quantity: 5,
      currency: 'MXN',
      unit_cost: '1850.00',
    });
    expect(received.key).toBe(`part:${p.part_id}`);
    const av = await expectTotals(p, 5, 0);
    expect(
      av.locations.find(
        (l: { location_id: number }) => l.location_id === RECEIVING,
      ).on_hand,
    ).toBe(5);
  });

  it('idempotencia', async () => {
    const p = await part('IDEM');
    const { event, lineId } = await receive(p.sku!, 4);
    expect(await ingest.process('shop.purchasing', event)).toBe('duplicate');
    expect(await ingest.process('shop.purchasing', event)).toBe('duplicate');
    expect(
      await outputs('stock.received', { purchase_line_id: lineId }),
    ).toHaveLength(1);
    await expectTotals(p, 4, 0);
  });

  it('salida_sin_negativos', async () => {
    const p = await part('NEG');
    await stock(p, 2);
    const { modelId } = await bom([[p, p.name, 2]]);
    const { code } = await workOrder(modelId);
    const body = {
      work_order_code: code,
      part_id: p.part_id,
      location_id: RECEIVING,
      quantity: 3,
      issued_by: 7,
    };
    await http().post('/issues').send(body).expect(409);
    await expectTotals(p, 2, 0);
    await http()
      .post('/issues')
      .send({ ...body, quantity: 2 })
      .expect(201);
    const [issued] = await outputs('stock.issued', { part_id: p.part_id });
    expect(issued.data).toMatchObject({ quantity: 2, location_id: RECEIVING });
    expect(issued.key).toBe(code);
    await expectTotals(p, 0, 0);
  });

  // El estante usa un código que ya tiene una ubicación del catálogo (U-020 en la semilla), como
  // pasa con las ubicaciones `U-0xx` que crean las pruebas del kit.
  const transferAndCount = async (label: string) => {
    const p = await part(label);
    await stock(p, 4);
    const shelf = await location('Estante de prueba', undefined, 'U-020');
    const body = {
      part_id: p.part_id,
      from_location_id: RECEIVING,
      to_location_id: shelf,
      quantity: 3,
    };
    await http()
      .post('/transfers')
      .send({ ...body, quantity: 5 })
      .expect(409);
    await http().post('/transfers').send(body).expect(201);
    expect(
      await outputs('stock.transferred', { part_id: p.part_id, quantity: 3 }),
    ).toHaveLength(1);
    const av = await expectTotals(p, 4, 0);
    const byLocation = Object.fromEntries(
      av.locations.map((l: { location_id: number; on_hand: number }) => [
        l.location_id,
        l.on_hand,
      ]),
    );
    expect(byLocation).toEqual({ [RECEIVING]: 1, [shelf]: 3 });

    await http()
      .post('/counts')
      .send({
        location_id: shelf,
        reason: '',
        lines: [{ part_id: p.part_id, counted_quantity: 2 }],
      })
      .expect(422);
    const res = await http()
      .post('/counts')
      .send({
        location_id: shelf,
        reason: 'conteo cíclico',
        lines: [{ part_id: p.part_id, counted_quantity: 2 }],
      })
      .expect(201);
    expect(res.body.adjustments).toEqual([{ part_id: p.part_id, delta: -1 }]);
    const [adjusted] = await outputs('stock.adjusted', { part_id: p.part_id });
    expect(adjusted.data).toMatchObject({
      delta: -1,
      reason: 'conteo cíclico',
    });
    await expectTotals(p, 3, 0);
    return p;
  };

  it('transferencia_y_conteo', async () => {
    await transferAndCount('TRF');
    // El código lo tiene la ubicación más reciente; la del catálogo queda apartada.
    const scan = await http().get('/scan?code=U-020').expect(200);
    expect(scan.body).toMatchObject({ kind: 'location', ambiguous: false });
  });

  it('kardex', async () => {
    const p = await transferAndCount('KDX');
    const { entries } = (
      await http().get(`/parts/${p.part_id}/ledger`).expect(200)
    ).body;
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(entries[0].balance).toBe(3);
    expect(entries.at(-1)).toMatchObject({ balance: 4, type: 'receipt' });
    expect(
      entries.reduce(
        (sum: number, e: { quantity: number }) => sum + e.quantity,
        0,
      ),
    ).toBe(3);
    const stamps = entries.map((e: { occurred_at: string }) => e.occurred_at);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  // --- integración con el taller -----------------------------------------------------------
  it('reserva_faltante_compra_y_salida', async () => {
    const p = await part('CICLO');
    await stock(p, 5);
    const {
      modelId,
      lines: [line],
    } = await bom([[p, p.name, 8]]);
    const { workOrderId, code } = await workOrder(modelId);
    const it8 = item(line, 'damaged', 'buy', 8);
    await inspect(workOrderId, [it8]);

    const reserved = await outputs('stock.reserved', {
      work_order_id: workOrderId,
      part_id: p.part_id,
    });
    expect(reserved.reduce((s, e) => s + (e.data.quantity as number), 0)).toBe(
      5,
    );
    expect(
      reserved.every(
        (e) =>
          e.data.inspection_item_id === it8.inspection_item_id &&
          e.key === code,
      ),
    ).toBe(true);
    const [shortage] = await outputs('stock.shortage_detected', {
      work_order_id: workOrderId,
    });
    expect(shortage.data).toMatchObject({
      missing_quantity: 3,
      part_id: p.part_id,
    });
    await expectTotals(p, 5, 5);

    expect(lineOf(await materials(code), line.bom_line_id)).toMatchObject({
      required: 8,
      reserved: 5,
      issued: 0,
      missing: 3,
    });
    const shortages = await http()
      .get(`/shortages?work_order_code=${code}`)
      .expect(200);
    expect(
      shortages.body.items.map(
        (s: { missing_quantity: number }) => s.missing_quantity,
      ),
    ).toEqual([3]);
    const suggested = await outputs('stock.reorder_suggested', {
      part_id: p.part_id,
    });
    expect(
      suggested.some(
        (e) =>
          (e.data.suggested_quantity as number) >= 3 &&
          (e.data.work_order_ids as number[]).includes(workOrderId),
      ),
    ).toBe(true);
    const suggestions = await http().get('/reorder-suggestions').expect(200);
    const mine = suggestions.body.items.find(
      (s: { part_id: number }) => s.part_id === p.part_id,
    );
    expect(mine.suggested_quantity).toBeGreaterThanOrEqual(3);
    expect(mine.work_order_ids).toContain(workOrderId);

    await receive(p.sku!, 3, code);
    expect(
      await outputs('stock.shortage_resolved', {
        work_order_id: workOrderId,
        part_id: p.part_id,
        quantity: 3,
      }),
    ).toHaveLength(1);
    await expectTotals(p, 8, 8);
    expect(
      (await http().get(`/shortages?work_order_code=${code}`).expect(200)).body
        .items,
    ).toEqual([]);

    await http()
      .post('/issues')
      .send({
        work_order_code: code,
        part_id: p.part_id,
        location_id: RECEIVING,
        quantity: 8,
        issued_by: 'tecnico-1',
      })
      .expect(201);
    await expectTotals(p, 0, 0);
    expect(lineOf(await materials(code), line.bom_line_id)).toMatchObject({
      reserved: 0,
      issued: 8,
      missing: 0,
    });
  });

  it('lineas_que_no_reservan', async () => {
    const [pRepair, pOk, pQty] = [
      await part('REP'),
      await part('OK'),
      await part('QTY'),
    ];
    for (const p of [pRepair, pOk, pQty]) {
      await stock(p, 10);
    }
    const {
      modelId,
      lines: [lRep, lOk, lNone, lQty],
    } = await bom([
      [pRepair, 'REPARAR', 1],
      [pOk, 'BIEN', 1],
      [null, 'KIT SIN IDENTIFICAR', 2],
      [pQty, 'SIN CANTIDAD', 3],
    ]);
    const { workOrderId } = await workOrder(modelId);
    await inspect(workOrderId, [
      item(lRep, 'damaged', 'repair', 1),
      item(lOk, 'ok'),
      item(lNone, 'missing', 'buy', 2),
      item(lQty, 'damaged', 'buy', null),
    ]);
    const unknown = (
      await outputs('stock.shortage_detected', { work_order_id: workOrderId })
    ).filter((e) => e.data.part_id === null);
    expect(unknown[0].data).toMatchObject({
      missing_quantity: 2,
      name: 'KIT SIN IDENTIFICAR',
    });
    const [reserved] = await outputs('stock.reserved', {
      work_order_id: workOrderId,
      part_id: pQty.part_id,
    });
    expect(reserved.data.quantity).toBe(3);
    expect(
      await outputs('stock.reserved', {
        work_order_id: workOrderId,
        part_id: pRepair.part_id,
      }),
    ).toEqual([]);
    expect(
      await outputs('stock.reserved', {
        work_order_id: workOrderId,
        part_id: pOk.part_id,
      }),
    ).toEqual([]);
    await expectTotals(pRepair, 10, 0);
  });

  it('compra_para_cliente', async () => {
    const p = await part('CLI');
    await stock(p, 1);
    const { lineId } = await receive(p.sku!, 6, null, 'customer_order');
    expect(
      await outputs('stock.received', { purchase_line_id: lineId }),
    ).toEqual([]);
    await expectTotals(p, 1, 0);
  });

  it('recepcion_sin_relacionar', async () => {
    const p = await part('MANUAL');
    const { lineId } = await receive(`PROV-${run}`, 2);
    expect(
      await outputs('stock.unmatched_receipt', { purchase_line_id: lineId }),
    ).toHaveLength(1);
    const pending = await http().get('/unmatched-receipts').expect(200);
    const mine = pending.body.items.find(
      (r: { purchase_line_id: number }) => r.purchase_line_id === lineId,
    );
    expect(mine).toBeDefined();
    await http()
      .post(`/unmatched-receipts/${mine.id}/resolve`)
      .send({ part_id: p.part_id })
      .expect(200);
    expect(
      await outputs('stock.received', {
        purchase_line_id: lineId,
        part_id: p.part_id,
      }),
    ).toHaveLength(1);
    await expectTotals(p, 2, 0);
    await http()
      .post(`/unmatched-receipts/${mine.id}/resolve`)
      .send({ part_id: p.part_id })
      .expect(409);

    const shared = sku('DUP');
    const twinA = await part('DUP-A', shared);
    await part('DUP-B', shared);
    const ambiguous = await receive(shared, 1);
    expect(
      await outputs('stock.unmatched_receipt', {
        purchase_line_id: ambiguous.lineId,
      }),
    ).toHaveLength(1);
    expect(
      await outputs('stock.received', { purchase_line_id: ambiguous.lineId }),
    ).toEqual([]);
    await expectTotals(twinA, 0, 0);
    // El escaneo de un sku compartido pide elegir.
    const scan = await http()
      .get(`/scan?code=${encodeURIComponent(shared)}`)
      .expect(200);
    expect(scan.body).toMatchObject({ kind: 'part', ambiguous: true });
  });

  it('necesidad_se_reemplaza', async () => {
    const p = await part('REEMP');
    await stock(p, 10);
    const {
      modelId,
      lines: [line],
    } = await bom([[p, p.name, 6]]);
    const { workOrderId, code } = await workOrder(modelId);
    await inspect(workOrderId, [item(line, 'damaged', 'buy', 2)]);
    await expectTotals(p, 10, 2);
    await inspect(workOrderId, [item(line, 'damaged', 'buy', 3)], 'full');
    await expectTotals(p, 10, 3);
    await inspect(workOrderId, [], 'full');
    await expectTotals(p, 10, 3);
    expect(lineOf(await materials(code), line.bom_line_id)).toMatchObject({
      required: 3,
      reserved: 3,
    });
  });

  it('rechazo_y_anulacion', async () => {
    const p = await part('ANUL');
    await stock(p, 2);
    const {
      modelId,
      lines: [line],
    } = await bom([[p, p.name, 4]]);
    const { workOrderId, code } = await workOrder(modelId);
    const rejected = await inspect(
      workOrderId,
      [item(line, 'damaged', 'buy', 1)],
      'quick',
      false,
    );
    await publish('shop.inspections', 'inspection.rejected', code, {
      inspection_id: rejected,
      work_order_id: workOrderId,
      reason: 'Revisar',
    });
    expect(
      await outputs('stock.reserved', { work_order_id: workOrderId }),
    ).toEqual([]);

    const approved = await inspect(workOrderId, [
      item(line, 'damaged', 'buy', 4),
    ]);
    await expectTotals(p, 2, 2);
    expect(
      await outputs('stock.shortage_detected', { work_order_id: workOrderId }),
    ).toHaveLength(1);
    await publish('shop.work_orders', 'work_order.stage_changed', code, {
      work_order_id: workOrderId,
      from_stage: STAGE,
      to_stage: 'quick_inspection',
    });
    await publish('shop.inspections', 'inspection.voided', code, {
      inspection_id: approved,
      work_order_id: workOrderId,
      reason: 'Se regresó la etapa',
    });
    await expectTotals(p, 2, 0);
    expect(
      (await http().get(`/shortages?work_order_code=${code}`).expect(200)).body
        .items,
    ).toEqual([]);
  });

  it('baja_de_orden', async () => {
    const p = await part('BAJA');
    await stock(p, 1);
    const {
      modelId,
      lines: [line],
    } = await bom([[p, p.name, 3]]);
    const { workOrderId, code } = await workOrder(modelId);
    await inspect(workOrderId, [item(line, 'damaged', 'buy', 3)]);
    await expectTotals(p, 1, 1);
    await publish('shop.work_orders', 'work_order.deleted', code, {
      work_order_id: workOrderId,
      code,
    });
    await expectTotals(p, 1, 0);
    expect(
      (await http().get(`/shortages?work_order_code=${code}`).expect(200)).body
        .items,
    ).toEqual([]);
    // Una compra posterior con su código entra como existencia general.
    await receive(p.sku!, 2, code);
    await expectTotals(p, 3, 0);
  });

  it('desorden', async () => {
    const modelId = id();
    const { workOrderId, code } = await workOrder(modelId, false);
    const late: Part = {
      part_id: id(),
      sku: sku('TARDE'),
      name: 'PIEZA QUE LLEGA TARDE',
      family: 'REFACCIÓN',
      group: 'PRUEBAS',
      subgroup: null,
      unit: { id: 1, name: 'PIEZA' },
      image_url: null,
      active: true,
    };
    keys.add(`part:${late.part_id}`);
    const line: BomLine = {
      bom_line_id: id(),
      part_id: late.part_id,
      name: late.name,
      group_name: null,
      unit: { id: 1, name: 'PIEZA' },
      qty_per_unit: 2,
      sort_order: 0,
    };
    await inspect(workOrderId, [item(line, 'damaged', 'buy', 2)]);
    expect(
      await outputs('stock.shortage_detected', { work_order_id: workOrderId }),
    ).toEqual([]);

    // Llegan en el orden contrario a sus dependencias: orden → lista de partes → pieza.
    expect((await openWorkOrder(workOrderId, modelId)).outcome).toBe('failed');
    expect(
      (
        await publish('shop.catalog', 'bom.upserted', `model:${modelId}`, {
          model_id: modelId,
          model_name: 'TARDE',
          brand: 'PRUEBA',
          lines: [line],
        })
      ).outcome,
    ).toBe('failed');
    await publish(
      'shop.catalog',
      'part.upserted',
      `part:${late.part_id}`,
      late,
    );

    await waitFor(
      async () =>
        (
          await outputs('stock.shortage_detected', {
            work_order_id: workOrderId,
            part_id: late.part_id,
          })
        ).length,
    );
    await receive(late.sku!, 2, code);
    expect(
      await outputs('stock.shortage_resolved', { work_order_id: workOrderId }),
    ).toHaveLength(1);
  });

  it('concurrencia', async () => {
    const p = await part('ULTIMA');
    await stock(p, 1);
    const {
      modelId,
      lines: [line],
    } = await bom([[p, p.name, 1]]);
    const orders = [];
    for (let i = 0; i < 4; i++) {
      orders.push(await workOrder(modelId));
    }
    // Cuatro aprobaciones a la vez, cada una en su transacción.
    await Promise.all(
      orders.map(({ workOrderId }) =>
        inspect(workOrderId, [item(line, 'damaged', 'buy', 1)]),
      ),
    );
    const ids = new Set(orders.map((o) => o.workOrderId));
    const shortages = (
      await outputs('stock.shortage_detected', { part_id: p.part_id })
    ).filter((e) => ids.has(e.data.work_order_id as number));
    expect(shortages.length).toBeGreaterThanOrEqual(3);
    const reserved = (
      await outputs('stock.reserved', { part_id: p.part_id })
    ).filter((e) => ids.has(e.data.work_order_id as number));
    expect(reserved.reduce((s, e) => s + (e.data.quantity as number), 0)).toBe(
      1,
    );
    await expectTotals(p, 1, 1);
  });

  // --- además del kit ----------------------------------------------------------------------
  it('un evento que no cumple el contrato va a la DLQ sin detener el consumo', async () => {
    const event = {
      event_id: randomUUID(),
      event_type: 'part.upserted',
      event_version: 1,
      occurred_at: nowIso(),
      source: 'shop-floor',
      key: `part:${id()}`,
      data: { part_id: 'no-es-entero' },
    };
    published.push(event.event_id);
    expect(await ingest.process('shop.catalog', event)).toBe('dead');
    const [dead]: { error: string }[] = await db.query(
      'SELECT error FROM dead_letter_event WHERE original_event_id = $1',
      [event.event_id],
    );
    expect(dead.error).toContain('part_id');
    const [copy]: { topic: string; event_key: string }[] = await db.query(
      'SELECT topic, event_key FROM outbox_event WHERE event_id = $1',
      [event.event_id],
    );
    expect(copy).toEqual({ topic: 'inventory.dlq', event_key: event.key });
  });

  it('todo evento de salida cumple su JSON Schema y trae la key del contrato', async () => {
    const rows: { payload: EventEnvelope<Record<string, unknown>> }[] =
      await db.query(
        `SELECT payload FROM outbox_event
         WHERE topic = 'inventory.events' AND event_key = ANY($1)`,
        [[...keys]],
      );
    expect(rows.length).toBeGreaterThan(40);
    const problems = rows.flatMap(({ payload }) => {
      const errors = validator.validateOutput(payload);
      const expectedKey = expectedKeyOf(payload);
      return [
        ...errors.map((e) => `${payload.event_type}: ${e}`),
        ...(payload.key === expectedKey
          ? []
          : [`${payload.event_type}: key ${payload.key} ≠ ${expectedKey}`]),
      ];
    });
    expect(problems).toEqual([]);
  });

  // Llave que pide el contrato (contract/README.md §2).
  function expectedKeyOf(event: EventEnvelope<Record<string, unknown>>) {
    if (event.event_type === 'stock.unmatched_receipt') {
      return `purchase_line:${event.data.purchase_line_id as number}`;
    }
    if ('work_order_id' in event.data) {
      return codes.get(event.data.work_order_id as number);
    }
    return `part:${event.data.part_id as number}`;
  }
});

// Borra lo que creó la corrida (ids entre run·1000 y run·1000+999) y le devuelve su código a la
// ubicación del catálogo que se apartó.
async function cleanup(
  db: DataSource,
  run: number,
  eventIds: string[],
  keys: string[],
) {
  const range = [run * 1000, run * 1000 + 999];
  await db.query('DELETE FROM event_inbox WHERE event_id = ANY($1::uuid[])', [
    eventIds,
  ]);
  await db.query(
    'DELETE FROM dead_letter_event WHERE original_event_id = ANY($1::uuid[])',
    [eventIds],
  );
  await db.query(
    'DELETE FROM outbox_event WHERE event_key = ANY($1) OR event_id = ANY($2::uuid[])',
    [keys, eventIds],
  );
  await deleteMovements(
    db,
    'part_id BETWEEN $1 AND $2 OR work_order_id BETWEEN $1 AND $2',
    range,
  );
  const statements = [
    'DELETE FROM reorder_suggestion WHERE part_id BETWEEN $1 AND $2',
    'DELETE FROM reservation WHERE work_order_id BETWEEN $1 AND $2 OR part_id BETWEEN $1 AND $2',
    'DELETE FROM shortage WHERE work_order_id BETWEEN $1 AND $2',
    'DELETE FROM work_order_need WHERE work_order_id BETWEEN $1 AND $2',
    'DELETE FROM unmatched_receipt WHERE purchase_line_id BETWEEN $1 AND $2',
    'DELETE FROM purchase_line WHERE line_id BETWEEN $1 AND $2',
    'DELETE FROM purchase_request WHERE purchase_request_id BETWEEN $1 AND $2',
    'DELETE FROM stock_balance WHERE part_id BETWEEN $1 AND $2 OR location_id BETWEEN $1 AND $2',
    'DELETE FROM inspection_item WHERE inspection_item_id BETWEEN $1 AND $2',
    'DELETE FROM inspection WHERE inspection_id BETWEEN $1 AND $2',
    'DELETE FROM work_order_stage WHERE work_order_id BETWEEN $1 AND $2',
    'DELETE FROM work_order WHERE work_order_id BETWEEN $1 AND $2',
    'DELETE FROM model_line WHERE bom_line_id BETWEEN $1 AND $2',
    'DELETE FROM model WHERE model_id BETWEEN $1 AND $2',
    'DELETE FROM part WHERE part_id BETWEEN $1 AND $2',
    'DELETE FROM location WHERE location_id BETWEEN $1 AND $2',
  ];
  for (const sql of statements) {
    await db.query(sql, range);
  }
  // Si varias apartaron el mismo código, se le devuelve a la de menor id (la del catálogo).
  await db.query(
    `UPDATE location l SET code = d.base, updated_at = now()
     FROM (SELECT DISTINCT ON (split_part(code, '~', 1))
                  location_id, split_part(code, '~', 1) AS base
           FROM location WHERE code LIKE '%~%'
           ORDER BY split_part(code, '~', 1), location_id) d
     WHERE l.location_id = d.location_id
       AND NOT EXISTS (SELECT 1 FROM location o WHERE o.code = d.base)`,
  );
}
