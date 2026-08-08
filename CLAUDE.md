# CLAUDE.md — BotPanel SaaS

Guía obligatoria para trabajar en este proyecto sin romper la arquitectura ni el trabajo existente. Léela completa antes de actuar.

**Este archivo es lo que hay que tener en la cabeza SIEMPRE.** Lo demás vive
aparte y se consulta cuando la tarea lo toca — así esta guía se puede leer
entera de verdad, que era el problema cuando todo estaba junto:

| Documento | Cuándo leerlo |
|---|---|
| **[DECISIONES.md](DECISIONES.md)** | Antes de tocar la tienda, el modo menú, hospedaje, el registro de errores, la vigilancia del canal… Casi cada apartado existe porque algo falló: lo que parece complejidad de más suele ser una cicatriz. |
| **[VERIFICACION.md](VERIFICACION.md)** | Antes de tocar el CI, el esquema o las migraciones. Qué comprueba cada capa, qué **no**, y de qué incidente nació. |
| **[PENDIENTE.md](PENDIENTE.md)** | Cuando surja "¿y si añadimos…?". Lista de módulos futuros y de decisiones de **no** construir todavía. |
| **[ARQUITECTURA.md](ARQUITECTURA.md)** | Antes de crear archivos o features nuevas. |
| **[DISENO-MINIAPP.md](DISENO-MINIAPP.md)** | Antes de tocar la apariencia de la tienda. Es el respaldo escrito del diagrama aprobado: estructura de las once pantallas, los tres selectores y qué NO se copia. La imagen manda si la tienes; esto existe para que la referencia no se pierda entre sesiones. |

---

## AL INICIAR CUALQUIER TAREA (flujo obligatorio)

1. **ORIENTARTE** — Ten presente estas reglas y el **MAPA DE SKILLS** (sección 10). Identifica qué skills aplican al pedido y consúltalas ANTES de actuar.
2. **ACOTAR** — Reformula en una frase qué se va a cambiar y qué **NO** se va a tocar. Si el pedido es ambiguo, **pregunta antes de asumir**.
3. **PROTEGER** — Si el cambio toca base de datos, RLS, auth, etiquetas/tools del bot o multi-tenancy → consulta **arquitecto-saas** (y **base-de-datos** / **seguridad-saas** si corresponde) antes de seguir.
4. **PLAN** — Propón un plan breve (qué archivos se tocan y cómo) y **espera aprobación del usuario**. No escribas código hasta que el plan sea aprobado.
5. **CAMBIO MÍNIMO** — Haz el cambio más pequeño que cumpla el pedido. No reescribas archivos enteros ni borres funciones, campos, endpoints o validaciones que no se pidieron.
   - Si el cambio **corta un flujo** (un modo nuevo, un atajo, un `return` temprano): antes de escribirlo, lista **qué HACÍA de paso** el camino que saltas — marcar leído, guardar el mensaje, actualizar la sesión, registrar consumo, liberar un lock. Conserva todo lo que no sea "pensar", y añade una prueba por cada efecto que conservas. Ver **cambios-seguros**. Así se perdió el check azul el 2026-08-03: nueve pruebas en verde comprobando lo nuevo, y nadie miró lo que dejó de ocurrir.
6. **VERIFICAR** — Corre las verificaciones según **tester-saas** (carga de módulos, sintaxis, arranque, smoke test).
7. **REPORTAR** — Di qué archivos cambiaron, qué se verificó y qué **NO** se tocó.

> Ante la duda, para y pregunta. Es preferible una pregunta de más que romper algo que ya funcionaba.

---

## 1. QUÉ ES EL PROYECTO

> 📐 **Arquitectura objetivo y plan de migración:** ver **`ARQUITECTURA.md`** (decidido 2026-07-06: migración GRADUAL a monorepo con server ordenado en routes/services + paneles en React+Vite+TS; patrón estrangulador, nunca big-bang; regla: todo lo NUEVO nace en la estructura nueva). Leerlo antes de crear archivos o features nuevas.

**BotPanel** es un SaaS **multi-empresa** que ofrece bots de atención al cliente con IA en **WhatsApp y Telegram**. Sirve a negocios como perfumerías, barberías, tiendas y clínicas: cada negocio tiene su propio bot (prompt, catálogo, horarios), su panel de cliente, y un panel de administración central (el dueño del SaaS) gestiona todos los negocios, sus credenciales y la facturación. El bot responde texto, voz e imágenes, agenda citas, vende, y deriva a un humano cuando hace falta.

---

## 2. STACK OFICIAL (no se cambia sin pedido explícito)

- **Node.js** ≥ 22 + **Express** ^4.19
- **Supabase (PostgreSQL)** vía `@supabase/supabase-js` ^2.43, con **pgvector** (RAG)
- **Auth:** `jsonwebtoken` ^9 (JWT) + `bcryptjs` ^2.4
- **IA (multi-proveedor):** `openai` ^6.45 (OpenAI + compatible Groq), `@anthropic-ai/sdk` ^0.24 (Claude), Gemini (API nativo vía `axios`), Groq (vía SDK OpenAI con baseURL)
- **WhatsApp:** YCloud (principal) y Meta Graph API — vía `axios`
- **Telegram:** `telegraf` ^4.16
- **HTTP:** `axios` ^1.7 · **Rate limit:** `express-rate-limit` ^8.5 · **CORS:** `cors`
- **Túnel local:** `cloudflared` (solo desarrollo; no forma parte del deploy)
- **Frontend:** React + Vite + TypeScript + Tailwind CSS + shadcn/ui
- **Calidad:** TypeScript estricto + ESLint/Oxlint + Vitest + Playwright E2E + GitHub Actions CI

---

