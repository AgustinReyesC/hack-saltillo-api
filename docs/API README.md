# API de inventario — guía para empezar a construirla

Para quien construye la API (NestJS). Reúne lo necesario para escribirla sin volver a leer el kit
ni las migraciones: qué eventos consume, qué escribe en cada tabla, qué eventos publica, qué rutas
expone y qué huecos tiene el esquema.

- **Estructura de datos:** manda la base `hack-saltillo-db` (migraciones `001`–`011`). La API no crea ni altera tablas.
- **Contrato:** el kit `hackathon-inventario-kit/contract` manda sobre todo lo demás.
- **Esta guía no pide cambios a la base.** Lo que el esquema no cubre está en la sección 12 como brecha.

## 0. Reglas que no se negocian

1. Nombres y formas de rutas y eventos del contrato son fijos. Se pueden **agregar** campos y rutas.
2. No se modifica el simulador ni el formato de los eventos de entrada.
3. `event_inbox.event_id` es PK: reprocesar un evento no cambia nada ni emite salidas.
4. `movement` es la fuente de verdad; `stock_balance` es proyección (borrarla y reagregar da lo mismo).
5. `available = on_hand - reserved` no baja de 0 por reservas ni salidas. Solo `POST /counts` puede dejarlo negativo.
6. Importes como texto decimal (`"1850.00"`), cantidades enteras, fechas ISO 8601 UTC terminadas en `Z`.
7. Errores `{"detail": "..."}`, listas `{"items": [...]}`, sin autenticación en las rutas del contrato.

## 1. Estado del repo y configuración

`hack-saltillo-api` es NestJS 12 en ESM (`"type": "module"`: los imports llevan `.js`). Ya tiene
`ConfigModule` global y TypeORM conectado a Postgres (`synchronize: false`, `autoLoadEntities: true`);
`main.ts` escucha HTTP en `8000` (el puerto de las pruebas de contrato) y, con certificado, HTTPS en `8443`
para el celular; el CORS depende de `NODE_ENV` (`src/common/server-config.ts`).
Cada script carga su archivo de entorno con `node --env-file`, por eso `ConfigModule` usa `ignoreEnvFile`.

Ya instaladas: `class-validator` + `class-transformer` (`ValidationPipe` global con 422) y
`@nestjs/websockets` + `@nestjs/platform-socket.io` (WebSocket con la UI, sección 8.3), `@aws-sdk/client-sqs`
(consumo y publicación) y `ajv` + `ajv-formats` (validan el sobre contra `contract/schemas`, copia del kit). El
consumo no usa `@nestjs/microservices`: en un `@EventPattern`, Nest atrapa la excepción del handler y el
transporte no se entera de que falló, y el pipeline necesita saberlo para revertir la transacción y dejar el
evento pendiente (sección 4). El consumidor es un servicio propio con un despachador por `event_type`.

Comunicación: el **agente** habla con la API por **REST** (HTTP) y la **UI** por **WebSocket** (socket.io en
el mismo puerto `8000`; la API es el servidor). La autenticación con JWT queda **pospuesta**.

Variables de entorno. `.env.local` (`npm run start` / `start:dev`) y `.env` (`npm run start:prod`) llevan
las mismas llaves; `.env.example` las documenta con placeholders.

| Variable | Valor local | Nota |
|---|---|---|
| `NODE_ENV` | `local` | `local` en `.env.local`, `dev` en `.env`. |
| `PORT` | `8000` | Puerto que usan las pruebas de contrato. |
| `CORS_ORIGINS` | (vacío) | Orígenes de la UI (HTTP y WebSocket), separados por coma. En `local` se suman a `localhost` y las IP de la red local; en `dev` es obligatorio (CloudFront). |
| `HTTPS_PORT` / `HTTPS_KEY_PATH` / `HTTPS_CERT_PATH` | `8443` / `certs/local-key.pem` / `certs/local-cert.pem` | HTTPS para el celular (`npm run cert:local -- <ip>`). Vacías = solo HTTP. |
| `DATABASE_HOST` / `DATABASE_PORT` | `localhost` / `5432` | En ECS, el endpoint del RDS compartido. |
| `DATABASE_NAME` / `DATABASE_USER` / `DATABASE_PASSWORD` | `inventario` ×3 | Valores por defecto de `hack-saltillo-db`. |
| `DATABASE_SSL` | `false` | `true` contra RDS. |
| `AWS_REGION` | región de las colas | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | credenciales IAM | Solo en local. En ECS se dejan vacías: usa el rol de la tarea. |
| `SQS_SHOP_CATALOG_URL`, `SQS_SHOP_WORK_ORDERS_URL`, `SQS_SHOP_INSPECTIONS_URL`, `SQS_SHOP_PURCHASING_URL` | URL de cada cola de entrada | |
| `SQS_NOTIFICATIONS_URL` | URL de la cola de notificaciones | Entrada: eventos del mensaje del usuario al agente (flujo "pregunta del agente"). |
| `SQS_INVENTORY_EVENTS_URL` / `SQS_INVENTORY_DLQ_URL` | URL de las colas de salida | |
| `AGENT_URL` | | URL del agente. |

Colas (SQS FIFO, todas con el prefijo `inventory-broker-`): entrada `inventory-broker-shop-catalog.fifo`,
`inventory-broker-shop-work-orders.fifo`, `inventory-broker-shop-inspections.fifo`,
`inventory-broker-shop-purchasing.fifo` y `inventory-broker-notifications.fifo`; salida
`inventory-broker-inventory-events.fifo` e `inventory-broker-inventory-dlq.fifo`. El simulador manda sus
eventos a las cuatro `shop-*`. La deduplicación basada en contenido está **desactivada** en todas: cada
envío debe llevar `MessageDeduplicationId`.

Levantar el entorno: base en `hack-saltillo-db` (`docker compose up -d`). Las colas son SQS real en AWS,
también para las pruebas locales.

## 2. Arquitectura propuesta

```
 shop-catalog.fifo ──────┐
 shop-work-orders.fifo ──┤   Consumer ──► Pipeline ──► Handlers ──────► Postgres (local / RDS)
 shop-inspections.fifo ──┤   (SQS)       (dedup,       (reglas de          ▲   ▲
 shop-purchasing.fifo ───┤               reintento)     negocio)           │   │
 notifications.fifo ─────┘                  │                │             │   │
                                            └─ fallo ─► dead_letter_event  │   │
                                                             └► outbox_event ──► Publisher ──► inventory-events.fifo
                                                                            │                   inventory-dlq.fifo
 HTTP :8000  contrato + extensión + agente ───── lee / escribe ─────────────┘
 WebSocket :8000 (socket.io) ◄── notification / agent:message / parts:list ──► UI
```

En el diagrama las colas van sin el prefijo `inventory-broker-`. La API **no** consume sus colas de salida:
en SQS cada mensaje lo recibe un solo consumidor, así que si las leyera se llevaría sus propios eventos.

Módulos sugeridos:

| Módulo | Responsabilidad |
|---|---|
| `ingest` | Consumidor SQS de las cinco colas de entrada (`sqs-consumer.ts`), validación del sobre, pipeline (sección 4, `ingest.service.ts`), despachador por `event_type` y publicador de `outbox_event`. Los handlers viven en cada dominio (`catalog`, `work-orders`, `inspections`, `purchasing`). |
| `ledger` | `movement` y `stock_balance`: única puerta para cambiar existencia. |
| `commitments` | Reservas, faltantes y sugerencias de reabasto. |
| `outbox` | Publicador de `outbox_event` y DLQ. |
| `inventory-http` | Rutas del contrato (sección 7). |
| `purchasing`, `parts`, `part-instances`, `agent`, `health` | Rutas de extensión (sección 8) y lógica del agente (sección 10). `part-instances` es la capa de unidades físicas (estado y receta de reparación por unidad). |
| `realtime` | Gateway de WebSocket (socket.io) con la UI (sección 8.3). |

