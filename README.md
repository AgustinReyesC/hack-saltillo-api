# Hack Saltillo API

API de inventario del reto de almacén inteligente para taller. Consume los eventos del taller desde
AWS SQS, los guarda y proyecta en PostgreSQL (libro mayor de existencias, reservas, faltantes y
reabasto), publica sus propios eventos de inventario, expone una API REST para el agente y es el servidor
de WebSocket con el que la UI se entera de los cambios en tiempo real.

- **Framework:** NestJS 12 (TypeScript, ESM) y TypeORM.
- **Broker:** AWS SQS (colas FIFO).
- **Base de datos:** PostgreSQL. El esquema lo crea Liquibase en `hack-saltillo-db`; la API no crea ni altera tablas.
- **Diseño:** [docs/API Design.md](docs/API%20Design.md).

## Contenido

1. [Correr la API en local](#correr-la-api-en-local)
2. [Scripts](#scripts)
3. [Variables de entorno](#variables-de-entorno)
4. [Flujo de información](#flujo-de-información)
5. [Colas SQS](#colas-sqs)
6. [Procesamiento de eventos](#procesamiento-de-eventos)
7. [Eventos de salida](#eventos-de-salida)
8. [Rutas HTTP](#rutas-http)
9. [WebSocket](#websocket)
10. [Convenciones de la API](#convenciones-de-la-api)
11. [Pruebas](#pruebas)
12. [Despliegue](#despliegue)

## Correr la API en local

### Requisitos

- Node.js 24.15 o superior y npm. Probado con 25.9: el CLI de Nest muestra un aviso `EBADENGINE` en esa
  versión, pero funciona.
- Docker, para la base de datos local.
- Acceso a AWS con permisos sobre las colas SQS (ver [Colas SQS](#colas-sqs)), o el emulador ElasticMQ que
  levanta `hack-saltillo-broker` (`docker compose up -d elasticmq`, `SQS_ENDPOINT_URL=http://localhost:9324`).

### Pasos

1. **Levantar la base de datos** (repositorio `hack-saltillo-db`). Liquibase aplica el esquema y los datos de ejemplo:

   ```bash
   cd ../hack-saltillo-db
   cp .env.example .env
   docker compose up -d
   ```

   PostgreSQL queda en `localhost:5432` con base, usuario y contraseña `inventario`.

2. **Configurar el entorno de la API.** Copia la plantilla y completa los valores con la tabla de
   [Variables de entorno](#variables-de-entorno):

   ```bash
   cp .env.example .env.local
   ```

3. **Instalar dependencias y arrancar:**

   ```bash
   npm install
   npm run start:dev
   ```

4. **Comprobar que responde** en el puerto 8000:

   ```bash
   curl http://localhost:8000/health
   ```

5. **Generar eventos.** El simulador del taller publica los eventos en las colas de entrada y la API los
   consume en cuanto llegan.

### HTTPS para el celular

La pantalla de piso escanea con la cámara del celular, y el navegador solo abre la cámara en una página
segura (HTTPS). Una página HTTPS tampoco puede llamar a `http://` ni a `ws://`, así que la API también se
sirve por HTTPS. En local hay dos puertos con las mismas rutas y el mismo WebSocket:

| Puerto | Protocolo | Quién lo usa |
|---|---|---|
| `8000` (`PORT`) | HTTP / `ws://` | Pruebas de contrato, agente, UI en la laptop. |
| `8443` (`HTTPS_PORT`) | HTTPS / `wss://` | UI abierta en el celular. |

1. **Instalar [mkcert](https://github.com/FiloSottile/mkcert)** (`winget install FiloSottile.mkcert`,
   `choco install mkcert` o `brew install mkcert`) y su autoridad local, una sola vez:

   ```bash
   mkcert -install
   ```

2. **Generar el certificado** con la IP de la laptop en la red local (`ipconfig` en Windows,
   `ipconfig getifaddr en0` en Mac). Queda en `certs/`, que no se versiona:

   ```bash
   npm run cert:local -- 192.168.1.50
   ```

   Si la IP cambia, se vuelve a generar. `.env.local` ya apunta a `certs/local-key.pem` y
   `certs/local-cert.pem`; con esas dos variables vacías la API arranca solo con HTTP.

3. **Confiar en el certificado desde el celular.** Opción rápida: abrir `https://192.168.1.50:8443/health` en
   el navegador del celular y aceptar la advertencia una vez. Opción permanente: instalar en el celular la
   autoridad de mkcert (`rootCA.pem` de la carpeta que imprime `mkcert -CAROOT`).

4. **Abrir el puerto en el firewall** de la laptop si el celular no llega (Windows lo pide la primera vez).

La UI también se sirve por HTTPS en el celular y apunta a `https://<ip-de-la-laptop>:8443`. En local el
CORS ya acepta `localhost` y las IP de la red local en cualquier puerto, así que no hay que tocarlo.

## Scripts

Cada script de arranque carga su propio archivo de entorno con `node --env-file`.

| Script | Archivo de entorno | `NODE_ENV` | Descripción |
|---|---|---|---|
| `npm run start` | `.env.local` | `local` | Compila y arranca. |
| `npm run start:dev` | `.env.local` | `local` | Modo observación: recompila al guardar. |
| `npm run start:debug` | `.env.local` | `local` | Observación con el depurador de Node. |
| `npm run start:prod` | `.env` | `dev` | Arranca el build de `dist/` (requiere `npm run build`). |
| `npm run build` | | | Compila a `dist/`. |
| `npm run cert:local -- <ip>` | | | Certificado HTTPS local con mkcert (ver [HTTPS para el celular](#https-para-el-celular)). |
| `npm run test` | | | Pruebas unitarias (Vitest). |
| `npm run test:e2e` | | | Pruebas end-to-end. |
| `npm run test:cov` | | | Pruebas con cobertura. |
| `npm run lint` | | | Oxlint sobre `src/` y `test/`. |
| `npm run format` | | | Prettier. |

`.env.local` y `.env` no se versionan. `.env.example` documenta todas las variables con placeholders.

## Variables de entorno

| Variable | Valor local | Descripción |
|---|---|---|
| `NODE_ENV` | `local` / `dev` | `local` en `.env.local`, `dev` en `.env`. |
| `PORT` | `8000` | Puerto HTTP. Las pruebas de contrato esperan el 8000. |
| `CORS_ORIGINS` | (vacío) | Orígenes de la UI con CORS (HTTP y WebSocket), separados por coma, sin ruta ni `/` final. En `local` se suman a `localhost` y las IP de la red local, que ya se permiten. En `dev` es obligatorio: el dominio de CloudFront. |
| `HTTPS_PORT` | `8443` | Puerto HTTPS, para el celular. |
| `HTTPS_KEY_PATH` | `certs/local-key.pem` | Llave del certificado. Vacía junto con `HTTPS_CERT_PATH` = solo HTTP. |
| `HTTPS_CERT_PATH` | `certs/local-cert.pem` | Certificado. En `dev` se dejan vacías si el TLS lo termina el balanceador. |
| `DATABASE_HOST` | `localhost` | En ECS, el endpoint del RDS compartido. |
| `DATABASE_PORT` | `5432` | |
| `DATABASE_NAME` | `inventario` | |
| `DATABASE_USER` | `inventario` | |
| `DATABASE_PASSWORD` | `inventario` | |
| `DATABASE_SSL` | `false` | `true` contra RDS. |
| `AWS_REGION` | | Región de las colas. |
| `AWS_ACCESS_KEY_ID` | | Solo para correr fuera de AWS. En ECS se deja vacía: se usa el rol de la tarea. |
| `AWS_SECRET_ACCESS_KEY` | | Ídem. |
| `SQS_SHOP_CATALOG_URL` | | URL de `inventory-broker-shop-catalog.fifo`. |
| `SQS_SHOP_WORK_ORDERS_URL` | | URL de `inventory-broker-shop-work-orders.fifo`. |
| `SQS_SHOP_INSPECTIONS_URL` | | URL de `inventory-broker-shop-inspections.fifo`. |
| `SQS_SHOP_PURCHASING_URL` | | URL de `inventory-broker-shop-purchasing.fifo`. |
| `SQS_NOTIFICATIONS_URL` | | URL de `inventory-broker-notifications.fifo`. |
| `SQS_INVENTORY_EVENTS_URL` | | URL de `inventory-broker-inventory-events.fifo`. |
| `SQS_INVENTORY_DLQ_URL` | | URL de `inventory-broker-inventory-dlq.fifo`. |
| `SQS_ENDPOINT_URL` | | Solo con un emulador local (ElasticMQ: `http://localhost:9324`). En AWS, vacía. |
| `AGENT_URL` | | URL a la que la API reenvía (`POST`, con el sobre) cada evento de `notifications`. Vacía = no reenvía. |
| `INGEST_MAX_WAIT_MINUTES` | `60` | Opcional. Minutos que un evento puede esperar una dependencia antes de ir a la DLQ. |
| `INGEST_MAX_ATTEMPTS` | `5` | Opcional. Intentos de un evento que falla por un error (no por una dependencia) antes de la DLQ. |
| `INGEST_RETRY_INTERVAL_MS` | `5000` | Opcional. Cada cuánto se reintentan los eventos pendientes. |
| `OUTBOX_PUBLISH_INTERVAL_MS` | `250` | Opcional. Cada cuánto se publica `outbox_event` en las colas de salida. |

Sin colas configuradas la API arranca igual (rutas HTTP y WebSocket) y avisa que no consume ni publica.

`NODE_ENV` decide el CORS y el modo de arranque:

| | `local` (`.env.local`) | `dev` (`.env`) |
|---|---|---|
| CORS | `localhost` e IP de la red local, más `CORS_ORIGINS` | Solo `CORS_ORIGINS` (CloudFront) |
| HTTPS | Puerto 8443 con el certificado de mkcert | Normalmente en el balanceador; en la tarea solo si hay certificado |
| Base de datos | `hack-saltillo-db` en `localhost` | RDS (`DATABASE_SSL=true`) |

La API valida esto al arrancar y se detiene con un mensaje claro si `NODE_ENV` no es `local` ni `dev`, si
un origen está mal escrito (o sigue siendo un placeholder) o si no encuentra el certificado.

## Flujo de información

La API recibe los cambios a través de eventos que consume de SQS. El agente habla con la API por REST
(HTTP) y la API habla con la UI por WebSocket. Hay tres flujos.

### Evento

El simulador deja el evento en SQS. La API lo lee evento por evento y, según su `event_type`, decide qué
hacer y qué endpoint usar.

```mermaid
flowchart LR
    B["Broker SQS<br/>evento en la cola"] -->|"la API lee<br/>evento por evento"| A["API"]
    A -->|"según el evento,<br/>decide qué hacer"| D[("Base de datos")]
    A -->|"notification<br/>(WebSocket)"| U["UI"]
    A --> G["Agente"]
```

### Pregunta del agente

El mensaje del usuario en la UI genera un evento en la cola de notificaciones. La API lo consume y,
según su tipo, decide qué hacer.

```mermaid
sequenceDiagram
    actor U as UI
    participant B as Broker SQS<br/>notifications
    participant A as API
    participant G as Agente
    U->>B: Mensaje del usuario (evento)
    B->>A: La API consume el evento
    A->>G: El agente lee el mensaje
    G->>A: Query del agente
    A-->>G: Registros
    G->>G: Procesa los datos
    G->>A: Respuesta (POST /agent/messages)
    A->>U: agent:message (WebSocket)
```

### Lectura automática de la base de datos

El agente consulta por su cuenta, cada hora simulada (cada 10 minutos reales).

```mermaid
sequenceDiagram
    participant G as Agente
    participant A as API
    participant D as Base de datos
    actor U as UI
    G->>A: Leer la base de datos
    A->>D: Obtener los registros
    D-->>A: Registros
    A-->>G: El agente recibe los datos
    G->>A: Mensaje generado (POST /agent/messages)
    A->>U: agent:message (WebSocket)
```

## Colas SQS

Una cola FIFO por cada tópico del simulador, más la de notificaciones. Son FIFO porque el contrato pide
orden por llave: el `key` del evento viaja como `MessageGroupId` y el `event_id` como
`MessageDeduplicationId`. La deduplicación basada en contenido está desactivada, así que cada envío lleva
su `MessageDeduplicationId`.

| Cola | Dirección | Eventos | `key` |
|---|---|---|---|
| `inventory-broker-shop-catalog.fifo` | entrada | `part.upserted`, `location.upserted`, `bom.upserted` | `part:305`, `location:14`, `model:4` |
| `inventory-broker-shop-work-orders.fifo` | entrada | `work_order.opened`, `.stage_changed`, `.deleted` | código de orden (`R061026012`) |
| `inventory-broker-shop-inspections.fifo` | entrada | `inspection.submitted`, `.approved`, `.rejected`, `.discarded`, `.voided` | código de orden |
| `inventory-broker-shop-purchasing.fifo` | entrada | `purchase.item_received` | `PR-` + `request_number` |
| `inventory-broker-notifications.fifo` | entrada | Eventos que genera el mensaje del usuario al agente; la API decide según su `event_type` | |
| `inventory-broker-inventory-events.fifo` | salida | `stock.*` | ver [Eventos de salida](#eventos-de-salida) |
| `inventory-broker-inventory-dlq.fifo` | salida | Evento original que no se pudo procesar | la del original |

La API consume solo las colas de entrada. Las de salida son para otros consumidores: en SQS cada mensaje
lo recibe un solo consumidor.

Garantías con las que está diseñada la API:

- **Al menos una vez:** pueden llegar duplicados. `event_inbox.event_id` es llave primaria y reprocesar un
  evento no cambia nada ni emite salidas.
- **Orden solo por llave** dentro de una cola. No hay orden entre colas.
- **Sin offsets:** SQS no guarda la posición del consumidor. Un mensaje solo se borra de la cola después de
  guardarse en la base, así que si la API se desconecta retoma con lo que quedó pendiente. El historial
  completo de lo consumido vive en `event_inbox`.

## Procesamiento de eventos

Todos los eventos usan el mismo sobre:

```json
{ "event_id": "uuid", "event_type": "inspection.approved", "event_version": 1,
  "occurred_at": "2026-10-06T16:42:11Z", "source": "shop-floor", "key": "R061026012", "data": {} }
```

El consumidor (`src/ingest/sqs-consumer.ts`) hace *long polling* a cada cola de entrada y le pasa cada mensaje
al pipeline (`src/ingest/ingest.service.ts`), que elige la función del `event_type`
(`src/ingest/event-dispatcher.ts`). Por cada mensaje:

1. Se valida el sobre contra el JSON Schema del contrato (`contract/schemas`, copia del kit). Si es inválido o
   el `event_type` es desconocido, va a `dead_letter_event` y a `inventory-broker-inventory-dlq.fifo`.
2. **Dedup:** se inserta en `event_inbox` y se toma su fila con `FOR UPDATE`; si ya estaba `processed`, no
   pasa nada ni se emite nada (regla 19).
3. **Orden por llave:** si un evento anterior con la misma llave en el mismo tópico sigue pendiente, este
   espera su turno.
4. En la misma transacción se ejecuta la función del `event_type`: escribe las tablas de dominio y encola
   las salidas en `outbox_event`. El evento queda `processed` y se hace `COMMIT`.
5. Se avisa a la UI (`notification` por WebSocket) con el evento consumido y los que generó, y se borra el
   mensaje de SQS.

Si falta una dependencia (una inspección que llega antes de su orden, una lista de partes antes que su
pieza), el evento no se descarta: queda `failed` en `event_inbox`, no detiene el consumo y se reintenta
(regla 20). `event_inbox` es la cola de reintentos: se recorre por orden de llegada cada vez que se aplica
un evento y cada `INGEST_RETRY_INTERVAL_MS`, hasta que una pasada no destrabe nada. Lo que espera más de
`INGEST_MAX_WAIT_MINUTES`, o falla `INGEST_MAX_ATTEMPTS` veces por un error, va a `dead_letter_event` y a
la DLQ con su misma llave (regla 21). Si la base no responde, el mensaje no se borra y SQS lo vuelve a
entregar.

**Catálogo primero (regla 22).** Al arrancar, la API lee `inventory-broker-shop-catalog.fifo` hasta vaciarla
antes de las demás colas. En vivo, una compra no espera dependencias como una inspección: se relaciona con
el catálogo que haya en ese momento, y si se aplica antes que el `part.upserted` que se publicó justo antes,
el resultado ya no se corrige. Por eso, si el catálogo recibió algo en los últimos segundos, cada lote de
compras espera a que termine una lectura del catálogo que empezó después de que llegó.

**Ubicaciones con el mismo código.** `location.code` es único en la base, pero el código lo trae el evento
más reciente: si otra ubicación lo tenía, se le aparta (`U-020~20`) hasta que llegue su propio upsert. Pasa
con los estantes que crean las pruebas de contrato (`U-0xx`) sobre el catálogo ya cargado.

### Qué escribe cada evento

| Evento | Escribe |
|---|---|
| `part.upserted` | `unit` y `part`. |
| `location.upserted` | `location`. |
| `bom.upserted` | `model` y `model_line`. Las líneas que ya no vienen pasan a `active = FALSE`. |
| `work_order.opened` | `work_order`. No pisa `stage` ni `deleted` si ya existía. |
| `work_order.stage_changed` | `work_order.stage` y `work_order_stage`. |
| `work_order.deleted` | `work_order.deleted`; libera reservas y cierra faltantes. |
| `inspection.submitted` | `inspection` e `inspection_item`. No mueve inventario. |
| `inspection.approved` | Lo anterior, más la necesidad: reservas, faltantes y sugerencias. Es la única que genera necesidad. |
| `inspection.rejected` / `.discarded` | `inspection.status`. |
| `inspection.voided` | `inspection.status`; libera reservas y cierra faltantes de esa inspección. |
| `purchase.item_received` | `purchase_request` y `purchase_line`; si es `restock`, entrada de inventario. |

### Reglas de negocio

- **Existencias:** `movement` es la fuente de verdad (inmutable) y `stock_balance.on_hand` lo recalcula el
  trigger `trg_movement_apply_balance` de la base: la API solo inserta movimientos y administra `reserved`.
  `available = on_hand - reserved` no baja de 0 por reservas ni salidas; solo `POST /counts` puede dejarlo negativo.
- **Necesidad:** solo los items de inspección con `action = 'buy'` generan necesidad, por `(orden, bom_line_id)`,
  en `work_order_need`. Una nueva aprobación **reemplaza** la cantidad, no la suma; lo ya entregado cuenta.
- **Reserva y faltante:** se reserva `min(disponible, necesidad)` y el resto queda como faltante (uno abierto por
  línea). La reserva es de la pieza, pero la base exige `reserved <= on_hand` por fila: se reparte entre las
  ubicaciones con existencia libre (primero `U-100`) y sigue a la existencia cuando sale o se transfiere.
- **Candados:** antes de tocar reservas o faltantes se toma `pg_advisory_xact_lock` por pieza (en orden
  ascendente) y luego el de la orden: dos aprobaciones simultáneas no se llevan la misma última pieza.
- **Cancelaciones:** `inspection.voided` libera lo que venía de esa inspección y borra la necesidad de esas
  líneas; `work_order.deleted` libera todo lo de la orden. Una orden dada de baja ya no aparta material y
  `POST /issues` contra ella responde 409.
- **Compras:** `restock` se relaciona con `part.sku_norm` (sin mayúsculas ni espacios) y entra a la ubicación
  `U-100` (`location_id = 100`); además surte faltantes abiertos. `customer_order` se ignora. Sin pieza única,
  queda en `unmatched_receipt` para resolverse a mano.
- **Reabasto:** `stock.reorder_suggested` solo se emite cuando la sugerencia nace o cambia.

### Unidades físicas

El estado y la reparación son de cada **unidad física**, no del tipo de pieza. Dos motores iguales son dos
registros independientes en `part_instance`, cada uno con su propio estado, ubicación, orden de trabajo,
número de serie y receta de reparación:

- Motor 1: defectuoso, le falta la banda; necesita llave Allen y prensa.
- Motor 2: defectuoso, le falta un tornillo; necesita llave Allen y torquímetro.

Las herramientas de cada unidad viven en `part_instance_repair_tool`, los repuestos que le faltan en
`part_instance_repair_component` y sus cambios de estado en `part_status_history`. Las unidades son una
capa aparte del inventario: no modifican `movement` ni `stock_balance`, la existencia sigue siendo por cantidad.

## Eventos de salida

Mismo sobre, con `source = "inventory"`, `event_version = 1` y un `event_id` nuevo. Se encolan en
`outbox_event` dentro de la misma transacción que el cambio y un publicador (`src/ingest/outbox-publisher.ts`)
los envía a `inventory-broker-inventory-events.fifo` con la llave como `MessageGroupId` y el `event_id` como
`MessageDeduplicationId` (entrega al menos una vez).

| Evento | `key` | Cuándo |
|---|---|---|
| `stock.received` | `part:<part_id>` | Entrada en `U-100`, o al resolver una recepción. |
| `stock.unmatched_receipt` | `purchase_line:<line_id>` | Compra `restock` sin pieza única. |
| `stock.reserved` | código de orden | Por cada reserva, también al surtir un faltante. |
| `stock.shortage_detected` | código de orden | Nace o cambia un faltante. |
| `stock.shortage_resolved` | código de orden | Una entrada surte un faltante. |
| `stock.issued` | código de orden | `POST /issues`. |
| `stock.transferred` | `part:<part_id>` | `POST /transfers`. |
| `stock.adjusted` | `part:<part_id>` | Una por línea con diferencia en `POST /counts`. |
| `stock.reorder_suggested` | `part:<part_id>` | Nace o cambia la sugerencia. |

## Rutas HTTP

### Contrato

| Método y ruta | Respuesta | Descripción |
|---|---|---|
| `GET /parts/{part_id}/availability` | 200 / 404 | Existencia total y por ubicación (`on_hand`, `reserved`, `available`). |
| `GET /parts/{part_id}/ledger` | 200 / 404 | Kardex: movimientos con el saldo después de cada uno. |
| `GET /work-orders/{code}/materials` | 200 / 404 | Por línea de la orden: `required`, `reserved`, `issued`, `missing`. |
| `GET /shortages?work_order_code=&part_id=` | 200 | Faltantes abiertos. |
| `GET /reorder-suggestions` | 200 | Sugerencias de reabasto. |
| `GET /unmatched-receipts` | 200 | Recepciones sin relacionar. |
| `POST /unmatched-receipts/{id}/resolve` | 200 / 404 / 409 | Relaciona una recepción con una pieza (`{part_id, location_id?}`). 409 si ya estaba resuelta. |
| `POST /issues` | 201 / 404 / 409 | Salida de material (`{work_order_code, part_id, location_id, quantity, issued_by}`). 409 si no alcanza. |
| `POST /transfers` | 201 / 404 / 409 / 422 | Transferencia entre ubicaciones. Origen igual a destino da 422. |
| `POST /counts` | 201 / 404 / 422 | Conteo físico (`{location_id, reason, lines:[{part_id, counted_quantity}]}`). Sin `reason` da 422. |

### Extensión

| Método y ruta | Descripción |
|---|---|
| `GET /events?origin=&type=&status=&topic=&limit=` | Lista lo consumido y lo generado: `event_inbox` (`origin=inbox`), `outbox_event` (`origin=outbox`) y `dead_letter_event` (`origin=dlq`). Cada elemento es el sobre del evento más `origin`, `topic`, `status`, `error`, `retries` y `recorded_at`. Solo lectura. |
| `GET /scan?code=` | Resuelve lo que leyó la cámara (ver [Escaneo en piso](#escaneo-en-piso)). |
| `GET /locations?code=&active=` | Ubicaciones (`location_id`, `code`, `name`, `is_workbench`, `is_receiving`, `active`). |
| `GET /locations/{location_id}/stock` | Lo que el sistema espera en una ubicación, por pieza: para el conteo cíclico. |
| `GET /stock-balances?location_id=&part_id=` | Existencias por pieza y ubicación en una sola llamada (`on_hand`, `reserved`, `available`). |
| `POST /agent/messages` | El agente entrega el mensaje que generó (`{message, data?}`) y la API se lo manda a la UI por WebSocket (`agent:message`). Responde 202. |
| `POST /purchase-orders` | Crea una orden de compra: `purchase_request`, `purchase_order` y `purchase_line`. No emite eventos `stock.*`. |
| `PATCH /parts/{part_id}` | Modifica la política de reabasto del tipo de pieza (`reorder_policy`: mínimo, máximo, cantidad de reorden y lead time). Las columnas de `part` vienen de `part.upserted` y no se parchean. |
| `GET /parts?q=&sku=&condition=&available=` | Busca tipos de pieza (`v_part_agent_summary`): existencia y cuántas unidades hay en cada estado. |
| `GET /parts/{part_id}` | Detalle de un tipo de pieza. |
| `GET /part-instances?part_id=&condition=&work_order_code=` | Unidades físicas (`v_part_instance_agent`) con su estado, ubicación, orden, serie, herramientas (`tools`) y repuestos faltantes (`missing_components`). |
| `GET /part-instances/{instance_id}` | Detalle de una unidad física. |
| `PATCH /part-instances/{instance_id}` | Modifica una unidad física (`condition_code`, `location_id`, `work_order_id`, `serial_number`, `note`). Cada cambio de estado queda en `part_status_history`. |
| `GET /suppliers` | Proveedores. |
| `GET /work-orders` y `GET /work-orders/{code}` | Órdenes de trabajo y su historial de etapas. |
| `GET /health` | Estado de la API: base de datos, eventos pendientes en `event_inbox`, `outbox_event` sin publicar y eventos en la DLQ. |

`GET /parts` devuelve hasta 1000 piezas por defecto (la UI pide el catálogo completo). En
`GET /parts/{part_id}/availability` cada ubicación reporta su `reserved` y `available` reales, porque la
reserva se reparte entre ubicaciones.

### Escaneo en piso

La cámara del celular la decodifica el navegador; la API solo identifica lo leído. Las etiquetas son Code 128
(contrato §5): ubicación = su `code` (`U-101`), pieza = su `sku` tal cual (`7014 CTA/P4`) o `P-<part_id>` si no
tiene `sku`.

`GET /scan?code=<texto>` (el texto va en la query, no en la ruta: los `sku` traen diagonales y comas) responde
`{code, kind, ambiguous, matches}`:

- `kind = 'location'`: ubicación por `code` (sin distinguir mayúsculas).
- `kind = 'part'`: pieza por `sku` exacto; si no, por `P-<part_id>`; si no, por `sku` sin mayúsculas ni espacios
  en los extremos. Cada coincidencia trae `on_hand`, `reserved` y `available`.
- `ambiguous = true` cuando un `sku` es de varias piezas: la UI pide elegir.
- `kind = 'unknown'` si nada coincide.

Con la ubicación y la pieza, la UI llama `POST /issues`, `POST /transfers` o `POST /counts` (que piden ids). Para el
conteo, `GET /locations/{location_id}/stock` dice qué espera el sistema en esa ubicación. Desde el celular todo va
por HTTPS (ver [HTTPS para el celular](#https-para-el-celular)).

## WebSocket

La API es el servidor de WebSocket (socket.io, en los mismos puertos que HTTP: `ws://` en `8000` y `wss://`
en `8443`). Es un solo servidor: un evento llega a la UI sin importar por cuál puerto se conectó. La UI se
conecta con `socket.io-client`:

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:8000'); // en el celular: 'https://<ip-de-la-laptop>:8443'
socket.on('notification', (event) => { /* nueva alerta: event.event_type, event.data */ });
socket.on('agent:message', (msg) => { /* mensaje del agente: msg.message */ });
socket.emit('parts:list', { q: 'motor' }, ({ items }) => { /* productos */ });
```

| Mensaje | Dirección | Contenido |
|---|---|---|
| `notification` | API → UI | Sobre del evento (`event_id`, `event_type`, `occurred_at`, `key`, `data`, …). Llega por cada evento `stock.*` que genera la API y por cada evento que consume de SQS. |
| `agent:message` | API → UI | `{message, data, received_at}`: lo que el agente entregó en `POST /agent/messages`. |
| `parts:list` | UI → API, con respuesta | Mismos filtros que `GET /parts`; responde `{items}`. |

Las notificaciones salen solo después de guardar el cambio en la base. Una UI desconectada no recibe lo
que pasó mientras tanto: al reconectar vuelve a pedir los datos.

## Convenciones de la API

- JSON UTF-8. Un `part_id` que no es entero responde 404.
- Errores: `{"detail": "..."}`. Validación del cuerpo fallida: **422**.
- Listas: `{"items": [...]}`.
- Importes como texto decimal (`"1850.00"`), cantidades enteras y fechas ISO 8601 UTC terminadas en `Z`.
- Sin autenticación por ahora. Las rutas del contrato nunca la llevarán.
- CORS solo para los orígenes de la UI, según `NODE_ENV` (ver [Variables de entorno](#variables-de-entorno)).
  El agente llama desde servidor, así que CORS no le aplica.
- TypeORM con `synchronize: false`. Las columnas generadas (`part.sku_norm`, `stock_balance.available`) son
  de solo lectura y las vistas (`v_part_availability`, `v_part_agent_summary`, `v_part_instance_agent`, `v_open_shortages`,
  `v_unmatched_receipts`, `v_reorder_suggestions`, `v_part_ledger`) también.

## Pruebas

```bash
npm run test        # unitarias
npm run test:e2e    # end-to-end (necesita la base de hack-saltillo-db en localhost)
npm run test:cov    # cobertura
```

`test/ingest.e2e-spec.ts` corre los 14 escenarios de `contract-tests/run_tests.py` del kit con sus mismas
comprobaciones, pero entregando los eventos directo al pipeline y leyendo las salidas de `outbox_event`; además
valida cada evento de salida contra `contract/schemas/output` y su `key`. Usa ids propios por corrida y borra lo
suyo al terminar.

Las pruebas de contrato del kit (`hackathon-inventario-kit`) publican y leen por Kafka; con SQS necesitan la misma
adaptación que el simulador: publicar en las colas de entrada (con un `MessageDeduplicationId` nuevo por envío,
para que los reenvíos del mismo `event_id` lleguen a la API) y leer `inventory-broker-inventory-events.fifo`
(su `MessageGroupId` hace de `key`). La API responde en el puerto 8000:

```bash
docker compose run --rm contract-tests --api http://host.docker.internal:8000
```

Conviene correr **un solo** servicio de inventario mientras se prueba: las pruebas leen toda la cola
`inventory-broker-inventory-events.fifo`.

**Reconstrucción (regla 23).** SQS no permite releer lo consumido: tras borrar la base, el simulador vuelve a
mandar los eventos y la API los aplica desde cero (catálogo primero). Deja pasar al menos 20 s entre detener la
API y reenviar: un *long poll* que la API dejó abierto al apagarse puede quedarse con los primeros mensajes, que
SQS no vuelve a entregar hasta que vence su visibility timeout (60 s), y `compare` lo toma como que ya terminó.

## Despliegue

La API se despliega en AWS ECS. La base de datos vive en un RDS compartido y las credenciales de SQS salen
del rol de la tarea, no de variables de entorno. La imagen debe llevar `contract/schemas` junto a `dist/`
(la API valida los eventos contra esos archivos). Con SIGTERM la API deja de leer las colas y termina el
mensaje en curso.

`.env` (`NODE_ENV=dev`) trae placeholders `<...>` para lo que sale de cada deploy: el endpoint y las
credenciales del RDS, la región y la cuenta de las colas SQS (las URLs ya llevan los nombres de
`hack-saltillo-broker`), el dominio de CloudFront de la UI en `CORS_ORIGINS` y la URL del agente.

La UI en CloudFront es HTTPS, así que la API también debe exponerse por HTTPS: lo normal es un balanceador
(ALB con certificado de ACM) delante de ECS que reenvía a `PORT`, con `HTTPS_KEY_PATH` y `HTTPS_CERT_PATH`
vacías. El balanceador debe dejar pasar WebSocket (el ALB lo hace por defecto).