## 3. ESTRUCTURA DEL PROYECTO

```
bot/
├── server/                    # Backend Node.js + Express
│   ├── dist/                  # JavaScript compilado; único runtime del backend
│   ├── eslint.config.js       # Único JavaScript fuente: configuración de herramientas
│   ├── src/lib/calendar.ts    # Cálculos de calendario nativos en TypeScript
│   ├── src/index.ts           # Composición y arranque tipados de Express
│   ├── src/db/client.ts       # Conexión Supabase única y exclusiva del servidor
│   ├── src/db/index.ts        # Compositor tipado de todos los repositorios
│   ├── src/db/repositories/businesses.ts # Negocios y onboarding tipados
│   ├── src/db/repositories/client-users.ts # Dueño y empleados aislados por negocio
│   ├── src/db/repositories/policies.ts # Prompt y políticas por business_id
│   ├── src/db/repositories/billing.ts # Facturación SaaS y generación de cuotas
│   ├── src/db/repositories/products.ts # Catálogo y embeddings aislados por negocio
│   ├── src/db/repositories/product-options.ts # Grupos, opciones y plantillas que administra el dueño
│   ├── src/db/repositories/conversation-history.ts # Mensajes e historial por contacto
│   ├── src/db/repositories/sessions.ts # Modo manual, lectura y estado por business_id
│   ├── src/db/repositories/conversation-tags.ts # Etiquetas aisladas por negocio
│   ├── src/db/repositories/bookings.ts # Horarios, disponibilidad y reservas tipadas
│   ├── src/db/repositories/sales.ts # Ventas y detalles mediante RPC atómica
│   ├── src/db/repositories/reporting.ts # Consultas analíticas aisladas por negocio
│   ├── src/db/repositories/orders.ts # Pedidos e ítems mediante RPC atómica
│   ├── src/db/repositories/lodging.ts # Habitaciones, tarifas, cotizaciones, holds y bloqueos
│   ├── src/db/repositories/stats.ts # Métricas admin/cliente con aislamiento
│   ├── src/db/repositories/webhook-events.ts # Reclamos SHA-256 persistentes
│   ├── src/services/secrets.ts  # Saneamiento tipado de credenciales de negocios
│   ├── src/services/notify.ts   # Enrutamiento tipado de notificaciones por canal
│   ├── src/services/settings.ts # Config global permitida, cacheada y con errores comprobados
│   ├── src/services/reports.ts # Reportes, dashboard y alertas tipados y aislados por negocio
│   ├── src/services/schedule.ts # Horario Ecuador, mensaje fuera de atención y formato para prompt
│   ├── src/services/ai.ts      # Chat multi-proveedor, visión, audio y embeddings tipados
│   ├── src/services/prompt.ts  # Catálogo, políticas, variables y reglas técnicas del prompt
│   ├── src/services/media.ts   # Data URLs y descarga binaria con timeout
│   ├── src/services/channel-resolution.ts # Resolución coherente de aliases exactos por proveedor
│   ├── src/services/bot-tags.ts # Parser puro de reservas, pedidos, handoff y media
│   ├── src/services/bot-actions.ts # Acciones tipadas y multi-tenant de reservas, sesiones y pedidos
│   ├── src/services/bot-media.ts # Selección estricta y envío tipado de media por negocio
│   ├── src/services/bot-menu.ts # Menú guiado de bienvenida por capacidades (hoy solo simulador)
│   ├── src/services/bot-menu-flow.ts # Modo menú estilo banco: máquina de estados sin IA (hoy solo simulador)
│   ├── src/services/bot-conversation.ts # Flujo central tipado, desde sesión hasta respuesta
│   ├── src/services/bot-entry.ts # Debounce, resolución de negocio y adaptadores WA/TG tipados
│   ├── src/services/business-templates.ts # Con qué catálogo nace cada tipo de negocio (solo recomienda al crear)
│   ├── src/services/pricing.ts # Las 8 estrategias de cobro por grupo (copia en TS de lo que cobra la base)
│   │                            # y `quoteCart` en storefront.ts: el total exacto antes de confirmar, sin crear el pedido
│   ├── src/services/money.ts   # Resolución estricta, centavos, totales y resumen oficial
│   ├── src/services/lodging.ts # Contratos y normalización del núcleo de hospedaje
│   ├── src/services/channel-health.ts # Vigilancia del canal de entrada: silencio por negocio y fallos del webhook
│   ├── src/services/order-notify.ts # El ÚNICO aviso saliente del pedido: confirmado y en preparación
│   ├── src/services/error-log.ts # Registro saneado de errores de plataforma (canal, IA, envío, servidor)
│   ├── src/db/repositories/platform-errors.ts # Errores agrupados por huella, consultables desde el admin
│   ├── src/services/tunnel.ts # Estado, arranque y cierre tipados del túnel local
│   ├── src/integrations/ycloud.ts # Envío WhatsApp + typing indicator tipados
│   ├── src/integrations/whatsapp.ts # Selección segura Meta/YCloud por negocio
│   ├── src/integrations/telegram.ts # Comandos, voz, fotos, webhook/polling y sesión por slug
│   ├── src/integrations/cloudinary.ts # Media aislada por negocio
│   ├── src/middleware/async.ts  # Propagación tipada de errores async de Express
│   ├── src/middleware/auth.ts   # JWT, roles y permisos tipados
│   ├── src/routes/orders.routes.ts # Pedidos del cliente aislados por JWT, con filtro por estado
│   ├── src/routes/auth.routes.ts # Login admin/cliente con rate limit
│   ├── src/routes/reports.routes.ts # Reportes y dashboard aislados por JWT
│   ├── src/routes/sales.routes.ts # Ventas manuales y cotizaciones tipadas
│   ├── src/routes/sessions.routes.ts # Conversaciones, modo manual y etiquetas aislados
│   ├── src/routes/webhooks.routes.ts # Entradas Meta/YCloud firmadas, limitadas y deduplicadas
│   ├── src/routes/admin-billing.routes.ts # Facturación del SaaS protegida para superadmin
│   ├── src/routes/admin-clients.routes.ts # Clientes y onboarding del superadmin, con errores verificados
│   ├── src/routes/admin-providers.routes.ts # Verificación segura de canales externos
│   ├── src/routes/admin-tunnel.routes.ts # Dominio/túnel y bloqueo de configuración Supabase
│   ├── src/routes/admin-settings.routes.ts # Keys globales enmascaradas y verificables
│   ├── src/routes/admin-simulator.routes.ts # Pruebas del bot aisladas y persistidas por negocio
│   ├── src/routes/admin.routes.ts # Composición TypeScript de todos los dominios del superadmin
│   ├── src/routes/bookings.routes.ts # Horarios y reservas aislados por JWT
│   ├── src/routes/business-profile.routes.ts # Identidad y políticas seguras
│   ├── src/routes/business-management.routes.ts # Onboarding y equipo seguros
│   ├── src/routes/business.routes.ts # Composición TypeScript del negocio
│   ├── src/routes/products-core.routes.ts # Catálogo y reindexación aislados
│   ├── src/routes/products-media.routes.ts # Upload multipart validado
│   ├── src/routes/products.routes.ts # Composición TypeScript del catálogo
│   ├── src/routes/product-options.routes.ts # CRUD del motor de opciones para el dueño (grupos, opciones, plantillas)
│   ├── src/routes/lodging.routes.ts # Hospedaje aislado por JWT, capacidad y permiso
│   ├── src/types/express.d.ts   # Claims compartidos de autenticación Express
│   ├── src/types/channels.ts    # Provider, tipo y normalización exacta de identificadores
│   ├── schema.sql             # Esquema consolidado y ACTUALIZADO (referencia única — ver sección 4)
│   ├── migration-ventas-reportes.sql  # Migración de ventas + reportes (correr en Supabase)
│   ├── migration-atomicidad-onboarding.sql # Negocio, dueño, políticas y cuotas transaccionales
│   ├── migration-atomicidad-pedidos.sql # Cabecera, ítems y totales de pedidos transaccionales
│   ├── migration-2026-08-02-estados-pedido.sql # Preparación y reparto: máquina de estados sin retroceso
│   ├── migration-2026-08-02-tienda-pago-envio-marca.sql # Envío en la base, método de pago, comprobante y color por negocio
│   ├── migration-2026-08-02-logo-negocio.sql # Logo del negocio (solo https) visible en su mini app
│   ├── migration-2026-08-02-pedido-entregado-es-venta.sql # Entregar un pedido lo registra en el reporte de ventas
│   ├── migration-2026-08-02-pedido-de-mostrador.sql # La venta en persona entra por el mismo camino que el resto
│   ├── migration-2026-08-02-cita-atendida-es-venta.sql # Servicios: la cita lleva precio y al atenderla se registra la venta
│   ├── migration-2026-08-02-modo-miniapp.sql # Tercer modo de atención: el enlace pertenece solo al modo mini app
│   ├── migration-2026-08-02-retirar-venta-manual.sql # Se retira el alta manual: toda venta nace de un pedido o una cita
│   ├── migration-2026-08-02-estadia-confirmada-es-venta.sql # Hospedaje entra al mismo reporte que el resto
│   ├── migration-2026-08-04-motor-de-opciones.sql # Grupos obligatorios, mínimos, selección por cantidad y combos
│   ├── migration-2026-08-05-grupos-por-categoria.sql # El grupo cuelga de un producto O de una categoría, nunca de ambos
│   ├── migration-2026-08-05-plantillas-de-negocio.sql # El catálogo de arranque del tipo, que no pisa negocios con catálogo
│   ├── migration-2026-08-05-opciones-en-el-pedido.sql # El pedido recalcula opciones, exige obligatorios y congela lo elegido
│   ├── migration-2026-08-05-pedidos-sin-duplicados.sql # Clave por carrito, historial de estados y los cinco estados de pago
│   ├── migration-2026-08-05-adicionales.sql # «Agrega algo más»: otros productos como línea propia del carrito
│   ├── migration-2026-08-05-comprobantes-privados.sql # El comprobante deja de ser público y el pedido pasa a revisión
│   ├── migration-2026-08-05-motor-de-productos.sql # product_type, estrategias de precio y plantillas reutilizables
│   ├── migration-2026-08-05-estrategias-de-precio.sql # El pedido cobra cada grupo según su estrategia (la mitad y mitad)
│   ├── migration-2026-08-06-tiempo-de-preparacion.sql # Cuánto tarda cada negocio: lo pone el dueño, el tipo solo lo recomienda
│   ├── migration-2026-08-07-portada-negocio.sql # La imagen a sangre de la tienda; mismo CHECK https que el logo
│   ├── migration-2026-08-07-numero-de-pedido.sql # Correlativo por negocio vía trigger: vale para el bot, la tienda y el Marketplace
│   ├── migration-2026-08-08-flujo-del-pedido.sql # Nace esperando_pago si transfiere; «aceptar y preparar» es un paso
│   ├── migration-2026-08-08-pago-confirmado.sql # El pago que llegó por WhatsApp: un hecho del pedido, no un estado
│   ├── migration-2026-08-08-aviso-al-cliente.sql # Un aviso por pedido: se reclama en el update, no se consulta antes
│   ├── migration-2026-08-07-checkout.sql # Instrucciones del pedido y el tercer método de pago
│   ├── migration-2026-08-07-pago-al-retirar-rpc.sql # El método también dentro de la RPC, que valida aparte del CHECK
│   ├── migration-atomicidad-reservas.sql # Lock + exclusión de intervalos activos por negocio
│   ├── migration-hospedaje.sql # Inventario, cotizaciones y holds de alojamiento transaccionales
│   ├── migration-preparacion-produccion.sql # Retiro seguro de cobros automáticos + horarios iniciales
│   ├── migration-deduplicacion-webhooks.sql # Reclamos atómicos de eventos por negocio
│   ├── migration-eliminar-kapso-retell.sql # Limpieza destructiva previa a identificadores
│   ├── migration-identificadores-canales.sql # IDs/teléfonos exactos, únicos y sincronizados
│   ├── migration-firmas-webhooks.sql # Endpoint ID + signing secret oficial de YCloud
│   ├── migration-inbox-webhooks.sql # Cola durable, leases, reintentos y dead-letter de webhooks
│   ├── migration-agrupado-webhooks.sql # Ventana durable y lote de textos rápidos por conversación
│   ├── migration-integraciones.sql    # Migración inicial (OBSOLETA — solo historial, no ejecutar)
│   └── .env                   # Credenciales (NUNCA a git)
├── apps/
│   ├── admin/                 # Panel del superadmin (React+Vite+TS) — OFICIAL, servido en /app-admin
│   ├── client/                # Panel del cliente (React+Vite+TS) — OFICIAL, servido en /app
│   └── store/                 # Mini app del negocio (React+Vite+TS) — servida en /t/:slug
├── packages/ui/               # Componentes shadcn/ui compartidos por ambos paneles
└── CLAUDE.md / README.md / ARQUITECTURA.md
```