## 3. Eventos de entrada

### 3.1 Sobre

```json
{ "event_id": "uuid", "event_type": "inspection.approved", "event_version": 1,
  "occurred_at": "2026-10-06T16:42:11Z", "source": "shop-floor", "key": "R061026012", "data": {} }
```

En la entrada todos los campos de `data` vienen siempre (los opcionales como `null`) y no hay campos
extra. Se valida contra `contract/schemas/input/<event_type>.schema.json`.

### 3.2 Colas y llaves

| Cola (tópico del simulador) | Eventos | `key` |
|---|---|---|
| `inventory-broker-shop-catalog.fifo` (`shop.catalog`) | `part.upserted`, `location.upserted`, `bom.upserted` | `part:305`, `location:14`, `model:4` |
| `inventory-broker-shop-work-orders.fifo` (`shop.work_orders`) | `work_order.opened`, `.stage_changed`, `.deleted` | código de orden (`R061026012`) |
| `inventory-broker-shop-inspections.fifo` (`shop.inspections`) | `inspection.submitted`, `.approved`, `.rejected`, `.discarded`, `.voided` | código de orden |
| `inventory-broker-shop-purchasing.fifo` (`shop.purchasing`) | `purchase.item_received` | `PR-` + `request_number` |
| `inventory-broker-notifications.fifo` (`notifications`) | Eventos que genera el mensaje del usuario al agente (tipos por definir) | por definir |

El `key` del sobre va como `MessageGroupId` y el `event_id` como `MessageDeduplicationId` (obligatorio:
la deduplicación por contenido está desactivada). En `event_inbox.topic` se guarda el nombre del tópico
(`shop.catalog`, …), que es el que usan los schemas del contrato; para la cola de notificaciones, `notifications`.

Los eventos de `notifications` usan el mismo sobre y la API decide qué hacer según su `event_type`, como
con los del simulador. El contrato no los define: cuando se fijen sus tipos hay que registrarlos con su
propio schema, porque el paso 1 del pipeline manda a la DLQ cualquier `event_type` desconocido.

Garantías: al menos una vez (duplicados: la deduplicación de SQS dura solo 5 minutos y un mensaje
reaparece si vence su *visibility timeout*), orden solo por llave dentro de una cola, **sin orden entre
colas**. SQS **no** retiene lo consumido: borra cada mensaje al confirmarlo y guarda los pendientes 14 días
como máximo; el historial vive en `event_inbox`. El dataset trae 1,742 entregas, 65 duplicadas.

### 3.3 Qué escribe cada evento

`event_inbox` se escribe siempre primero (sección 4). Lo de abajo es la proyección a dominio.

| Evento y campos de `data` | Escribe |
|---|---|
| **`part.upserted`** `part_id, sku, name, family, group, subgroup, unit{id,name}\|null, image_url, active` | `unit` upsert (si `unit` ≠ null). `part` upsert por `part_id`: `group`→`group_name`, `unit.id`→`unit_id`, `is_service = (family = 'SERVICIO')`, `updated_at = now()`. `sku_norm` es generada, no se escribe. |
| **`location.upserted`** `location_id, code, name, is_workbench, active` | `location` upsert; `is_receiving = (code = 'U-100')`. |
| **`bom.upserted`** `model_id, model_name, brand, lines[{bom_line_id, part_id\|null, name, group_name\|null, unit\|null, qty_per_unit\|null, sort_order}]` | `model` upsert. `model_line` upsert por `bom_line_id` con `active = TRUE`; las líneas del modelo que **ya no vengan** pasan a `active = FALSE` (no se borran: `inspection_item` las referencia). |
| **`work_order.opened`** `work_order_id, code, model_id, department, received_at` | `work_order` upsert. En conflicto **no** pisar `stage` ni `deleted`; por defecto `stage = 'awaiting_quick_inspection'`. |
| **`work_order.stage_changed`** `work_order_id, from_stage, to_stage` | `work_order.stage = to_stage`; inserta en `work_order_stage` (`occurred_at` del sobre, `event_id`). |
| **`work_order.deleted`** `work_order_id, code` | `work_order.deleted = TRUE`; libera reservas activas y cierra faltantes abiertos (sección 6.4). |
| **`inspection.submitted`** `inspection_id, work_order_id, kind, items[]` | `inspection` upsert (`status = 'submitted'`, `submitted_at`); upsert de `inspection_item`. No mueve inventario. |
| **`inspection.approved`** `inspection_id, work_order_id, kind, items[], approved_by, approved_at` | `inspection.status = 'approved'`, `approved_by`, `approved_at` (crea la fila si no hubo `submitted`). Upsert de items. **Única que genera necesidad** (sección 6.3). |
| **`inspection.rejected`** `inspection_id, work_order_id, reason` | `inspection.status = 'rejected'`, `reason`. |
| **`inspection.discarded`** `inspection_id, work_order_id` | `inspection.status = 'discarded'`. |
| **`inspection.voided`** `inspection_id, work_order_id, reason` | `inspection.status = 'voided'`, `reason`; libera reservas y cierra faltantes de esa inspección (sección 6.4). |
| **`purchase.item_received`** `purchase_request_id, request_number, line_id, part_number, description, quantity, unit_price, currency, purpose, received_at, work_order_code\|null` | `purchase_request` y `purchase_line` upsert; luego sección 6.2. |

Campos de `inspection_item` (`items[]`): `inspection_item_id, bom_line_id, part_id|null, name, group_name|null,
condition (ok|damaged|missing), action (buy|repair|null), quantity|null, note|null`. El esquema del
contrato garantiza: `ok` ⇒ `action` y `quantity` null; `missing` ⇒ `action = 'buy'`; `damaged` ⇒ `buy` o `repair`.

Etapas válidas: `awaiting_quick_inspection, quick_inspection, awaiting_full_inspection, full_inspection,
cleaning, assembly, run_in, final_assembly, final_release`. Departamentos: `spindles, motors, electronics, torque_center`.

Detalles que no son obvios:

- `inspection_item` se **upsertea** por `inspection_item_id`; no borrar y reinsertar, porque `reservation` y
  `shortage` lo referencian por FK sin cascada.
- `inspection_item_id` es PK global (no por inspección).
- `inspection.approved_by` es `INTEGER`.

### 3.4 Dependencias (FK) que obligan a esperar

El esquema tiene llaves foráneas reales. Si falta la fila referenciada, el evento **no se descarta**
(regla 20): queda pendiente y se reintenta cuando llegue lo que falta.

| Evento | Necesita que ya exista |
|---|---|
| `bom.upserted` | `part` de cada `part_id` ≠ null; `unit` (se crea con el evento). |
| `work_order.opened` | `model` (`model_id`). |
| `work_order.stage_changed` / `.deleted` | `work_order`. |
| `inspection.submitted` / `.approved` | `work_order`; por item: `model_line` (`bom_line_id`) y `part` (`part_id` ≠ null). |
| `inspection.rejected` / `.discarded` / `.voided` | `inspection`. |
| `purchase.item_received` | Nada obligatorio. `work_order_code` desconocido ⇒ `purchase_request.work_order_id = NULL` (el código queda en `purchase_line.work_order_code`). |
| Recepción a `U-100` | `location` con `location_id = 100`. |

Casos reales del dataset: inspecciones antes de su `work_order.opened`, inspecciones antes del
`part.upserted` de su pieza, e inventario inicial como compras sin orden dos días antes de la primera orden.

## 4. Pipeline de procesamiento

Por cada mensaje:

1. Validar el sobre (JSON Schema). Si es inválido o el `event_type` es desconocido ⇒ `dead_letter_event` + `inventory-broker-inventory-dlq.fifo`, borrar el mensaje y seguir.
2. **Dedup.** Buscar `event_id` en `event_inbox`. Si existe con `status = 'processed'` ⇒ borrar el mensaje y salir sin hacer nada.
3. Abrir transacción. Tomar los candados (sección 4.2).
4. Insertar/actualizar la fila de `event_inbox` (`topic`, `event_key`, `payload` = sobre completo, `occurred_at`).
5. Ejecutar el handler del `event_type` (escrituras de dominio + filas en `outbox_event`).
6. `event_inbox.status = 'processed'`, `processed_at = now()`; `COMMIT`.
7. Borrar el mensaje de la cola (`DeleteMessage`). Equivale a confirmar el offset.

En una cola FIFO, mientras un mensaje de un grupo está en vuelo SQS no entrega los siguientes de ese
grupo. Por eso un evento que falla no se deja en la cola: se guarda en `event_inbox` como `failed` y se borra (4.1).

**Cuidados con el esquema**

- `event_inbox.status` tiene `DEFAULT 'processed'` (los docs de `spec/` dicen `received`). **Escribir siempre el status explícito.**
- No usar `ON CONFLICT DO NOTHING` a ciegas como dedup: un evento en `failed` que vuelve a llegar debe reintentarse. Duplicado = ya `processed`.

### 4.1 Reintento y DLQ

- Falta de dependencia (sección 3.4, `SQLSTATE 23503` u omisión explícita): `ROLLBACK`, guardar el evento en `event_inbox` con `status = 'failed'` y `error`, borrar el mensaje de SQS y **no detener el consumo**.
- Un worker reintenta las filas `status <> 'processed'` (hay índice parcial `idx_event_inbox_status`) en orden de `occurred_at`: al terminar de procesar un evento de catálogo, y por temporizador.
- Tras N intentos o un tiempo máximo ⇒ `dead_letter_event` (`original_event_id`, `payload`, `error`, `retries`) y publicar el original en `inventory-broker-inventory-dlq.fifo` con su misma `key` (`MessageGroupId`). No hay tabla de cola aparte: `event_inbox` es la cola de reintentos.
- Si el mensaje ni siquiera se puede guardar en `event_inbox` (p. ej., la base no responde), **no** se borra: SQS lo vuelve a entregar al vencer el *visibility timeout* y, tras `maxReceiveCount` intentos, la *redrive policy* de la cola lo mueve a `inventory-broker-inventory-dlq.fifo`.

### 4.2 Concurrencia

La regla 8 se prueba con aprobaciones simultáneas de órdenes distintas (llaves distintas ⇒ grupos FIFO
distintos, que SQS entrega en paralelo y hasta a procesos distintos), y las compras llegan por otra cola.
El orden por llave **no** protege el saldo.

- Antes de tocar saldo o reservas de una pieza: `SELECT pg_advisory_xact_lock(part_id)`, tomando varios `part_id` **en orden ascendente** (evita deadlocks).
- Al reemplazar necesidad de una orden: `SELECT … FROM work_order WHERE work_order_id = $1 FOR UPDATE`.
- El mismo candado aplica a los comandos HTTP (`/issues`, `/transfers`, `/counts`, `/resolve`).

### 4.3 Arranque en frío y reconstrucción

Al arrancar, y siempre que se reconstruya desde cero, **vaciar `inventory-broker-shop-catalog.fifo` antes** de leer las
demás colas (regla 22). Con SQS: consumir solo catálogo hasta que `GetQueueAttributes` reporte
`ApproximateNumberOfMessages` y `ApproximateNumberOfMessagesNotVisible` en 0 (son aproximados: confirmar con
un par de `ReceiveMessage` vacíos), y luego iniciar el resto. Si no, las compras llegan antes que sus piezas
y todas caen a revisión manual.

SQS no permite releer lo ya consumido. Reconstruir una base desde cero requiere volver a mandar los eventos:
el simulador reenvía el archivo completo en cada arranque.

## 5. Eventos de salida

Mismo sobre, `source = "inventory"`, `event_version = 1`, `event_id` UUID nuevo. Se **encolan en
`outbox_event` dentro de la misma transacción** que el cambio; `payload` guarda el sobre completo. En la
salida se pueden agregar campos extra, los pedidos son obligatorios. Se validan contra
`contract/schemas/output/*`.

| Evento | `key` | `data` (obligatorio) | Cuándo |
|---|---|---|---|
| `stock.received` | `part:<part_id>` | `part_id, location_id, quantity, unit_cost` (texto), `currency, purchase_line_id` | Entrada en `U-100` (o al resolver una recepción). |
| `stock.unmatched_receipt` | `purchase_line:<line_id>` | `purchase_line_id, part_number, description, quantity` | Compra `restock` sin pieza única. |
| `stock.reserved` | código de orden | `reservation_id, work_order_id, part_id, quantity, inspection_item_id` | Por cada reserva (también al surtir faltante). `quantity` es lo que se reservó **en ese paso**. |
| `stock.shortage_detected` | código de orden | `work_order_id, part_id` (puede ser null)`, name, missing_quantity` (puede ser null)`, inspection_item_id` | Nace o cambia un faltante. |
| `stock.shortage_resolved` | código de orden | `work_order_id, part_id, quantity` | Una entrada surte un faltante. |
| `stock.issued` | código de orden | `work_order_id, part_id, location_id, quantity, issued_by` | `POST /issues`. |
| `stock.transferred` | `part:<part_id>` | `part_id, from_location_id, to_location_id, quantity` | `POST /transfers`. |
| `stock.adjusted` | `part:<part_id>` | `part_id, location_id, delta` (≠ 0)`, reason` | Una por línea con diferencia en `POST /counts`. |
| `stock.reorder_suggested` | `part:<part_id>` | `part_id, suggested_quantity` (≥ 1)`, work_order_ids` (únicos) | Nace o cambia la sugerencia. |

No hay evento para liberar una reserva (regla 15) ni para cerrar un faltante porque bajó la necesidad.
**No inventar tipos nuevos en `inventory-broker-inventory-events.fifo`:** las pruebas leen toda la cola y validan cada evento
contra su schema.

**Publicador:**

```sql
SELECT event_id, event_type, event_key, topic, payload
FROM outbox_event
WHERE published_at IS NULL
ORDER BY created_at
LIMIT 100
FOR UPDATE SKIP LOCKED;
-- SendMessage a la cola de `topic` con MessageGroupId = event_key,
--   MessageDeduplicationId = event_id y MessageBody = payload
-- UPDATE outbox_event SET published_at = now() WHERE event_id = ANY($1);
```

`outbox_event.topic` conserva el nombre lógico (`inventory.events` por defecto en la base); la API lo
traduce a la URL de la cola (`SQS_INVENTORY_EVENTS_URL`).

Entrega al menos una vez: publicar y luego marcar. Un reinicio entre ambas puede repetir un evento de
salida con el mismo `event_id`; es aceptable (si pasa dentro de 5 minutos, SQS FIFO lo descarta por
`MessageDeduplicationId`).

## 6. Reglas de negocio

Todas dentro de una transacción con los candados de la sección 4.2.

### 6.1 Saldo

Toda variación de existencia = una fila en `movement`. Desde la migración 015 de `hack-saltillo-db`,
`trg_movement_apply_balance` recalcula `stock_balance.on_hand` como la suma de los movimientos de la pieza
en esa ubicación, y `trg_movement_immutable` prohíbe editar o borrar movimientos. La API **no** escribe
`on_hand`; solo administra `reserved` (sección 6.7). Cada movimiento lleva su trazabilidad (012):
`work_order_id` e `issued_by` en las salidas, `purchase_line_id` en las entradas y `transfer_group_id` en las
dos mitades de una transferencia.

Signo de `movement.quantity`: `receipt` +, `issue` −, `transfer_out` −, `transfer_in` +, `adjustment` = delta
(CHECK `quantity <> 0`). `available` es columna generada: no se escribe.

