# Reto Roceel

## API
Agente va a correr cada hora simulada (cada 10 minutos en realidad), va a leer la base de datos y en base a diferentes factores cuando es el mejor momento para comprar un producto.

Los factores salen de la base: existencia (`v_part_availability`), faltantes (`v_open_shortages`), mínimos y lead time (`reorder_policy`), sugerencias (`reorder_suggestion`), precio histórico (`purchase_line.unit_price`) y fecha de entrega (`purchase_order.expected_at`).
La api siempre esta conectada al broker (AWS SQS): un consumidor en segundo plano hace *long polling* a las colas de entrada. En el momento que se desconecta, sabe exactamente en que punto se quedo y comienza a consumir los eventos nuevos.
SQS no guarda offsets: un mensaje solo se borra de la cola (`DeleteMessage`) después de guardarse en la base, así que lo que no se confirmó sigue en la cola (o reaparece al vencer su *visibility timeout*) y se vuelve a leer. SQS tampoco permite releer lo ya borrado: el historial completo de lo consumido queda en `event_inbox`. La base garantiza que releer no duplica nada: `event_inbox.event_id` es llave primaria.

API
La aplicacion te puede permitir buscar o preguntarle al agente. Ambos mandan llamar los endpoints de la API para conocer esta informacion. La API permite CORS solamente desde el origen de la UI (`http://localhost:5173` en local); el agente llama desde servidor, así que CORS no le aplica.

### Comunicación
- **Agente ↔ API: REST (HTTP).** El agente consulta las rutas de la API como cualquier cliente HTTP y le entrega a la API los mensajes que genera (`POST /agent/messages`).
- **UI ↔ API: WebSocket.** La API es el servidor de WebSocket (socket.io, mismo puerto `8000`). La UI se conecta y renderiza lo que la API le manda:
  - `notification`: cada evento que la API consume de SQS (ya procesado) y cada evento `stock.*` que genera. La UI lo muestra como una nueva notificación/alerta.
  - `agent:message`: el mensaje que generó el agente.
  - `parts:list`: la UI pide los productos de la base y la API responde con ellos (mismos filtros que `GET /parts`).
- La UI también puede usar las rutas REST (por ejemplo, las del contrato para el escaneo en piso).
El simulador solamente genera eventos y los manda a SQS; cada mensaje trae el evento como JSON.
La api tiene que consumir estos JSON, ademas llegando los eventos se guarden bien conforme a la arquitectura de la base de datos.
Cada evento se guarda primero completo en `event_inbox` (sobre en `payload` JSONB) y después se proyecta a las tablas de dominio. Los eventos que genera la API (`stock.*`) se encolan en `outbox_event` y se publican en la cola `inventory-broker-inventory-events.fifo`; los que no se pueden procesar van a `dead_letter_event` y a la cola `inventory-broker-inventory-dlq.fifo`.

### Broker (SQS)
Una cola FIFO por cada tópico del simulador, más la de notificaciones. Son FIFO porque el contrato pide orden por llave: el `key` del evento va como `MessageGroupId` y el `event_id` como `MessageDeduplicationId`. Las colas tienen desactivada la deduplicación basada en contenido, así que `MessageDeduplicationId` es **obligatorio** en cada envío. SQS exige que el nombre de una cola FIFO termine en `.fifo`.

| Cola | Dirección | Eventos |
|---|---|---|
| `inventory-broker-shop-catalog.fifo` | entrada | `part.upserted`, `location.upserted`, `bom.upserted` |
| `inventory-broker-shop-work-orders.fifo` | entrada | `work_order.opened`, `.stage_changed`, `.deleted` |
| `inventory-broker-shop-inspections.fifo` | entrada | `inspection.submitted`, `.approved`, `.rejected`, `.discarded`, `.voided` |
| `inventory-broker-shop-purchasing.fifo` | entrada | `purchase.item_received` |
| `inventory-broker-notifications.fifo` | entrada | Eventos que genera el mensaje del usuario al agente; la API decide qué hacer según el `event_type` (tipo y formato por definir) |
| `inventory-broker-inventory-events.fifo` | salida | `stock.*` |
| `inventory-broker-inventory-dlq.fifo` | salida | Evento original que no se pudo procesar |

La API **no** consume `inventory-events` ni `inventory-dlq`: son su salida. En SQS cada mensaje lo recibe un solo consumidor, así que si la API las leyera se llevaría sus propios eventos.

### Unidades físicas
El estado y la reparación son de cada **unidad física**, no del tipo de pieza. Dos motores iguales son dos filas independientes en `part_instance`, cada una con su propio estado, ubicación, orden de trabajo, número de serie y receta de reparación:
- Motor 1: defectuoso, le falta la banda; necesita llave Allen y prensa.
- Motor 2: defectuoso, le falta un tornillo; necesita llave Allen y torquímetro.