- **La llave de tenant es `business_id`** (en código, `req.user.businessId`). Cuando estas reglas digan "client_id", en este proyecto es **`business_id`**.

---

## 4. REGLAS INVIOLABLES

1. **Aislamiento multi-tenant:** TODA consulta de datos de un negocio se filtra por **`business_id`**. En endpoints de cliente, el `business_id` SIEMPRE sale del JWT (`req.user.businessId`), **nunca** de un parámetro que el cliente pueda manipular. Toda tabla nueva nace con columna `business_id` + RLS. **Nunca** se desactiva ni se debilita una política RLS.
2. **Service role key solo en el servidor.** `SUPABASE_SERVICE_KEY` jamás se expone al frontend ni se envía a `admin/` o `client/`. El frontend nunca habla directo con Supabase.
3. **Nunca hardcodear secretos ni claves.** Usa variables de entorno o la tabla `server_settings` mediante `server/src/services/settings.ts`. Las keys de IA y de WhatsApp por cliente se guardan en BD, no en código.
4. **No reescribir archivos completos por cambios pequeños.** No borrar funciones, campos, endpoints ni validaciones que no se pidió tocar. Edición quirúrgica.
5. **Las etiquetas/tools del bot siempre operan sobre el `business_id` de la conversación.** El bot resuelve el negocio por el canal (slug de Telegram o número de WhatsApp) y SOLO usa datos de ese negocio (catálogo, horarios, políticas, historial).
6. **Cobro manual.** El bot calcula el total oficial y el negocio coordina el cobro directamente fuera de esta plataforma.
7. **El bot nunca inventa datos.** Precios, productos y horarios salen solo de los datos del negocio inyectados en el prompt.
8. **La IA conversa, el CÓDIGO calcula (núcleo de dinero).** Ningún monto que vea el cliente sale del modelo: totales, precios de pedidos y descuentos se calculan SOLO server-side (`server/src/services/money.ts` + tablas `orders`/`order_items`). El prompt es cortesía, no seguridad. Si un ítem del pedido no se resuelve con certeza contra el catálogo, NO se envía total (pasa al dueño). Los descuentos, si algún día existen, serán regla de código/panel — jamás decisión de la IA.
9. **Hospedaje no es una cita ni un pedido.** Fechas, noches, cantidad de habitaciones, huéspedes, disponibilidad, impuestos y total salen de `server/src/services/lodging.ts` y las RPC PostgreSQL. `##STAY_QUOTE##` solo consulta; `##STAY_REQUEST##` crea un hold temporal pendiente. Nunca confirma ni cobra automáticamente: el equipo confirma y coordina el pago manualmente.