### 6.2 Recepción de compra (`purchase.item_received`)

1. Upsert `purchase_request` (`request_number` único; `work_order_id` por código si existe) y `purchase_line`
   (`match_status = 'pending'`, `unit_price` y `currency` del evento, `received_at`).
2. `purpose = 'customer_order'` ⇒ **terminar**: no entra al inventario, no surte faltantes, no emite nada.
3. `purpose = 'restock'`: candidatas = `SELECT part_id FROM part WHERE sku_norm = lower(btrim($part_number))`
   (vacío ⇒ sin candidatas).
   - 0 o ≥ 2 candidatas ⇒ `unmatched_receipt` (`status = 'pending'`, `UNIQUE (purchase_line_id)`), `purchase_line.match_status = 'unmatched'`, emitir `stock.unmatched_receipt`.
   - Exactamente 1 ⇒ `purchase_line.part_id`, `match_status = 'matched'`; `movement` `receipt` (+qty) en `location_id = 100`
     (`unit_cost = unit_price`, `reference = 'purchase_line:<line_id>'`, `occurred_at = received_at`); `stock_balance`;
     emitir `stock.received`; luego surtir faltantes (6.5).

### 6.3 Necesidad, reserva y faltante (`inspection.approved`)

Solo los items con `action = 'buy'` (`damaged`/`missing`) generan necesidad. `repair` y `ok` no.
La necesidad vive por **(orden, `bom_line_id`)** y **se reemplaza**; una línea que la aprobación no
menciona conserva la suya; `full` con `items: []` no cambia nada.

Por cada item `buy`, en orden de `bom_line_id`:

```
need = item.quantity ?? model_line.qty_per_unit          -- NULL si ambos son NULL
activa    = Σ reservation.quantity  (status 'active')    de la línea (orden, bom_line_id)
entregada = Σ reservation.quantity  (status 'fulfilled') de la línea
resto     = max(need - entregada, 0)
```

| Caso | Efecto |
|---|---|
| `part_id` = NULL | Faltante sin identificar: `shortage` con `part_id NULL`, `name = item.name`, `missing_quantity = need`; `stock.shortage_detected`; **nunca** reserva. |
| `need` = NULL | Faltante con `missing_quantity = NULL`; no reserva. |
| `resto < activa` | Liberar `activa - resto`: bajar `quantity` o pasar a `cancelled` (CHECK `quantity > 0`). Sin evento. |
| `resto ≥ activa` | `grant = min(resto - activa, disponible_total)`, con `disponible_total = Σ on_hand - Σ reserved` (≥ 0). Si `grant > 0` ⇒ crear/subir `reservation`, `stock_balance.reserved += grant`, `stock.reserved` con `grant`. |
| Sobra | `falta = resto - activa - grant`. Si `falta > 0` ⇒ upsert **un** `shortage` abierto de la línea con `missing_quantity = falta` y `stock.shortage_detected`. Si `= 0` ⇒ cerrar el faltante abierto (sin evento). |

Siempre **repuntar** `inspection_item_id` de la reservación y del faltante al item de esta aprobación:
así `voided` sabe qué líneas venían de qué inspección. El contrato no define qué pasa si ya hubo
salidas y la necesidad cambia; la fórmula de arriba (`entregada`) es una interpretación.

Terminar con la sugerencia de reabasto (6.6) para cada pieza afectada.

### 6.4 Cancelaciones

- **`inspection.voided`**: reservas `active` y faltantes `open` cuyo `inspection_item_id` pertenece a esa inspección ⇒ `cancelled` / `closed` (`closed_at = now()`); `stock_balance.reserved` baja. Sin evento. Si la inspección **no** era la vigente de una línea, esa línea no cambia.
- **`work_order.deleted`**: todas las reservas `active` de la orden ⇒ `cancelled`; todos sus faltantes `open` ⇒ `closed`. Una compra posterior con ese `work_order_code` entra como existencia general (la orden ya no está viva).
- Después, recalcular sugerencias (6.6) de las piezas liberadas. Un faltante que se cierra puede dejar sin sustento una sugerencia: borrarla si ya no hay faltantes ni política.

### 6.5 Surtir faltantes con una entrada

Tras `stock.received` (o `resolve`) de la pieza `P`:

1. Faltantes `open` de `P` con `missing_quantity IS NOT NULL` de órdenes con `deleted = FALSE`.
2. Orden de prioridad: primero la orden de `work_order_code` (si viene y sigue viva), luego `opened_at` ascendente.
3. Para cada uno: `fill = min(missing_quantity, disponible_total restante)`. Crear/subir `reservation` (con el `inspection_item_id` del faltante) ⇒ `stock.reserved`; descontar del faltante (si queda en 0, `status = 'closed'`) ⇒ `stock.shortage_resolved` (`quantity = fill`). Ambos eventos salen **en cada faltante surtido**, aunque sea en parte (regla 12 del contrato).
4. Recalcular sugerencia de `P`.

Un faltante con `missing_quantity = NULL` no se puede surtir solo; queda abierto.

### 6.6 Sugerencia de reabasto

Para una pieza con faltantes abiertos (o bajo `reorder_policy.min_quantity`):

```
suma    = Σ missing_quantity de faltantes open de la pieza
sugerida = max(suma, reorder_policy.reorder_quantity ?? 0, min_quantity - disponible_total)   -- debe ser ≥ 1
work_order_ids = órdenes distintas de esos faltantes
```

Upsert en `reorder_suggestion` y emitir `stock.reorder_suggested` **solo si nace o cambia**
(`suggested_quantity` o `work_order_ids`). Si `sugerida < 1` ⇒ borrar la fila (CHECK `>= 1`).

### 6.7 `stock_balance.reserved` y la ubicación

`reservation` no tiene ubicación, pero `stock_balance.reserved` sí es por `(pieza, ubicación)`, y
`v_part_availability` **suma** esa columna. La base exige `reserved <= on_hand` en cada fila cuando
`reserved` sube (`trg_stock_balance_reserved_guard`, migración 015), así que no se puede anotar todo en
`U-100`. `LedgerService` reparte:

- `reserve`: entre las filas con existencia libre, primero `U-100` y luego la de más libre. La suma de lo libre
  por fila nunca es menor que el disponible total, así que siempre cabe lo que se decidió reservar.
- `release`: primero de las filas con más apartado que existencia y luego de las que más tienen.
- `rebalance`: después de una salida, transferencia o conteo, mueve lo apartado de más a filas con existencia
  libre; lo que no quepa (un conteo dejó menos que lo reservado) se queda.

`locations[].reserved` y `available` se reportan con sus valores reales.

## 7. Rutas del contrato (puerto 8000)

Todas JSON UTF-8. `part_id` ≠ entero ⇒ 404. Validación de cuerpo fallida ⇒ **422**.
Nest responde `{statusCode, message}` por defecto: hace falta un filtro global que devuelva `{"detail": "..."}`
y un `ValidationPipe` con `errorHttpStatusCode: 422`.

### `GET /parts/{part_id}/availability` → 200 `Availability` / 404

```sql
SELECT 1 FROM part WHERE part_id = $1;                                   -- 404 si no existe
SELECT on_hand::int, reserved::int, available::int FROM v_part_availability WHERE part_id = $1;
SELECT b.location_id, l.code, b.on_hand, b.available
FROM stock_balance b JOIN location l USING (location_id) WHERE b.part_id = $1;
```

`{ part_id, on_hand, reserved, available, locations: [{ location_id, code, on_hand, reserved, available }] }`.
Totales de la raíz desde la vista; por ubicación, lo apartado y el disponible de cada fila (sección 6.7).

### `GET /parts/{part_id}/ledger` → 200 `Ledger` / 404