| Tabla / vista | Qué guarda |
|---|---|
| `part_instance` | Una fila por unidad: `part_id` (tipo), `condition_code`, `location_id`, `work_order_id`, `inspection_item_id`, `serial_number`, `note`. |
| `part_instance_repair_tool` | Herramientas que necesita **esa** unidad para repararse. |
| `part_instance_repair_component` | Repuestos que le faltan a **esa** unidad (banda, tornillo, …). |
| `part_status_history` | Cambios de estado, con `instance_id` de la unidad. |
| `v_part_instance_agent` | Por unidad: estado, ubicación, orden, serie, `tools` y `missing_components`. |
| `v_part_agent_summary` | Por tipo: existencia y cuántas unidades hay en cada estado. |

Las unidades son una capa aparte del inventario: **no** modifican `movement` ni `stock_balance`, la existencia sigue siendo por cantidad. Por ahora `inspection.approved` no crea ni actualiza unidades; se modifican desde la API.

### Endpoints
- GET events
  - El consumo **no** es una ruta HTTP: lo hace el consumidor en segundo plano mediante nestjs-microservices, con un transporte propio sobre SQS (`@aws-sdk/client-sqs`). Cada evento se despacha a su función con `@EventPattern(<event_type>)`.
  - Un evento es `{event_id (UUID), event_type, event_version, occurred_at, source, key, data}`; la función se elige por `event_type`.
  - `GET /events` lista lo ya consumido y lo generado: `event_inbox` (entrada), `outbox_event` (salida), `dead_letter_event` (DLQ). Es de solo lectura. La autenticación (JWT) queda pospuesta.
  - Cada evento procesado se le manda a la UI por WebSocket (`notification`).
- POST agent/messages
  - `POST /agent/messages` `{message, data?}`: el agente entrega el mensaje que generó y la API se lo manda a la UI por WebSocket (`agent:message`). No se guarda en la base.
- POST product/ordenCompra,
  - "product" es `part` (`part_id` entero) y "ordenCompra" es `purchase_order` (`po_number`, `supplier_id`, `status`, `currency`, `ordered_at`, `expected_at`) con sus renglones en `purchase_line` (`part_number`, `part_id`, `quantity`, `unit_price`, `currency`, `purpose`) colgando de una `purchase_request`.
  - El contrato no define órdenes de compra: es una extensión de la base. `purchase_request_id` y `line_id` son enteros **sin secuencia**; hay que asignarlos desde la API (ver `API README.md`, sección 12).
- PATCH {product id}, para modificar parte de un registro en especifico de la base de datos
  - `PATCH /part-instances/{instance_id}`: modifica **una unidad física** (`condition_code`, `location_id`, `work_order_id`, `serial_number`, `note`). Cada cambio de estado se registra en `part_status_history` con su `instance_id`. `condition_code` se valida contra `part_condition`.
  - `PATCH /parts/{part_id}`: solo la política de reabasto del tipo (`reorder_policy`: `min_quantity`, `max_quantity`, `reorder_quantity`, `lead_time_days`). `{part_id}` es entero. Las columnas de `part` vienen de `part.upserted` y el siguiente evento las sobrescribe, así que no se parchean.
  - **Por definir:** alta de unidades (cuándo y cómo se crea una `part_instance`) y escritura de la receta de reparación (`part_instance_repair_tool`, `part_instance_repair_component`). Por ahora la receta solo se lee.
- GET productos, otras cosas de la base de datos, esto mediante TypeORM
  - `GET /parts`: "productos" es la tabla `part`; se lee de `v_part_agent_summary` (existencia `on_hand` / `reserved` / `available`, unidades `defective_units`, `under_repair_units`, `functional_units`, `total_units` y `open_shortages`) y `v_part_availability`.
  - `GET /part-instances?part_id=&condition=&work_order_code=` y `GET /part-instances/{instance_id}`: unidades físicas desde `v_part_instance_agent`, con sus herramientas (`tools`) y repuestos faltantes (`missing_components`).
  - Las columnas generadas (`part.sku_norm`, `stock_balance.available`) son de solo lectura y `synchronize` va en `false`: el esquema lo crea Liquibase.
- GET health

## Deployment
Esta es la fase final.
la api se va a mandar a un ecs.
La base de datos real vive en un RDS compartido. En ECS las credenciales de SQS salen del rol de la tarea, no de variables de entorno.

## Flujo
La API recibe los cambios a realizar a traves de los eventos que consume de SQS.

El agente habla con la API por REST (HTTP) y la API habla con la UI por WebSocket.

Evento:
broker SQS (tiene evento) -> api (consumiendo evento por evento) -> ui/agente/db (basandose en el evento la api decide que hacer y que endpoint usar; a la ui le llega como `notification` por WebSocket) 

pregunta del agente:
ui (mensaje del usuario, manda evento) -> broker SQS (cola `inventory-broker-notifications.fifo`) -> api (consume el evento) -> agente (lee el mensaje) -> api (query del agente, HTTP) -> agente (recibe los datos y los procesa) -> api (`POST /agent/messages`) -> ui (respuesta del agente, `agent:message` por WebSocket)

automatico lectura base de datos:
agente (leer base de datos) -> api (obtener los registros, HTTP) -> agente (recibe los datos) -> api (recibe mensaje generado, `POST /agent/messages`) -> ui (muestra el mensaje generado para el agente, `agent:message` por WebSocket)