> 🔍 **Las capas de verificación (qué comprueba cada una, qué NO, y de qué incidente nació) están en [VERIFICACION.md](VERIFICACION.md).** Léelo antes de tocar el CI, el esquema o las migraciones.


---

## 5. CÓMO MANEJAR UN PEDIDO DE CAMBIO

1. **Entender el alcance** y declarar en una frase qué SÍ y qué NO se toca.
2. **Localizar los archivos mínimos** involucrados (datos en `server/src/db/`; lógica del bot en `server/src/services/`; rutas en `server/src/routes/`; composición en `server/src/index.ts`).
3. **Cambio más pequeño posible** — edición quirúrgica, sin tocar lo no pedido.
4. **Verificar** (tester-saas): cargar módulos, revisar sintaxis, arrancar, smoke test de la zona afectada.
5. **Reportar** qué cambió, qué se verificó y qué quedó intacto.

Para cambios amplios o ambiguos → **cambios-seguros**. Para tocar BD/RLS/auth/bot → **arquitecto-saas** primero.

---

## 6. COMANDOS DEL PROYECTO (reales, de package.json)

```bash
# Raíz (monorepo con npm workspaces — UN solo lockfile e install para todo)
npm install               # instala server + apps/client + apps/admin de una vez
npm start                 # compila server y ejecuta server/dist/index.js
npm run dev               # nodemon del server (desarrollo, recarga al guardar)
npm run build             # compila server TypeScript + paneles client y admin
npm run check             # lint de todo + TypeScript estricto + tests del server
npm test                  # solo los tests (Vitest)
npm run test:e2e          # login, navegación, permisos y responsive en Chromium

# También se puede trabajar dentro de cada workspace (cd server && npm run dev, etc.)
```