```sql
SELECT movement_id, type, part_id, location_id, quantity, occurred_at, reference, balance
FROM v_part_ledger WHERE part_id = $1
ORDER BY occurred_at DESC, movement_id DESC;
```

`{ part_id, entries: [Movement + balance] }`. El `balance` es el saldo de la pieza en todas las
ubicaciones después del movimiento (una transferencia suma 0).

### `GET /work-orders/{code}/materials` → 200 `WorkOrderMaterials` / 404

Una línea por `bom_line_id` con necesidad vigente (último item `buy` de inspecciones `approved`):

```sql
SELECT DISTINCT ON (ii.bom_line_id)
       ii.inspection_item_id, ii.bom_line_id, ii.part_id, ii.name,
       COALESCE(ii.quantity, ml.qty_per_unit) AS required
FROM inspection_item ii
JOIN inspection i      ON i.inspection_id = ii.inspection_id
JOIN model_line ml     ON ml.bom_line_id  = ii.bom_line_id
WHERE i.work_order_id = $1 AND i.status = 'approved' AND ii.action = 'buy'
ORDER BY ii.bom_line_id, i.approved_at DESC, i.inspection_id DESC;
```

Para cada línea: `reserved` = Σ `reservation.quantity` con `status = 'active'` de esa orden y línea;
`issued` = Σ `-movement.quantity` con `type = 'issue'`, `reference = <code>` y `part_id` de la línea;
`missing = max(required - reserved - issued, 0)` (NULL si `required` es NULL). Valores que verifican las
pruebas: `(required, reserved, issued, missing) = (8, 5, 0, 3)` y, tras entregar todo, `(8, 0, 8, 0)`.

### `GET /shortages?work_order_code=&part_id=` → 200 `{items}`

`SELECT * FROM v_open_shortages` (+ filtros). La vista ya trae `work_order_id, work_order_code, part_id, name,
missing_quantity, inspection_item_id, opened_at`.

### `GET /reorder-suggestions` → 200 `{items}`

`SELECT * FROM v_reorder_suggestions` ⇒ `part_id, sku, name, suggested_quantity, work_order_ids`.

### `GET /unmatched-receipts` → 200 `{items}`

`SELECT * FROM v_unmatched_receipts`. `description` es nullable en la base y obligatoria en el contrato:
`COALESCE(description, '')`. `unit_price` sale como texto (`numeric`).

### `POST /unmatched-receipts/{id}/resolve` `{part_id, location_id?}` → 200 `Movement`

- 404 si no existe la recepción, la pieza o la ubicación. **409** si ya estaba `resolved`.
- `location_id` por defecto = 100. Candar la fila (`FOR UPDATE`) para que un segundo intento reciba 409.
- Registra como si hubiera coincidido: `movement` `receipt`, `stock_balance`, `stock.received`, surtir faltantes (6.5).
- Actualiza `unmatched_receipt` (`status = 'resolved'`, `resolved_part_id`, `resolved_location_id`, `resolved_at`) y `purchase_line` (`part_id`, `match_status = 'resolved'`).

### `POST /issues` `{work_order_code, part_id, location_id, quantity ≥ 1, issued_by}` → 201 `Movement`

- 404 si orden, pieza o ubicación no existen (las pruebas reintentan mientras reciban 404).
- `own` = reserva `active` de esa orden para esa pieza; `extra = max(quantity - own, 0)`.
- **409** (sin mover nada) si `quantity > on_hand` en esa ubicación, o `extra > disponible_total`.
- Si pasa: `movement` `issue` (−`quantity`, `reference = work_order.code`), `on_hand -= quantity`, la reserva baja
  `min(quantity, own)` y pasa a `fulfilled` cuando se entrega completa; `stock.issued`.
- `issued_by` entero o texto (`7` o `"tecnico-1"`).

### `POST /transfers` `{part_id, from_location_id, to_location_id, quantity ≥ 1}` → 201 `Movement`

404 si algo no existe; **409** si `quantity > on_hand` en origen; origen = destino ⇒ 422. Dos movimientos
(`transfer_out` −, `transfer_in` +) con la misma `reference`; responder el `transfer_out` y agregar el
campo extra `transfer_in_movement_id`. Emite `stock.transferred`. El total de la pieza no cambia.

### `POST /counts` `{location_id, reason, lines:[{part_id, counted_quantity ≥ 0}]}` → 201 `{adjustments}`

- **422** si `reason` falta o está vacío (o el cuerpo es inválido); 404 si ubicación o pieza no existen.
- Por línea: `delta = counted_quantity - on_hand_actual` (0 si no hay fila). Si `delta ≠ 0`: `movement`
  `adjustment` (`reference = reason`), `stock_balance.on_hand = counted_quantity`, `stock.adjusted`.
- Responde solo las piezas con diferencia: `{ "adjustments": [{ "part_id", "delta" }] }`. Una pieza no listada no se toca.
- Es la única operación que puede dejar `available` negativo.

## 8. Rutas de extensión (las de "API Design")

El contrato permite agregar rutas. Esto traduce los endpoints de `API Design.md` a tablas concretas.
Los nombres exactos son propuesta.

| En "API Design" | Propuesta | Lee / escribe |
|---|---|---|
| `GET events` | `GET /events?origin=&type=&status=&topic=&limit=` | **Lee** `event_inbox` (`origin=inbox`), `outbox_event` (`origin=outbox`) y `dead_letter_event` (`origin=dlq`); cada elemento es el sobre del evento más `origin`, `topic` y `status`. Solo lectura; JWT pospuesto. El consumo de SQS no es una ruta. |
| (flujos del agente) | `POST /agent/messages` `{message, data?}` → 202 | **No escribe** en la base: reenvía el mensaje a la UI por WebSocket (`agent:message`). |
| `POST product/ordenCompra` | `POST /purchase-orders` `{supplier_id, currency, expected_at, lines:[{part_id, part_number, quantity, unit_price, purpose, work_order_code?}]}` | **Escribe** `purchase_request`, `purchase_order`, `purchase_line` (sección 8.1). |
| `PATCH {product id}` | `PATCH /part-instances/{instance_id}` `{condition_code?, location_id?, work_order_id?, serial_number?, note?}` | **Escribe** una unidad física: `part_instance` + `part_status_history` (sección 8.2). |
| `PATCH {product id}` | `PATCH /parts/{part_id}` `{min_quantity?, max_quantity?, reorder_quantity?, lead_time_days?}` | **Escribe** solo `reorder_policy` (es por tipo de pieza). |
| `GET productos` | `GET /parts?q=&sku=&condition=&available=` y `GET /parts/{part_id}` | **Lee** `v_part_agent_summary`, `part`. `condition` filtra tipos que tengan unidades en ese estado. |
| `GET productos` | `GET /part-instances?part_id=&condition=&work_order_code=` y `GET /part-instances/{instance_id}` | **Lee** `v_part_instance_agent`: estado, ubicación, orden, serie, `tools` y `missing_components` de cada unidad. |
| `GET health` | `GET /health` | `SELECT 1`; opcional: pendientes en `event_inbox` (`status <> 'processed'`) y `outbox_event` sin publicar. |

Útiles para la UI y el agente (todas de lectura): `GET /suppliers`, `GET /work-orders` y
`GET /work-orders/{code}` (`work_order` + `work_order_stage`). La receta de reparación ya no es por tipo
(`GET /parts/{part_id}/repair` desaparece): se lee por unidad en `GET /part-instances?part_id=`.

**Por definir:** alta de unidades (`POST /part-instances`: cuándo y cómo nace una unidad: recepción,
inspección o alta manual, y cómo se identifica: serie, etiqueta) y escritura de la receta
(`part_instance_repair_tool`, `part_instance_repair_component`). Hasta decidirlo, la receta solo se lee.

### 8.1 Crear orden de compra

