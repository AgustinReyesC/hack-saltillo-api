import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import {
  MISSING_PART,
  RECEIVING,
  SHELF,
  TEST_INSPECTION_ITEM,
  TEST_PART,
  TEST_PART_SKU,
  TEST_PURCHASE_LINE,
  TEST_WORK_ORDER,
  TEST_WORK_ORDER_CODE,
  createFixtures,
  hasPartInstances,
  openShortage,
  removeFixtures,
  unmatchedReceiptId,
} from './fixtures.js';

interface Notification {
  event_type: string;
  key: string;
  source: string;
  data: Record<string, unknown>;
}

// Recorre los comandos del contrato en orden sobre una pieza de prueba: cada paso parte del
// saldo que dejó el anterior.
describe('Inventario (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let socket: Socket;
  let instancesReady: boolean;
  const notifications: Notification[] = [];

  const http = () => request(app.getHttpServer());

  const waitFor = async (check: () => boolean, timeoutMs = 2000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for a WebSocket message');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const availability = async () =>
    (await http().get(`/parts/${TEST_PART}/availability`).expect(200)).body;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.listen(0);

    db = app.get(DataSource);
    await createFixtures(db);
    instancesReady = await hasPartInstances(db);

    const { port } = app.getHttpServer().address() as AddressInfo;
    socket = io(`http://localhost:${port}`, { transports: ['websocket'] });
    socket.on('notification', (event: Notification) =>
      notifications.push(event),
    );
    await new Promise<void>((resolve) => socket.on('connect', resolve));
  });

  afterAll(async () => {
    socket?.disconnect();
    if (db) {
      await removeFixtures(db);
    }
    await app?.close();
  });

  describe('POST /counts', () => {
    it('registra un ajuste por la diferencia y avisa a la UI', async () => {
      const res = await http()
        .post('/counts')
        .send({
          location_id: RECEIVING,
          reason: 'conteo e2e',
          lines: [{ part_id: TEST_PART, counted_quantity: 10 }],
        })
        .expect(201);

      expect(res.body).toEqual({
        adjustments: [{ part_id: TEST_PART, delta: 10 }],
      });
      await waitFor(() =>
        notifications.some((e) => e.event_type === 'stock.adjusted'),
      );
      expect(
        notifications.find((e) => e.event_type === 'stock.adjusted'),
      ).toMatchObject({
        key: `part:${TEST_PART}`,
        source: 'inventory',
        data: {
          part_id: TEST_PART,
          location_id: RECEIVING,
          delta: 10,
          reason: 'conteo e2e',
        },
      });
    });

    it('sin diferencia no ajusta nada', async () => {
      const res = await http()
        .post('/counts')
        .send({
          location_id: RECEIVING,
          reason: 'conteo e2e',
          lines: [{ part_id: TEST_PART, counted_quantity: 10 }],
        })
        .expect(201);

      expect(res.body).toEqual({ adjustments: [] });
    });

    it('sin motivo responde 422', async () => {
      const res = await http()
        .post('/counts')
        .send({ location_id: RECEIVING, reason: ' ', lines: [] })
        .expect(422);

      expect(res.body.detail).toContain('reason');
    });

    it('una pieza o ubicación inexistente responde 404', async () => {
      await http()
        .post('/counts')
        .send({
          location_id: RECEIVING,
          reason: 'x',
          lines: [{ part_id: MISSING_PART, counted_quantity: 1 }],
        })
        .expect(404);
      await http()
        .post('/counts')
        .send({ location_id: 999_999, reason: 'x', lines: [] })
        .expect(404);
    });
  });

  describe('POST /transfers', () => {
    it('mueve existencia entre ubicaciones sin cambiar el total', async () => {
      const res = await http()
        .post('/transfers')
        .send({
          part_id: TEST_PART,
          from_location_id: RECEIVING,
          to_location_id: SHELF,
          quantity: 3,
        })
        .expect(201);

      expect(res.body).toMatchObject({
        type: 'transfer_out',
        part_id: TEST_PART,
        location_id: RECEIVING,
        quantity: -3,
        transfer_in_movement_id: expect.any(Number),
      });
      expect(res.body.occurred_at).toMatch(/Z$/);
      expect(await availability()).toEqual({
        part_id: TEST_PART,
        on_hand: 10,
        reserved: 0,
        available: 10,
        locations: [
          {
            location_id: RECEIVING,
            code: 'U-100',
            on_hand: 7,
            reserved: 0,
            available: 7,
          },
          {
            location_id: SHELF,
            code: 'U-101',
            on_hand: 3,
            reserved: 0,
            available: 3,
          },
        ],
      });
    });

    it('responde 409 si no alcanza en el origen y 422 si origen = destino', async () => {
      await http()
        .post('/transfers')
        .send({
          part_id: TEST_PART,
          from_location_id: SHELF,
          to_location_id: RECEIVING,
          quantity: 50,
        })
        .expect(409);
      await http()
        .post('/transfers')
        .send({
          part_id: TEST_PART,
          from_location_id: SHELF,
          to_location_id: SHELF,
          quantity: 1,
        })
        .expect(422);
    });
  });

  describe('GET /parts/{part_id}/ledger', () => {
    it('lista del más reciente al más antiguo con el saldo después de cada movimiento', async () => {
      const res = await http().get(`/parts/${TEST_PART}/ledger`).expect(200);

      expect(
        res.body.entries.map((e: { type: string; balance: number }) => [
          e.type,
          e.balance,
        ]),
      ).toEqual([
        ['transfer_in', 10],
        ['transfer_out', 7],
        ['adjustment', 10],
      ]);
    });

    it('un part_id que no es entero responde 404', async () => {
      await http().get('/parts/abc/ledger').expect(404);
    });
  });

  describe('POST /issues', () => {
    it('baja el saldo de la ubicación contra la orden', async () => {
      const res = await http()
        .post('/issues')
        .send({
          work_order_code: TEST_WORK_ORDER_CODE,
          part_id: TEST_PART,
          location_id: SHELF,
          quantity: 2,
          issued_by: 'tecnico-1',
        })
        .expect(201);

      expect(res.body).toMatchObject({
        type: 'issue',
        location_id: SHELF,
        quantity: -2,
        reference: TEST_WORK_ORDER_CODE,
      });
      await waitFor(() =>
        notifications.some((e) => e.event_type === 'stock.issued'),
      );
    });

    it('responde 409 sin mover nada si no alcanza en la ubicación', async () => {
      await http()
        .post('/issues')
        .send({
          work_order_code: TEST_WORK_ORDER_CODE,
          part_id: TEST_PART,
          location_id: SHELF,
          quantity: 5,
          issued_by: 7,
        })
        .expect(409);

      expect((await availability()).on_hand).toBe(8);
    });

    it('una orden inexistente responde 404', async () => {
      await http()
        .post('/issues')
        .send({
          work_order_code: 'R000000000',
          part_id: TEST_PART,
          location_id: SHELF,
          quantity: 1,
          issued_by: 7,
        })
        .expect(404);
    });
  });

  describe('POST /unmatched-receipts/{id}/resolve', () => {
    it('registra la entrada en U-100 y surte el faltante de la orden', async () => {
      await openShortage(db, 3);
      const receiptId = await unmatchedReceiptId(db);

      const listed = await http().get('/unmatched-receipts').expect(200);
      expect(listed.body.items).toContainEqual(
        expect.objectContaining({
          id: receiptId,
          purchase_line_id: TEST_PURCHASE_LINE,
          unit_price: '12.50',
        }),
      );

      const res = await http()
        .post(`/unmatched-receipts/${receiptId}/resolve`)
        .send({ part_id: TEST_PART })
        .expect(200);

      expect(res.body).toMatchObject({
        type: 'receipt',
        part_id: TEST_PART,
        location_id: RECEIVING,
        quantity: 4,
        reference: `purchase_line:${TEST_PURCHASE_LINE}`,
      });
      expect(await availability()).toMatchObject({
        on_hand: 12,
        reserved: 3,
        available: 9,
      });

      const shortages = await http()
        .get(`/shortages?work_order_code=${TEST_WORK_ORDER_CODE}`)
        .expect(200);
      expect(shortages.body.items).toEqual([]);

      await waitFor(() =>
        notifications.some((e) => e.event_type === 'stock.shortage_resolved'),
      );
      expect(
        notifications.find((e) => e.event_type === 'stock.received')?.data,
      ).toEqual({
        part_id: TEST_PART,
        location_id: RECEIVING,
        quantity: 4,
        unit_cost: '12.50',
        currency: 'MXN',
        purchase_line_id: TEST_PURCHASE_LINE,
      });
      expect(
        notifications.find((e) => e.event_type === 'stock.reserved'),
      ).toMatchObject({
        key: TEST_WORK_ORDER_CODE,
        data: {
          work_order_id: TEST_WORK_ORDER,
          part_id: TEST_PART,
          quantity: 3,
          inspection_item_id: TEST_INSPECTION_ITEM,
          reservation_id: expect.any(Number),
        },
      });
    });

    it('resolverla otra vez responde 409', async () => {
      const receiptId = await unmatchedReceiptId(db);
      await http()
        .post(`/unmatched-receipts/${receiptId}/resolve`)
        .send({ part_id: TEST_PART })
        .expect(409);
    });

    it('la salida de la orden consume primero su reserva', async () => {
      await http()
        .post('/issues')
        .send({
          work_order_code: TEST_WORK_ORDER_CODE,
          part_id: TEST_PART,
          location_id: RECEIVING,
          quantity: 3,
          issued_by: 7,
        })
        .expect(201);

      expect(await availability()).toMatchObject({
        on_hand: 9,
        reserved: 0,
        available: 9,
      });
      const [reservation]: { status: string }[] = await db.query(
        'SELECT status FROM reservation WHERE work_order_id = $1',
        [TEST_WORK_ORDER],
      );
      expect(reservation.status).toBe('fulfilled');
    });
  });

  describe('PATCH /parts/{part_id}', () => {
    it('guarda la política y crea la sugerencia de reabasto', async () => {
      const res = await http()
        .patch(`/parts/${TEST_PART}`)
        .send({ min_quantity: 50, reorder_quantity: 10 })
        .expect(200);

      expect(res.body).toMatchObject({
        part_id: TEST_PART,
        min_quantity: 50,
        reorder_quantity: 10,
        max_quantity: null,
      });
      const suggestions = await http().get('/reorder-suggestions').expect(200);
      expect(suggestions.body.items).toContainEqual({
        part_id: TEST_PART,
        sku: TEST_PART_SKU,
        name: 'PIEZA DE PRUEBA E2E',
        suggested_quantity: 41,
        work_order_ids: [],
      });
    });

    it('sin campos responde 422 y una pieza inexistente 404', async () => {
      await http().patch(`/parts/${TEST_PART}`).send({}).expect(422);
      await http()
        .patch(`/parts/${MISSING_PART}`)
        .send({ min_quantity: 1 })
        .expect(404);
    });
  });

  describe('POST /purchase-orders', () => {
    it('crea la orden con ids en el rango propio de la API', async () => {
      const res = await http()
        .post('/purchase-orders')
        .send({
          supplier_id: 1,
          expected_at: '2026-10-20T00:00:00Z',
          lines: [{ part_id: TEST_PART, quantity: 5, unit_price: '12.50' }],
        })
        .expect(201);

      expect(res.body).toMatchObject({
        supplier_id: 1,
        status: 'open',
        currency: 'MXN',
        expected_at: '2026-10-20T00:00:00.000Z',
        lines: [
          {
            part_id: TEST_PART,
            part_number: TEST_PART_SKU,
            quantity: 5,
            unit_price: '12.50',
            purpose: 'restock',
          },
        ],
      });
      expect(res.body.purchase_request_id).toBeGreaterThanOrEqual(
        1_500_000_000,
      );
    });

    it('un proveedor inexistente responde 404 y un importe inválido 422', async () => {
      await http()
        .post('/purchase-orders')
        .send({
          supplier_id: 999_999,
          lines: [{ part_id: TEST_PART, quantity: 1, unit_price: '1.00' }],
        })
        .expect(404);
      await http()
        .post('/purchase-orders')
        .send({
          supplier_id: 1,
          lines: [{ part_id: TEST_PART, quantity: 1, unit_price: 12.5 }],
        })
        .expect(422);
    });
  });

  describe('GET /events', () => {
    it('lista los eventos generados en outbox_event', async () => {
      const res = await http()
        .get('/events?origin=outbox&status=pending&limit=500')
        .expect(200);

      const types = res.body.items
        .filter((e: { key: string }) => e.key === `part:${TEST_PART}`)
        .map((e: { event_type: string }) => e.event_type);
      expect(types).toEqual(
        expect.arrayContaining([
          'stock.adjusted',
          'stock.transferred',
          'stock.received',
          'stock.reorder_suggested',
        ]),
      );
    });
  });

  describe('WebSocket', () => {
    it('POST /agent/messages llega a la UI como agent:message', async () => {
      const received = new Promise((resolve) =>
        socket.once('agent:message', resolve),
      );

      await http()
        .post('/agent/messages')
        .send({ message: 'Te faltan 3 piezas', data: { part_id: TEST_PART } })
        .expect(202);

      await expect(received).resolves.toMatchObject({
        message: 'Te faltan 3 piezas',
        data: { part_id: TEST_PART },
      });
    });

    it('parts:list responde los productos (requiere la migración 011)', async (ctx) => {
      if (!instancesReady) {
        ctx.skip();
      }
      const response = await socket
        .timeout(2000)
        .emitWithAck('parts:list', { sku: TEST_PART_SKU });

      expect(response.items).toEqual([
        expect.objectContaining({ part_id: TEST_PART, on_hand: 9 }),
      ]);
    });
  });

  describe('Unidades físicas (requiere la migración 011)', () => {
    it('GET /parts y GET /part-instances responden', async (ctx) => {
      if (!instancesReady) {
        ctx.skip();
      }
      const parts = await http().get(`/parts?sku=${TEST_PART_SKU}`).expect(200);
      expect(parts.body.items[0]).toMatchObject({
        part_id: TEST_PART,
        on_hand: 9,
        total_units: 0,
      });
      await http().get('/part-instances?limit=5').expect(200);
    });
  });
});