> Los workspaces son `@botpanel/server`, `@botpanel/client`, `@botpanel/admin` y `@botpanel/ui`. El CI corre lint, tipos, tests y builds en cada PR. El servidor en local arranca un túnel Cloudflare automático; en producción usa `BASE_URL`.

---

## 7. CONVENCIONES DE CÓDIGO

- **TypeScript nativo:** toda implementación del backend vive en `server/src/**/*.ts`; `server/dist/` es el runtime compilado. Fuera de `dist`, solo `eslint.config.js` permanece JavaScript por ser configuración de herramientas.
- **Funciones flecha** y `async/await`. Nada de callbacks anidados.
- **Todo el acceso a Supabase pasa por `server/src/db/`** — no consultes `sb.from(...)` desde rutas, servicios o `src/index.ts`; agrega/usa una función en el repositorio correspondiente y expórtala desde `src/db/index.ts`.
- **Las keys de IA se leen siempre mediante `server/src/services/ai.ts` y `settings.get('...')`** (panel > .env).
- **Comentarios y logs en español.** Emojis en logs siguiendo el estilo existente (`✅ ❌ 🤖 📡 🛒 🤚 🔔`).
- **Textos de cara al cliente (bot y paneles) en español** neutro (mercado Ecuador/Colombia).
- **Menú guiado híbrido (`server/src/services/bot-menu.ts`):** en modo IA del simulador, los saludos ("hola", "menú") se responden con un menú de bienvenida generado por código según capacidades, y el resto sigue con IA. Quedó como respaldo del modo menú puro.
- **Telegram (`server/src/integrations/telegram.ts`):** el negocio se selecciona/restaura por `slug`; la restauración consulta únicamente el `business_id` más reciente de `tg_<chatId>` mediante la capa `src/db` y luego valida que el negocio siga activo. La integración no crea clientes Supabase propios. Texto, voz y fotos entregan siempre `{ channel:'telegram', ctx, slug }` a `bot-entry.ts`.
- **Dinero (`server/src/services/money.ts`):** calcula importes oficiales y las RPC revalidan negocio, producto, stock y precio. El flujo es manual: la plataforma registra el pedido y su entrega, pero no procesa ni registra el cobro del cliente.
- **Capacidades por negocio:** `businesses.takes_bookings`, `businesses.takes_orders` y `businesses.lodging_enabled` son fuentes de verdad independientes; el tipo solo recomienda valores al crear y nunca sobrescribe decisiones manuales ni negocios existentes. Pizzería/retail recomienda pedidos; servicios de cita recomiendan agenda e informativo; hotel/hostal/alojamiento recomienda hospedaje sin reutilizar citas ni pedidos. En modo informativo se responden precios, descripciones, stock, fotos y videos; solo la intención transaccional explícita deriva y jamás crea pagos o pedidos.
- **Catálogo de arranque (`server/src/services/business-templates.ts`):** al crear un negocio, su tipo decide con qué categorías y grupos de opciones nace —una hamburguesería trae Hamburguesas, Combos, Acompañantes y Bebidas, con Término, Extras y Retira ingredientes ya cargados. Sigue la misma regla que las capacidades: **solo recomienda al crear**. La RPC `apply_business_template` no toca un negocio que ya tenga una categoría o un producto y devuelve `aplicada: false`, así que jamás pisa decisiones manuales ni negocios existentes. Falla en silencio hacia el registro de errores: la plantilla va después del alta y no puede tumbarla. Los nombres de tipo deben existir en el desplegable del panel (`apps/admin/src/features/clients/business-types.ts`) o la plantilla queda muerta — lo vigila `tests/plantillas-negocio.test.js`.
- **Grupos de opciones:** un grupo cuelga de un **producto** o de una **categoría**, nunca de ambos ni de ninguno (`option_groups_destino_check`). Por categoría es como los 19 sabores los comparten todas las pizzas sin repetirlos, y como una plantilla deja grupos cargados antes de que exista un solo producto. Los dos destinos usan foránea compuesta sobre `(id, business_id)`. La mini app los pinta con tres selectores (`single` radio · `multiple` casillas con tope · `quantity` contador por opción) y bloquea el botón diciendo **qué falta**; `create_storefront_order` lo vuelve a exigir, que es lo único que de verdad manda. **La mini app ya NO usa `menu_modifiers`** — el modo menú del bot y el panel del dueño sí, así que durante esta etapa hay dos sitios donde se editan opciones.
- **Motor universal de productos:** `products.product_type` (simple·configurable·combo·daily_menu·weighted) NO es un `if` disfrazado — la app nunca pregunta «¿es pizza?», pregunta «¿este producto se arma eligiendo otros?». Un combo de hamburguesas y uno de pizzas recorren el mismo camino. **El importe se calcula POR GRUPO, no opción a opción** — es la única forma de responder «¿cuál es la más cara?». `option_groups.pricing_strategy` decide cómo cobra un grupo: `sum` (lo normal), `highest_selected` (**la pizza mitad y mitad**: media Suprema $10 + media Hawaiana $9 cuesta $10, no $19), `included`, `included_up_to_limit`, `extra_after_limit` con `free_selections`, y `fixed`/`lowest_selected`/`average`. Las **plantillas** (`option_templates` + `option_template_items`) se REFERENCIAN, no se copian: «Sabores de pizza» se define una vez y sirve a la primera pizza, la segunda, la tercera y las dos mitades — añadir un sabor lo añade en los cinco sitios. Prohibido crear columnas rígidas (`pizza_1`, `first_half`, `drink`): todo sale de grupos configurables. **Los combos no son un tipo aparte**: un producto `combo` es uno cuyos grupos tienen opciones con `references_product_id`, y la mini app los pinta como pasos numerados («1 Elige tu pizza», «2 Elige tu bebida») sin que exista ningún `ComboProductPage`. La opción que ES un producto hereda su foto y su descripción, para que el dueño no suba dos veces la misma imagen. **Tres motores calculan lo mismo y solo uno cobra**: `create_storefront_order` (la autoridad, regla #8), `server/src/services/pricing.ts` y `apps/store/src/lib/cart.ts` — la app tiene que pintar lo que se va a cobrar o el cliente se entera del precio real al confirmar. Los tres comparten los mismos ocho casos de prueba a propósito. Dos reglas que no son obvias: `highest_selected` mira el precio UNITARIO (dos medias pizzas son una), y las estrategias con límite descuentan las opciones MÁS CARAS, nunca por orden de clic — si dependiera del clic, dos clientes con lo mismo en el carrito pagarían distinto.
- **El dueño configura, la mini app obedece:** el motor de opciones se administra desde `Catálogo → Personalización` (`apps/client/src/features/catalog/OptionsManager.tsx` sobre `product-options.routes.ts`). Todo lo que el dueño cree ahí —grupos, opciones, plantillas, estrategias de precio— sale en su mini app **sin tocar código**: esa es la promesa entera del motor. El saneamiento de la ruta replica los CHECK de la base a propósito, para que el dueño lea «el máximo tiene que ser 1» en vez de un error de restricción de PostgreSQL. Verificado de punta a punta: crear un grupo obligatorio en el panel y verlo aparecer en `/api/store/:slug/catalog`.
- **Un doble toque no crea dos pedidos:** la mini app genera una clave POR CARRITO (`orders.idempotency_key`, única por negocio) y la repite si reintenta; `create_storefront_order` devuelve el pedido existente con `repetido: true` en vez de crear otro. Sin clave el comportamiento es el de siempre —cada envío, un pedido—, que es como pide el bot. Cada cambio de estado deja rastro en `order_events` (de dónde venía y a dónde fue): sin él, «¿cuándo se confirmó?» solo se responde mirando `updated_at`, que se pisa con cada cambio. Los estados son **doce y en español**: a los siete de siempre se suman `esperando_pago`, `pago_en_revision`, `aceptado`, `listo_para_retiro` y `rechazado`. `completado`, `cancelado`, `rechazado` y `expirado` son finales — de ahí no se sale, así que «cancelado → preparacion» queda fuera por no estar listado. ⚠️ El CHECK que MANDA es el `alter table` de más abajo en `schema.sql`, no el del `create table`: añadir un estado solo arriba lo deja fuera igualmente — lo vigila `tests/estados-pedido.test.js`, que además exige que el panel del dueño conozca **exactamente** los mismos estados que la base. Separarlos no rompe de golpe, rompe a medias: un estado que la base guarda y el panel no conoce deja al dueño con un hueco sin etiqueta ni botón para mover ese pedido.
- **Complemento incluido ≠ adicional independiente:** la bebida de un combo forma parte del producto y vive en `order_item_options`, DENTRO de su línea; el pan de ajo que se suma al final es OTRO producto y va como línea propia del carrito (`product_recommendations`). Confundirlos hace que el dueño vea «Pizza (con pan de ajo)» en vez de dos cosas que preparar, y que el reporte cuente una unidad donde hay dos. Un adicional cuelga de un producto, de una categoría o **de nada** (recomendaciones del negocio para el carrito) — aquí «de nada» sí es legítimo, al revés que en `option_groups`. Si el producto ofrecido trae grupos obligatorios, tocar «+» abre su ficha en vez de agregarlo a ciegas: la base lo exigiría igual.
- **El pago puede llegar por fuera de la app.** La mayoría transfiere desde su banco y manda la captura **por WhatsApp**, a veces desde la cuenta de un familiar. `orders.payment_confirmed_at` anota que el negocio dio ese pago por bueno; **no es un estado** —no dice dónde está el pedido, dice algo que le pasó— y por eso un pedido puede estar cobrado y todavía sin empezar. Lo marca la **ruta** por dos caminos (aceptar el pedido, o «Marcar pago recibido»), nunca las funciones del dinero: recrearlas por una fecha no compensa. Las condiciones van en el `where` de la consulta —negocio, transferencia, estado no final y **no marcado ya**—, así es una sola operación atómica y dos toques no mueven la hora. ⚠️ **El botón de aceptar sin comprobante NO se bloquea**: un dueño con el dinero en su cuenta y la foto en el chat no puede quedarse mirando un botón gris. Lo que cambia es que el botón no miente.
- **Un solo mensaje saliente por pedido** (`services/order-notify.ts`): al aceptarlo, el cliente recibe su número, lo que pidió y el total. ⚠️ Desde el **1 de octubre de 2026** Meta cobra cada mensaje de servicio, así que avisar en cada estado triplicaría el costo por pedido para repetir lo que ya está en el seguimiento. ⚠️ **La ventana de 24 h no desaparece** —solo deja de ser gratis—: fuera de ella sigue haciendo falta plantilla aprobada, y YCloud hoy solo manda texto. Sale **sin await** y **nunca lanza**: el pedido ya está en la cocina, y un fallo va al registro de errores en vez de decirle al dueño que no arrancó. ⚠️ El aviso se **reclama** (`orders.customer_notified_at` dentro del propio `update`), no se consulta antes: `set_order_status` responde `updated` aunque el estado ya fuera ese, así que sin el reclamo un doble toque manda —y cobra— dos mensajes.
- **El comprobante NO es público:** un movimiento bancario con el nombre y la cuenta de un cliente no puede vivir en una URL permanente. Se sube a Cloudinary como `authenticated` (`uploadPrivateMedia`) y solo se ve con una firma temporal de 10 minutos (`signedMediaUrl`), que el servidor genera al tocar el enlace —no al pintar la lista— y solo para el dueño del negocio del pedido. Si la firma falla se responde 503: **nunca** se cae de vuelta a la URL pública. Los comprobantes subidos antes de esto no tienen `payment_proof_public_id` y se siguen viendo tal cual, avisando `firmada: false` — romperles el acceso escondería el pago de un pedido en curso, que es peor que una fuga que ya ocurrió. Subir el comprobante mueve el pedido a `pago_en_revision` y lo anota en `order_events`: antes se quedaba en «pendiente» con una imagen colgada y nada avisaba al dueño.
- **El horario puede CRUZAR LA MEDIANOCHE.** «09:00 a 01:00» es el horario normal de media hostelería: se abre por la mañana y se cierra a la una de la madrugada siguiente. Comparando `abre <= ahora < cierra` a secas, esos negocios salían **cerrados las 24 horas** —la condición no se cumple nunca cuando el cierre es un número menor que la apertura—, así que el bot respondía «estamos fuera de horario» siempre y la tienda no dejaba pedir a nadie. Lo arregla `dentroDelTramo` en `services/schedule.ts`, que además mira el turno de la VÍSPERA: a las 00:30 de un jueves, quien sigue abierto es el turno del miércoles. ⚠️ El cruce es con cierre **estrictamente menor** que la apertura: «00:00 a 00:00» es un tramo de duración cero —ese día no se abre—, y tratarlo como cruce lo volvería un negocio abierto siempre.
- **Cuánto tarda el negocio:** `businesses.prep_time_minutes` (listo) y `businesses.delivery_extra_minutes` (llevarlo) los pone **el dueño**; el tipo solo recomienda el valor de arranque (`prepTimeForBusinessType`: heladería 10, pizzería 25, asadero 40), igual que las plantillas y las capacidades — y **jamás pisa a un negocio existente**. ⚠️ No es un texto de portada: `prep_time_minutes` decide **desde qué hora se puede programar**, y por eso la lista de franjas y su validación salen de la MISMA función (`prepOptions` en `storefront.routes.ts`). Estaba fijo en 30 para todos; separar los dos usos deja que la validación acepte horas que la lista no ofrecía. Las **barberías no usan nada de esto**: su tiempo ya va por `products.duration_minutes` y `business_schedule.slot_duration`.
- **Pedidos programados: RETIRADOS el 2026-08-07.** El «¿Para cuándo?» del checkout, `scheduleSlots` e `isValidSlot` se eliminaron por decisión del dueño — no están en el diagrama de referencia. **Consecuencia deliberada: con el local `cerrada` ya NO se puede pedir**, ni siquiera para más tarde; la tienda solo acepta pedidos inmediatos. La columna `orders.scheduled_for` y el parámetro `p_scheduled_for` de `create_storefront_order` siguen en la base (la ruta manda `null`): quitarlos obligaría a recrear la función del dinero por un campo que ya nadie llena. Si algún día vuelven, el motor está en el historial del PR #177.
- **Arranque seguro:** `server/src/config/environment.ts` valida antes de abrir el puerto las credenciales críticas, `BASE_URL`, el fallback opcional `YCLOUD_WEBHOOK_SECRET` si existe y el secreto Telegram cuando aplica. El signing secret de YCloud se guarda preferentemente por negocio y valida la cabecera `YCloud-Signature`. Producción falla cerrado en vez de publicar un healthcheck verde con configuración incompleta.
- **Contraseñas nuevas:** superadmin, dueños y empleados usan un mínimo de 12 caracteres; siempre se almacenan con bcrypt y nunca se devuelven en APIs.
- **Sesiones cliente vigentes:** `activeClientGuard` revalida cada 15 segundos como máximo que usuario y negocio sigan activos, y reemplaza rol/permisos del JWT por los valores actuales de la base. Eliminar un usuario, suspender un negocio o revocar permisos falla cerrado sin esperar siete días.
- **Túnel local (`server/src/services/tunnel.ts`):** solo se usa en desarrollo; inicia y detiene `cloudflared` mediante dependencias inyectables, expone únicamente estado serializable (`url`, `active`, `provider`, `startedAt`) y nunca filtra el proceso hijo en respuestas administrativas. En producción la URL pública sale de `BASE_URL`.
- **Grafo interno del servidor:** los módulos bajo `server/src/` se enlazan directamente entre `db`, `services`, `integrations`, `middleware` y `routes`; comandos, pruebas y Railway ejecutan el resultado compilado en `server/dist/`.
- **Nombres:** `camelCase` en TypeScript/JavaScript; columnas y tablas en `snake_case`.


### Piezas con razonamiento largo — léelo ANTES de tocarlas

Cada una existe porque algo falló. Lo que parece complejidad de más suele ser una cicatriz:

- **Etiquetas del bot** → [DECISIONES.md](DECISIONES.md#etiquetas-del-bot)
- **Modo menú estilo banco** → [DECISIONES.md](DECISIONES.md#modo-menú-estilo-banco)
- **Reportes del dueño** → [DECISIONES.md](DECISIONES.md#reportes-del-dueño)
- **Capacidad de citas y hospedaje** → [DECISIONES.md](DECISIONES.md#capacidad-de-citas-y-hospedaje)
- **Salud del canal** → [DECISIONES.md](DECISIONES.md#salud-del-canal)
- **Evals del bot** → [DECISIONES.md](DECISIONES.md#evals-del-bot)
- **Vigilante de precios** → [DECISIONES.md](DECISIONES.md#vigilante-de-precios)
- **Vigilancia de credenciales** → [DECISIONES.md](DECISIONES.md#vigilancia-de-credenciales)
- **Registro de errores** → [DECISIONES.md](DECISIONES.md#registro-de-errores)
- **Mini app de la tienda** → [DECISIONES.md](DECISIONES.md#mini-app-de-la-tienda)
- **El horario del dueño manda sobre todos los modos** → [DECISIONES.md](DECISIONES.md#el-horario-del-dueño-manda-sobre-todos-los-modos)
- **Cortar un flujo (modos, atajos, `return` temprano)** → [cambios-seguros](.claude/skills/cambios-seguros/SKILL.md#cortar-un-flujo-el-inventario-de-lo-que-hacía-de-paso)
---

## 8. HIGIENE DE GIT

- **Commits pequeños y descriptivos**, en español (ej: "fix: monto mensual no se guardaba al editar cliente").
- **Punto limpio antes de un cambio grande**: confirma que el árbol está estable o haz commit de lo pendiente primero.
- **NUNCA** `git reset --hard`, `git clean -fd`, ni borrar ramas sin **confirmación explícita** del usuario.
- **NUNCA** subir `server/.env` (ya está en `.gitignore`). Si una credencial entra al diff, deténte y avisa.
- Trabaja en rama si el cambio es grande; no commitees en `main` sin pedirlo.

---

## 9. IDIOMA

- **Responde al usuario en español** (mercado Ecuador/Colombia).
- **Textos del bot y de los paneles en español neutro.**
- Código, nombres de variables y claves técnicas en inglés/snake_case según el patrón existente; comentarios en español.

---

## 10. MAPA DE SKILLS

Ante cualquier pedido, identifica la situación y consulta la(s) skill(s) correspondiente(s) en `.claude/skills/`. Varias pueden aplicar a la vez.

| Situación / pedido | Skill a consultar |
|--------------------|-------------------|
| Tocar BD, RLS, auth, esquema, multi-tenancy o etiquetas/tools del bot | **arquitecto-saas** (primero) |
| Modificar algo existente, pedido amplio o ambiguo, "mejora esto/todo" | **cambios-seguros** |
| Después de CUALQUIER cambio, verificar que nada se rompió | **tester-saas** |
| Tocar auth, secretos, encriptación, webhooks, endpoints públicos, datos sensibles | **seguridad-saas** |
| Crear/modificar migraciones, tablas, índices, columnas o políticas RLS | **base-de-datos** |
| Antes de commit o de abrir un PR: revisar el diff completo | **revisor-pr** |
| Versionar: ramas, commits, push, PRs, merges (el "cómo" de Git/GitHub) | **git-github** |
| Sacar un cambio a producción: migraciones, despliegue, humo, salud del canal | **ship** |
| Hay un error, bug o comportamiento inesperado | **debugging** |
| Crear feature/endpoint/etiqueta nueva o cambiar comportamiento que otros consumen | **documentacion** |
| Crear o editar el system prompt de un bot de cliente (perfumería, barbería, clínica…) | **prompts-de-bots** |
| Crear o modificar gráficos, dashboards, KPIs o visualizaciones en el panel | **graficos-dashboard** (usa la bundled **dataviz**) |
| Crear, migrar o revisar pantallas React y componentes del sistema visual | **shadcn-ui** |

**Combinaciones frecuentes:**
- "Agrega una tabla/campo nuevo" → base-de-datos + arquitecto-saas + tester-saas + documentacion.
- "Cambia el login / cómo se guardan las keys" → seguridad-saas + arquitecto-saas + tester-saas.
- "El bot responde mal / no agenda / no detecta venta" → debugging + (prompts-de-bots si es del prompt) + tester-saas.
- "Revisa esto antes de subirlo" → revisor-pr.

---

## 11. MÓDULOS FUTUROS (no construir hasta que haya demanda real)

> 📋 **La lista completa de módulos futuros —con lo que habría que definir antes de construir cada uno— está en [PENDIENTE.md](PENDIENTE.md).** No construir nada de ahí sin señal de un cliente real.

> **Estado del producto (nota estratégica):** el sistema está **listo para vender/demo**. La construcción de features está **en pausa a propósito** — el siguiente paso es **operativo**, no de código: demo → cambiar número a **Meta** (hoy YCloud) → **deploy 24/7 en servidor real** (hoy corre local + túnel). Campañas y recordatorios (los dos únicos que envían mensajes salientes) van **después** de eso. No construir más módulos de forma especulativa; esperar señal de un cliente/piloto real.
> **Escalabilidad (nota de arquitectura, a futuro):** hoy es un **monolito** (un solo servidor Node + Express). Es lo **correcto para la etapa actual** (primeros clientes) — simple, barato, fácil de operar. NO refactorizar de forma especulativa. Cuando haya **demanda real de escala** (muchos negocios/mensajes concurrentes), recién ahí evaluar: **Realtime/WebSockets** (empujar cambios al panel en vez de que pregunte cada X segundos — ataca de raíz el egress del polling), **caché (Redis)** (datos muy leídos en memoria, sin golpear la base), **colas** (procesar mensajes/IA sin bloquear), **workers** separados (envíos, embeddings, reportes pesados, transcodificar media), varias instancias + balanceador, réplicas de lectura, y quizás separar el bot del panel. Antes de todo eso, el paso barato es **Supabase Pro ($25/mes)** para subir los límites. Es un "problema de éxito": se aborda cuando el volumen lo justifique, no antes.