Estructura: `purchase_line.purchase_request_id` es `NOT NULL`, así que toda orden crea primero una `purchase_request`.

| Tabla | Llave | Cómo se asigna |
|---|---|---|
| `purchase_request` | `purchase_request_id INTEGER` (sin secuencia), `request_number TEXT UNIQUE` | Desde la API (ver sección 12). `request_number` con prefijo propio (p. ej. `API-20261009-001`) para no chocar con los del taller. |
| `purchase_order` | `purchase_order_id SERIAL`, `po_number UNIQUE` | Automático / desde la API. `status`: `draft\|open\|partial\|received\|cancelled` (sin CHECK). `currency` por defecto `MXN`. |
| `purchase_line` | `line_id INTEGER` (sin secuencia) | Desde la API. Llevar `purchase_order_id`, `part_id`, `match_status = 'matched'`. |

- No emite eventos `stock.*`: el contrato no define uno para "orden creada".
- Correo al proveedor: dato en `supplier.email`; el envío es de la API, no de la base.
- No hay llave que ligue una orden de la API con el `purchase.item_received` que luego llega (sección 13).

### 8.2 Modificar una unidad física

El estado y la reparación son de cada **unidad física** (`part_instance`), no del tipo de pieza. Dos
motores iguales son dos filas: uno defectuoso al que le falta la banda (llave Allen y prensa) y otro
defectuoso al que le falta un tornillo (llave Allen y torquímetro). Cada unidad tiene su propio estado,
ubicación, orden de trabajo, número de serie y receta de reparación.

`PATCH /part-instances/{instance_id}` → 200 con la unidad (fila de `v_part_instance_agent`) / 404 / 422.
Se actualizan **solo** los campos enviados; un campo enviado como `null` se limpia.

```sql
SELECT part_id, condition_code FROM part_instance WHERE instance_id = $1 FOR UPDATE;   -- 404 si no existe
UPDATE part_instance SET <campos enviados>, updated_at = now() WHERE instance_id = $1;
-- Solo si cambió condition_code:
INSERT INTO part_status_history (part_id, instance_id, condition_code, work_order_id, note)
VALUES ($part_id, $1, $condition_code, $work_order_id, $note);
```

- `condition_code` ∈ `part_condition`: `new`, `functional`, `defective`, `under_repair`, `scrapped`
  (`is_available` solo en `new` y `functional`). Validar contra la tabla, no contra una lista fija.
- `location_id` y `work_order_id` deben existir (404 si no). El cliente manda `work_order_id`; si conviene
  aceptar el código de orden, resolverlo a id en la API.
- Las unidades son una capa aparte: **no** escriben `movement` ni `stock_balance` y no emiten eventos `stock.*`.
- Por ahora `inspection.approved` **no** crea ni actualiza unidades (sección 13).

### 8.3 WebSocket con la UI

La API es el servidor (socket.io sobre los mismos servidores que HTTP: `8000` y, con certificado, `8443`; CORS
según `NODE_ENV`, lo fija `MultiServerIoAdapter`). La UI se conecta con `socket.io-client`
(`io("http://localhost:8000")`, o `https://<ip-de-la-laptop>:8443` desde el celular) y renderiza lo que recibe.

| Mensaje | Dirección | Contenido | Cuándo |
|---|---|---|---|
| `notification` | API → UI | El sobre del evento: `{event_id, event_type, event_version, occurred_at, source, key, data}` | Cada evento `stock.*` que genera la API (al hacer `COMMIT`) y cada evento que consume de SQS, ya procesado. |
| `agent:message` | API → UI | `{message, data, received_at}` | El agente llama `POST /agent/messages`. |
| `parts:list` | UI → API, con respuesta (*ack*) | Pide: los filtros de `GET /parts`. Responde: `{items}` igual que `GET /parts` | Cuando la UI necesita los productos. |

- Solo se emite **después** del `COMMIT`: una transacción que se revierte no genera notificaciones.
- Es entrega "mejor esfuerzo": una UI desconectada no recibe lo que pasó mientras tanto; al reconectar
  debe volver a pedir los datos (`parts:list` o las rutas REST).

## 9. Matriz de tablas

Quién escribe y quién lee. **C** = consumidor de eventos, **H** = rutas HTTP, **A** = agente, **S** = semilla.

| Tabla | Escribe | Lee |
|---|---|---|
| `event_inbox` | C | C (dedup, reintentos), H (`/events`, `/health`) |
| `outbox_event` | C, H | publicador, H |
| `dead_letter_event` | C | H |
| `unit`, `part`, `location`, `model`, `model_line` | C (+ S) | todos |
| `work_order`, `work_order_stage` | C | H (materials, issues), A (tiempos) |
| `inspection`, `inspection_item` | C | H (materials), C |
| `movement` | C, H (`issues`, `transfers`, `counts`, `resolve`) | H (ledger, materials) |
| `stock_balance` | C, H | H (availability), A |
| `reservation`, `shortage` | C, H (`issues` consume reserva) | H (materials, shortages), A |
| `reorder_suggestion` | C | H, A |
| `reorder_policy` | H (PATCH), S | C (sugerencias), A |
| `purchase_request`, `purchase_line` | C, H (órdenes) | C, H, A |
| `purchase_order`, `supplier` | H, S | A |
| `unmatched_receipt` | C, H (`resolve`) | H |
| `part_condition` | S (solo lectura) | H, A |
| `part_instance` | H (`PATCH /part-instances`), S; alta por definir | H, A |
| `part_status_history` | H (al cambiar `condition_code` de una unidad) | A, H |
| `repair_tool` | S | A, H |
| `part_instance_repair_tool`, `part_instance_repair_component` | S (escritura por la API por definir) | A, H |

Vistas: `v_part_availability`, `v_part_agent_summary`, `v_part_instance_agent`, `v_open_shortages`,
`v_unmatched_receipts`, `v_reorder_suggestions`, `v_part_ledger` (solo lectura).

## 10. Agente (lo que la API le debe poder contestar)

El agente corre cada hora simulada (≈ cada 10 min reales) y también responde al usuario. Ambos pasan
por rutas de la API. Consultas de partida:

| Pregunta | Fuente |
|---|---|
| ¿Tengo la pieza X? | `v_part_agent_summary` por `sku`/`name`. `available > 0` ⇒ sí; `on_hand = 0` ⇒ no. Distinguir `on_hand` de `available`. `functional_units`, `defective_units`, `under_repair_units` y `total_units` dicen en qué estado están sus unidades. |
| ¿Qué unidades defectuosas hay y con qué se reparan? | `v_part_instance_agent` con `condition_code IN ('defective','under_repair')`: `tools` y `missing_components` de **cada** unidad. |
| ¿Qué herramientas necesita la unidad N? | `part_instance_repair_tool` + `repair_tool` por `instance_id` (con `quantity` y `notes`); repuestos en `part_instance_repair_component`. |
| ¿Qué le falta a la orden R…? | `v_open_shortages WHERE work_order_code = $1`. |
| ¿Qué debo recomprar? | `v_reorder_suggestions`. |

Reglas de respuesta:
- Hablar de **unidades**, no de tipos: "tienes 2 motores: 1 funcional y 1 defectuoso al que le falta la
  banda". Dos unidades del mismo tipo pueden tener estado y receta distintos.
- Un `sku` repetido es común ⇒ **pedir que elija**, no adivinar.
- Una pieza `SERVICIO` no se inventaría.
- Una unidad `defective`/`under_repair`/`scrapped` no cuenta como disponible.

### 10.1 "Si no hay, que diga por qué"

Evaluar en este orden y devolver todas las razones que apliquen:

1. `part.active = FALSE` ⇒ dada de baja. 2. `part.is_service` ⇒ servicio, no se inventaría.
3. `on_hand = 0` y sin `movement` ⇒ nunca ha entrado.
4. `on_hand > 0` y `available = 0` ⇒ comprometida: `reservation` activas con su `work_order.code`.
5. Unidades en estado no disponible (`part_instance.condition_code` con `is_available = FALSE`) ⇒ cuántas y
   en qué estado (`part_condition.name`), p. ej. "2 motores defectuosos".
6. Faltante abierto o `reorder_suggestion` ⇒ ya se necesita comprar.
7. `unmatched_receipt` pendiente con `part_number` parecido ⇒ llegó y está sin relacionar.
8. `purchase_line` `customer_order` de ese `part_number` ⇒ llegó, pero era para un cliente.

### 10.2 Reparación y costo (reto)

Se evalúa **por unidad**: cada una tiene su propia receta en `part_instance_repair_component`.

- Unidad defectuosa **y** todos sus componentes con `available ≥ quantity` (disponible del componente en
  `v_part_availability`) ⇒ esa unidad se puede reparar.
- Falta alguno ⇒ pedir lo necesario; **solo se costea lo que se va a pedir**:
  `Σ max(quantity - available, 0) × último unit_price` de cada componente de esa unidad (último
  `purchase_line` con ese `part_id`).
- Con dos motores, uno puede repararse ya (hay banda) y el otro no (falta el tornillo). Si varias unidades
  piden el mismo componente, el disponible se comparte: no contarlo dos veces.
- Si no hay `purchase_line` previa, no hay precio: decirlo, no inventarlo.

### 10.3 Cuánto tarda una reparación

La base **no guarda** duración de reparación. Se estima con el historial de `work_order_stage`:

```sql
SELECT w.model_id, w.department,
       avg(done.occurred_at - start.occurred_at) AS avg_duration
FROM work_order w
JOIN work_order_stage start ON start.work_order_id = w.work_order_id AND start.to_stage = 'quick_inspection'
JOIN work_order_stage done  ON done.work_order_id  = w.work_order_id AND done.to_stage  = 'final_release'
WHERE NOT w.deleted
GROUP BY w.model_id, w.department;
```

Es una estimación sobre las órdenes terminadas de ese modelo/departamento, no un dato almacenado.

### 10.4 Mejor momento para comprar y proveedores

Datos disponibles: `reorder_policy` (mínimo, máximo, lead time), `reorder_suggestion`, historial de
`purchase_line.unit_price` por pieza, `purchase_order.expected_at`, `supplier`. Los renglones que vienen
de `purchase.item_received` **no** traen proveedor (`purchase_order_id` y `supplier_id` quedan NULL), así
que proveedor, fecha de entrega y costo solo existen para lo creado por la API o sembrado (sección 12).

## 11. TypeORM y serialización

- `synchronize: false` y sin `migrationsRun`. El esquema es de Liquibase.
- Columnas generadas `part.sku_norm` y `stock_balance.available`: `@Column({ insert: false, update: false })`. Insertarlas falla.
- Las vistas se mapean con `@ViewEntity` o consultas crudas; todas son de solo lectura. La API usa SQL a través de `DataSource`/`EntityManager` de TypeORM (las consultas de esta guía, los candados y la aritmética de saldos no encajan en entidades).
- **En Postgres, `manager.query()` de un `UPDATE`/`DELETE` devuelve `[filas, afectadas]`**, no solo las filas, aunque lleve `RETURNING`. Usar el helper `updateReturning` (`src/common/db.ts`).
- **`SUM` y `COUNT` devuelven `bigint`, que `pg` entrega como string.** `v_part_availability.on_hand/reserved/available` y, en `v_part_agent_summary`, `on_hand/reserved/available`, `defective_units`, `under_repair_units`, `functional_units`, `total_units` y `open_shortages` llegan como texto: convertir (`::int` en SQL o `parseInt`) antes de responder, porque el contrato pide enteros.
- `BIGSERIAL` (`movement_id`, `reservation_id`, `shortage_id`, `unmatched_receipt.id`, `dead_letter_event.id`, `part_instance.instance_id`, `part_status_history.id`) también llega como string; el contrato admite `integer|string` en `movement_id`, `reservation_id` y el `id` de `unmatched-receipts`. `instance_id` es de extensión: elegir un formato y mantenerlo.
- `v_part_instance_agent.tools` y `missing_components` son `TEXT[]`: `pg` los entrega como `string[]` (vacío = `[]`).
- `NUMERIC(14,2)` llega como string: mantenerlo así (`"1850.00"`).
- `TIMESTAMPTZ` llega como `Date`: serializar con `toISOString()` (termina en `Z`).
- `work_order_ids` es `INTEGER[]`: `pg` lo entrega como `number[]`.

## 12. Brechas del esquema (sin cambiar la base)

Lo que el esquema **no** tiene y cómo vivir con ello. Ninguna requiere tocar la base para empezar; las
marcadas **Cambio posible** son propuestas que solo se harían si el equipo lo aprueba.

| Brecha | Consecuencia | Cómo seguir |
|---|---|---|
| `purchase_request_id` y `purchase_line.line_id` son `INTEGER` sin secuencia | Una orden creada por la API necesita ids que no choquen con los del taller. | Asignar en la API, en un rango propio bajo candado `pg_advisory_xact_lock`. Las pruebas de contrato generan ids de hasta ~999,999,999 y `INTEGER` llega a 2,147,483,647: usar p. ej. ≥ 1,500,000,000. **Cambio posible:** secuencias dedicadas. |
| No hay tabla de usuarios ni de sesión | El reto pide autenticación; el contrato dice sin autenticación. Quién autoriza/compra no se persiste. | **Pospuesto.** Cuando se retome: guard solo en rutas de extensión, **nunca** en las del contrato (las pruebas no mandan credenciales). |
| No hay relación proveedor ↔ pieza ni cotizaciones/especificaciones | "Proveedores, fechas y costos" y "el proveedor incluye especificaciones" no tienen fuente. | Derivar de `purchase_order` ↔ `purchase_line` (solo lo creado por la API). **Cambio posible:** tabla `supplier_part` / `quotation`. |
| `purchase_line.match_status` no tiene valor para `customer_order` | Queda en `pending`, igual que una recepción aún sin procesar. | Distinguir por `purpose`. |
| ~~`movement` no tiene `work_order_id`~~ (resuelto en la migración 012) | `materials` toma lo entregado de las reservas `fulfilled` de cada línea y de `movement.work_order_id`; una salida sin reserva se le cuenta a la primera línea de la pieza. | Las salidas viejas se reconocen por `reference`. Antes: si dos líneas comparten pieza, `issued` es por pieza. |
| `reservation` no tiene `bom_line_id` ni ubicación | La línea se obtiene por `inspection_item.bom_line_id`; la ubicación de la reserva no existe. | Secciones 6.3 y 6.7. |
| No hay UNIQUE que impida dos reservas o faltantes abiertos por línea | El invariante "uno por (orden, línea)" lo debe cuidar la app. | Candado de orden + `FOR UPDATE` al reemplazar necesidad. |
| `event_inbox.status` tiene `DEFAULT 'processed'` | Un insert sin status queda como procesado. | Escribir el status explícito siempre. |
| `movement.event_id` no es FK | Un movimiento de comando HTTP apunta al `event_id` del `outbox_event` que lo originó. | Usar ese UUID; para eventos de entrada, el de `event_inbox`. |
| No hay duración de reparación | Sección 10.3. | Estimar desde `work_order_stage`. |
| SQS no guarda offsets ni permite releer lo consumido | Reanudar depende de borrar cada mensaje solo después de guardarlo; reconstruir requiere reenviar los eventos. | `event_inbox` guarda el historial completo (en RDS) y cubre la idempotencia. |
| No hay regla de alta de unidades | Nada crea `part_instance` salvo la semilla. | Leer y modificar las existentes; el alta queda por definir (sección 8). |
| La receta de reparación no tiene escritura definida | `part_instance_repair_tool` / `_component` solo los llena la semilla. | Solo lectura hasta decidirlo. |
| La semilla inserta `instance_id` explícitos (900001–900005) sin mover la secuencia | Un alta sin id empezaría en 1; chocaría al llegar a 900001. | Si se agrega el alta, ajustar la secuencia (`setval`) o asignar ids en un rango propio. |

## 13. Decisiones abiertas y observaciones

Cosas que la documentación de la base o del reto dejan sin cerrar, o que no son de estructura de datos y
por eso no se corrigieron en `API Design.md`:

1. **Unidades e inspecciones** (decidido por ahora: sin sincronizar). `spec/08` plantea crear o actualizar
   `part_instance` desde `inspection.approved` (dañada + `repair` ⇒ `defective`/`under_repair`). Por ahora el
   consumidor **no** toca unidades: se modifican con `PATCH /part-instances/{instance_id}`. Si se decide
   sincronizar, cambia la sección 6.3.
2. **`SERVICIO` y kits.** ¿Se inventarían? Hoy solo existe `part.is_service`. Una recepción de pieza `SERVICIO`
   entraría como existencia si no se decide lo contrario.
3. **Relación de `part_number` ↔ `sku`.** El mínimo exigido es `lower(btrim())`. Reglas más listas (quitar
   puntos, espacios internos, cero a la izquierda) se permiten pero **deben seguir mandando a revisión si
   queda ambigüedad**, y explicarse en el documento de decisiones. ¿Se excluyen piezas `active = FALSE`?
4. **Faltantes con cantidad desconocida** en la sugerencia de reabasto (`missing_quantity = NULL`): ¿suman 0 o 1?
5. **Orden de compra de la API vs. recepción del taller.** No hay llave común. Sin ella, el estado de
   `purchase_order` solo cambia a mano (`PATCH`).
6. **`GET events`** (decidido): consumir eventos es el consumidor SQS en segundo plano (sección 1), no una
   ruta HTTP. `GET /events` solo **lista** lo ya guardado. La autenticación (JWT) quedó pospuesta.
7. **Nombre del reto:** el título de `API Design.md` dice "Roceel" y el reto dice "Rossel". No se tocó.
8. **"Autorizar un nuevo equipo que requiera refacción"** (módulo esperado del reto): en el kit, aprobar una
   inspección lo hace el simulador (`POST /api/inspections/{id}/approve` en `:8090`) y llega como evento;
   la API no genera `inspection.approved`.
9. **Orden eliminada en `materials`** (decidido): 200 con sus líneas, `reserved = 0`, `missing = 0` y el
   campo extra `deleted: true`.
10. **Eventos de `notifications`:** se aceptan con cualquier `event_type` (solo se valida el sobre), se guardan en
    `event_inbox`, se mandan a la UI por WebSocket y se reenvían al agente (punto 12). Falta definir sus tipos y
    su `data` entre UI y agente.
11. **Alta de unidades y receta de reparación:** sin definir (sección 8).
12. **Cómo le llega al agente el mensaje del usuario** (decidido): la API le reenvía cada evento de
    `notifications` con `POST AGENT_URL` (el sobre en JSON), como mejor esfuerzo; el agente responde con
    `POST /agent/messages`.

## 14. Pruebas y reconstrucción

Con el kit arriba y la API en `:8000`. El simulador y las pruebas de contrato del kit traen productor y
consumidor de Kafka; con SQS necesitan la misma adaptación que el simulador (inyectar en las colas de
entrada y leer `inventory-broker-inventory-events.fifo`).

```bash
docker compose run --rm contract-tests --api http://host.docker.internal:8000
docker compose run --rm contract-tests --api http://host.docker.internal:8000 --only concurrencia,desorden
```

Valen 50 de 100 puntos. Correr **un solo** servicio de inventario: las pruebas leen toda la cola `inventory-broker-inventory-events.fifo`.

| Escenario | Qué estresa |
|---|---|
| `recepcion_basica` | Matching con mayúsculas/espacios, entrada en `location_id = 100`, `currency` desde la compra. |
| `idempotencia` | Mismo `event_id` dos veces ⇒ 1 `stock.received`. |
| `salida_sin_negativos` | 409 sin mover saldo; 201 con lo que sí hay. |
| `transferencia_y_conteo`, `kardex` | 409 en transferencia, 422 sin motivo, orden y `balance` del kardex. |
| `reserva_faltante_compra_y_salida` | Ciclo completo y `materials` = `(8,5,0,3)` → `(8,0,8,0)`. |
| `lineas_que_no_reservan` | `repair`, `ok`, `part_id` null, `quantity` null. |
| `compra_para_cliente`, `recepcion_sin_relacionar` | `customer_order` ignorado; sku nulo/ambiguo ⇒ revisión manual; segundo `resolve` ⇒ 409. |
| `necesidad_se_reemplaza`, `rechazo_y_anulacion`, `baja_de_orden` | Reemplazo (2→3, no 5), `voided`, `deleted`. |
| `desorden` | Inspección antes de orden, modelo y pieza ⇒ reintento. |
| `concurrencia` | 4 aprobaciones simultáneas por 1 pieza ⇒ solo 1 reservada. |

**Reconstrucción** (la corre el jurado):

```bash
docker compose run --rm -v "$PWD:/out" contract-tests snapshot --out /out/saldo.json --api http://host.docker.internal:8000
# borrar la base local y volver a mandar los eventos
docker compose run --rm -v "$PWD:/out" contract-tests compare  --out /out/saldo.json --api http://host.docker.internal:8000
```

Solo afecta la base **local**: la real vive en el RDS compartido. Para "borrar la base": en `hack-saltillo-db`,
`docker compose down -v && docker compose up -d` (Liquibase reaplica esquema y semilla). Como SQS no permite
releer lo consumido, los eventos se vuelven a mandar reiniciando el simulador (reenvía el archivo completo).
Se compara `on_hand` por pieza y ubicación; **las reservas no se comparan**.

Desarrollo sin broker: `hackathon-inventario-kit/data/events.jsonl` (`{topic, replay_at, event}` por línea)
es el mismo flujo que reproduce el simulador; pasarlo por el mismo pipeline sirve para probar handlers.
`tools/validate_events.py` valida un JSONL contra los schemas (úsalo con tus salidas).

## 15. Orden de construcción sugerido

1. **Base del proyecto:** dependencias, `ConfigModule`, TypeORM contra Postgres, `PORT=8000`, `GET /health`, filtro `{detail}`.
2. **Pipeline:** validación del sobre con los schemas, `event_inbox`, dedup, transacción por evento, candados.
3. **Catálogo:** `part`, `location`, `bom` (+ arranque catálogo-primero).
4. **Taller:** `work_order.*` e `inspection.*` hasta `submitted`/`rejected`/`discarded`.
5. **Libro mayor:** `movement` + `stock_balance`; `GET availability` y `GET ledger`.
6. **Compras:** `purchase.item_received`, matching, `unmatched_receipt`, `resolve`; entrada en `U-100`.
7. **Compromisos:** `inspection.approved` (reserva/faltante/reemplazo), `voided`, `deleted`, surtir faltantes, reabasto.
8. **Salida:** `outbox_event` + publicador + DLQ; validar con `validate_events.py`.
9. **Comandos HTTP:** `/issues`, `/transfers`, `/counts`; `GET materials`, `/shortages`, `/reorder-suggestions`, `/unmatched-receipts`.
10. **Reintentos y concurrencia:** worker de `failed`, pruebas `desorden` y `concurrencia`.
11. **Extensión y agente:** secciones 8 y 10, incluidas las unidades físicas (`GET`/`PATCH /part-instances`).
12. **Contrato completo y reconstrucción:** correr todas las pruebas y el ciclo `snapshot` / `compare`.
