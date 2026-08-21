# CLAUDE.md — BotPanel SaaS

Guía obligatoria para trabajar en este proyecto sin romper la arquitectura ni el trabajo existente. Léela completa antes de actuar.

**Este archivo es lo que hay que tener en la cabeza SIEMPRE.** Lo demás vive
aparte y se consulta cuando la tarea lo toca — así esta guía se puede leer
entera de verdad, que era el problema cuando todo estaba junto:

| Documento | Cuándo leerlo |
|---|---|
| **[DECISIONES.md](DECISIONES.md)** | Antes de tocar la tienda, el registro de errores, la vigilancia del canal… Casi cada apartado existe porque algo falló: lo que parece complejidad de más suele ser una cicatriz. |
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

**BotPanel** es un SaaS **multi-empresa** que ofrece bots de atención al cliente con IA en **WhatsApp y Telegram**. Sirve a negocios de comida y retail que reparten a domicilio: cada negocio tiene su propio bot (prompt, catálogo, horarios), su mini app, su panel de cliente, y un panel de administración central (el dueño del SaaS) gestiona todos los negocios, sus credenciales y la facturación. El bot responde texto, voz e imágenes, vende, y deriva a un humano cuando hace falta.

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
│   ├── src/db/repositories/schedule.ts # Horario de atención del negocio (lo usa la tienda)
│   ├── src/db/repositories/sales.ts # Ventas y detalles mediante RPC atómica
│   ├── src/db/repositories/reporting.ts # Consultas analíticas aisladas por negocio
│   ├── src/db/repositories/orders.ts # Pedidos e ítems mediante RPC atómica
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
│   ├── src/services/bot-tags.ts # Parser puro de pedidos, handoff y media
│   ├── src/services/bot-actions.ts # Acciones tipadas y multi-tenant de sesiones y pedidos
│   ├── src/services/bot-media.ts # Selección estricta y envío tipado de media por negocio
│   ├── src/services/bot-conversation.ts # Flujo central tipado, desde sesión hasta respuesta
│   ├── src/services/bot-entry.ts # Debounce, resolución de negocio y adaptadores WA/TG tipados
│   ├── src/services/business-templates.ts # Con qué catálogo nace cada tipo de negocio (solo recomienda al crear)
│   ├── src/services/pricing.ts # Las 8 estrategias de cobro por grupo (copia en TS de lo que cobra la base)
│   │                            # y `quoteCart` en storefront.ts: el total exacto antes de confirmar, sin crear el pedido
│   ├── src/services/money.ts   # Resolución estricta, centavos, totales y resumen oficial
│   ├── src/services/platform-pricing.ts # Espejo TS del margen para SIMULAR; la base es la que cobra
│   ├── src/db/repositories/pricing-rules.ts # Reglas de margen y acumulado por negocio
│   ├── src/routes/admin-pricing.routes.ts # Reglas, simulador y acumulado (solo superadmin)
│   ├── src/services/channel-health.ts # Vigilancia del canal de entrada: silencio por negocio y fallos del webhook
│   ├── src/services/order-notify.ts # El ÚNICO aviso saliente del pedido: confirmado y en preparación
│   ├── src/services/payment-proof-inbox.ts # El comprobante que llega por el chat se adjunta al pedido
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
│   ├── src/routes/schedule.routes.ts # Horario de atención aislado por JWT
│   ├── src/routes/business-profile.routes.ts # Identidad y políticas seguras
│   ├── src/routes/business-management.routes.ts # Onboarding y equipo seguros
│   ├── src/routes/business.routes.ts # Composición TypeScript del negocio
│   ├── src/routes/products-core.routes.ts # Catálogo y reindexación aislados
│   ├── src/routes/products-media.routes.ts # Upload multipart validado
│   ├── src/routes/products.routes.ts # Composición TypeScript del catálogo
│   ├── src/routes/product-options.routes.ts # CRUD del motor de opciones para el dueño (grupos, opciones, plantillas)
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
│   ├── migration-2026-08-08-avisos-por-estado.sql # Tres hitos avisan y ninguno repite: el reclamo lleva el estado
│   ├── migration-2026-08-10-direccion-del-pedido.sql # El pedido copia su dirección; el pin y los campos del repartidor
│   ├── migration-2026-08-11-orden-de-los-grupos.sql # El pedido congela el orden del dueño; reordenar en una operación
│   ├── migration-2026-08-16-motor-de-margen.sql # Lo que gana la plataforma por pedido: reglas por negocio, tipo o global
│   ├── migration-2026-08-16-resumen-de-margen.sql # Lo acumulado, sumado sobre `sales` (la venta nace al ENTREGAR)
│   ├── migration-2026-08-16-cierre-de-mes.sql # La comisión entra en la factura; idempotente y por conjuntos
│   ├── migration-2026-08-16-margen-casos-limite.sql # El mes acaba en Ecuador, el descuento sale de la base, on_top cerrado
│   ├── migration-2026-08-07-checkout.sql # Instrucciones del pedido y el tercer método de pago
│   ├── migration-2026-08-07-pago-al-retirar-rpc.sql # El método también dentro de la RPC, que valida aparte del CHECK
│   ├── migration-atomicidad-reservas.sql # Lock + exclusión de intervalos activos por negocio
│   ├── migration-2026-08-16-retirar-hospedaje.sql # Umbani solo domicilios: se retira el módulo entero (fase 1)
│   ├── migration-2026-08-16-retirar-citas.sql # Se retira la agenda; el horario se queda porque lo usa la tienda (fase 2)
│   ├── migration-2026-08-19-miniapp-exige-tienda.sql # El modo mini app no se enciende sin pedidos ni tienda
│   ├── migration-2026-08-20-negocio-sin-canal-propio.sql # Un negocio puede existir sin número propio: lo atiende el del marketplace
│   ├── migration-2026-08-20-conversacion-del-marketplace.sql # Dónde está cada cliente: la única tabla sin business_id, y blindada
│   ├── migration-2026-08-21-categorias-del-marketplace.sql # Las 15 categorías del menú y a qué tipo pertenece cada una
│   ├── migration-2026-08-21-busqueda-del-marketplace.sql # «Quiero ceviche» encuentra locales sin pagar una llamada de IA
│   ├── migration-2026-08-21-outbox-de-avisos.sql # El aviso que falla se reintenta en vez de perderse
│   ├── migration-2026-08-20-retirar-tipos-no-delivery.sql # Solo comida y retail: fuera los 21 tipos de hospedaje, servicios y salud
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
- **Los TRES modos de atención se conservan** (`chat_mode`, decisión del dueño 2026-08-19). La reducción de Umbani a domicilios retiró hospedaje y citas, pero **NO** el modo menú ni el modo IA: son las dos formas de atender por chat que el producto mantiene junto a la mini app.
  - `ai` → la IA conversa y el pedido se cierra por chat con `##PEDIDO##`.
  - `menu` → el CÓDIGO conduce con opciones armadas de los datos reales (`bot-menu-flow.ts`); el modelo no participa en ningún mensaje. **No manda enlace**, y no es un olvido: el menú YA es donde se pide.
  - `miniapp` → el bot corta antes de la IA y manda el enlace personal de la tienda.
  ⚠️ `services/chat-mode.ts` (`atiendeSinIA`) agrupa `menu` y `miniapp` para una sola cosa: en ninguno de los dos corre el modelo, así que bajar media, transcribir voz o pasar una foto por visión es dinero tirado. ⚠️ El modo `miniapp` **exige pedidos y tienda encendidos** (`migration-2026-08-19-miniapp-exige-tienda.sql`): sin catálogo el cliente recibiría un enlace a una app vacía.
- **Telegram (`server/src/integrations/telegram.ts`):** el negocio se selecciona/restaura por `slug`; la restauración consulta únicamente el `business_id` más reciente de `tg_<chatId>` mediante la capa `src/db` y luego valida que el negocio siga activo. La integración no crea clientes Supabase propios. Texto, voz y fotos entregan siempre `{ channel:'telegram', ctx, slug }` a `bot-entry.ts`.
- **Dinero (`server/src/services/money.ts`):** calcula importes oficiales y las RPC revalidan negocio, producto, stock y precio. El flujo es manual: la plataforma registra el pedido y su entrega, pero no procesa ni registra el cobro del cliente.
- **Un local nuevo NACE en el marketplace** (2026-08-21). El desplegable del alta arranca en `marketplace`, no en `ycloud`: si naciera en YCloud, el alta pediría credenciales de una cuenta que ese local no va a tener nunca y habría que acordarse de cambiarlo cada vez. ⚠️ Solo afecta al ALTA: al editar se lee el proveedor guardado, así que ningún negocio con canal propio se reescribe. ⚠️ **`owner_phone` pasa a ser obligatorio en el marketplace** —y solo ahí—: es el ÚNICO número que tiene ese local, y es con el que su dueño pide los reportes por WhatsApp (`services/reports.ts` valida que solo ese número puede). Se valida su formato E.164 únicamente para marketplace, porque ningún negocio anterior lo es y así no puede romper la edición de los que ya existen. ⚠️ **Pendiente de la fase 3:** `handleOwnerMessage` se alcanza desde `bot-conversation.ts` DESPUÉS de resolver el negocio por el número al que llegó el mensaje, así que un local de marketplace todavía no recibe las peticiones de reporte por WhatsApp — su dueño los ve en el panel, que es la vía principal.
- **Un negocio puede no tener canal propio** (`whatsapp_provider = 'marketplace'`, 2026-08-20). Es la fase 1 del marketplace centralizado: todos los clientes escriben al MISMO número, el de la plataforma, así que un local ya no necesita el suyo ni cuenta de YCloud ni webhook. Hasta esa fecha la base lo IMPEDÍA, y no con una validación blanda: el disparador `sync_business_channel_identifiers` lanzaba «YCloud requiere un teléfono de canal válido» y abortaba el alta entera. ⚠️ Es **aditivo**: `ycloud`, `meta` y `telegram` no cambian en nada. ⚠️ `businesses_marketplace_sin_canal_check` prohíbe que un negocio de marketplace guarde `whatsapp_number`, `ycloud_number` o `meta_phone_id` — si los tuviera habría dos respuestas a «¿de quién es este número?» y el enrutado dependería de cuál se mirara primero. ⚠️ El número se inserta con `nullif`: la columna es **UNIQUE**, y dos cadenas vacías chocarían con un error que habla de un índice en vez de lo que pasó; el `PUT` normaliza igual, porque convertir un negocio existente no pasa por la RPC. ⚠️ **Todavía no recibe ni envía WhatsApp**: eso necesita el estado de conversación que diga en qué local está cada cliente, porque con un solo número el teléfono ya no puede responderlo. Mientras tanto es un negocio completo por la mini app y por el panel — que es lo que hace falta para cargar catálogos y probar. Enviarle un aviso lanza un error con nombre propio en `integrations/whatsapp.ts` y va al registro de errores como `envio`, sin tumbar el pedido.
- **Buscar sin IA** (`marketplace_buscar_negocios`, 2026-08-21). «Quiero ceviche» encuentra locales aunque «ceviche» no salga en el menú principal, y **sin pagar una llamada de IA**. Tres capas, parando en la primera que responda: **alias** curados por el superadmin, **texto completo** en español, y **parecido** por trigramas. ⚠️ **Las tres hacen falta, y está medido**: el diccionario reduce «ceviche» a `cevich` y «cebiche» a `cebich`, así que **por texto NO casan** — las dos grafías se usan en Ecuador. ⚠️ **El parecido compara palabra por palabra, no la frase entera**: «cebiche» contra «ceviche de camarones» da 0.217 con el nombre completo —bajo el umbral de 0.3, o sea que ese local NO salía— y 0.455 con su mejor palabra. Coste conocido: así no se usa el índice de trigramas, que solo sirve para el nombre completo. ⚠️ **Sin normalizar la frase, «quiero ceviche» encontraba UN local de tres**: el alias no casa con la frase entera y `plainto_tsquery` exige TODAS las palabras, así que buscaba productos que dijeran «quiero» Y «ceviche». `marketplace_normalizar_consulta` filtra palabra por palabra y NO con una regex sobre la frase — una regex `\s(muletilla)\s` consume el espacio que separa y no puede casar dos seguidas («quisiera un cebiche» dejaba «un cebiche»). ⚠️ **Las funciones de pg_trgm se llaman CALIFICADAS** (`extensions.similarity`), igual que el índice (`extensions.gin_trgm_ops`): depender del `search_path` es exactamente el fallo que dejó el canal mudo cinco días en julio de 2026. Hay una prueba que caza cualquier llamada sin calificar. ⚠️ **La búsqueda excluye lo que no puede atender ahora** — encontrar un local suspendido es peor que no encontrar ninguno, porque el cliente ya eligió. ⚠️ Con local elegido el ámbito es ese local (`marketplace_buscar_productos`): traerle la Coca Cola de otro negocio metería en el carrito un producto que no puede estar ahí.
- **El menú del marketplace** (`marketplace_categories`, `services/marketplace-menu.ts`, 2026-08-21). Lo que ve quien escribe al número de Umbani: **categorías → locales → el enlace de la tienda de ese local**. ⚠️ **Termina en el ENLACE a propósito**: la mini app ya sabe hacer productos, opciones, carrito, dirección, pago y seguimiento — rehacerlo en botones de WhatsApp sería una segunda implementación del mismo camino y un cuarto sitio donde el precio puede divergir. El menú solo lleva al cliente hasta la puerta del local correcto. ⚠️ **Las categorías NO son los 31 tipos**: nadie elige entre 31 botones, y «Hamburguesas» junta `hamburguesería` y `comida rápida` porque para quien pide es lo mismo. Un tipo pertenece a **una sola** categoría (`business_type` es la clave primaria del mapeo) o el mismo local saldría dos veces. ⚠️ **Se pagina de NUEVE, no de diez**: una lista de WhatsApp admite diez filas y la última se la lleva «Ver más»; con diez opciones más el botón, la última se perdería sin que nada avisara. ⚠️ **Nunca se ofrece una categoría vacía** — sería una calle sin salida y el cliente ya gastó un mensaje: `marketplace_categories_disponibles()` exige local activo, no suspendido, con pedidos Y con tienda, que son los mismos requisitos del modo mini app porque el menú termina justo ahí. ⚠️ `services/marketplace-menu.ts` es una función **pura**, como `bot-menu-flow.ts`: recibe los datos consultados y devuelve texto y opciones, así se prueba entera sin levantar nada.
- **La conversación del marketplace** (`marketplace_conversations`, 2026-08-20). Con un solo número para toda la plataforma, el teléfono ya no dice de qué negocio es un mensaje: lo dice esta tabla. Sustituye al `Map` en memoria de `bot-menu-flow.ts:465`, que se pierde en cada despliegue y que con dos instancias llevaría dos cuentas del mismo carrito. ⚠️ **Es la ÚNICA tabla sin `business_id`, y es deliberado**: la conversación ABARCA varios negocios — antes de elegir local no hay ninguno, y «¿en qué local está AHORA?» es mutable, así que es un `selected_business_id` anulable, no una llave de tenant. El riesgo que eso abre es concreto —que una pizzería sepa que su cliente pide en la competencia— y se cierra como en `customers` y `business_channel_identifiers`: **quitando el acceso, no partiendo la tabla** (RLS + `revoke all` incluido `service_role` + permiso mínimo). Lo comprueba `verificar-aislamiento.sql`, y comprobé que ese detector **detecta**. ⚠️ **El ámbito de búsqueda se DERIVA** (`selected_business_id is null` ⇒ global), no se guarda: dos campos podrían contradecirse y habría que decidir cuál miente. ⚠️ **Borrar un negocio NO borra la conversación**: un disparador la reinicia antes (`businesses_reset_marketplace_conversations`) — la conversación es del cliente con la plataforma, no del local. Por eso `selected_business_id` es la única foránea a `businesses` sin `on delete cascade`, y la excepción está nombrada por su columna exacta en `migraciones-guardian.test.js`. ⚠️ `advance_marketplace_conversation` lleva la condición de versión **dentro del `update`**: mirarla antes en un `select` aparte deja la carrera abierta entre las dos consultas.
- **Capacidades por negocio:** `businesses.takes_orders` es la fuente de verdad de si el bot cierra pedidos; el tipo solo la recomienda al crear y nunca sobrescribe decisiones manuales ni negocios existentes. En modo informativo se responden precios, descripciones, stock, fotos y videos; solo la intención transaccional explícita deriva y jamás crea pagos o pedidos.
- **Citas: RETIRADAS el 2026-08-16** (`migration-2026-08-16-retirar-citas.sql`), fase 2 de dejar Umbani solo con domicilios. Se fueron la tabla `bookings`, la capacidad `takes_bookings`, la etiqueta `##BOOK##`, la RPC anti-solape `create_booking_if_available`, la conversión de cita en venta y la sección Reservas del panel. ⚠️ **`business_schedule` SE QUEDA**: vivía en el mismo módulo pero no es de citas — decide si la tienda acepta pedidos y si el bot atiende o dice que está cerrado. Por eso el horario se mudó a `routes/schedule.routes.ts` y `db/repositories/schedule.ts` ANTES de borrar el resto. El permiso `citas` pasó a llamarse `horarios`, y la migración lo renombra en `client_users.permissions` para que ningún empleado pierda el acceso en silencio.
- **Hospedaje: RETIRADO el 2026-08-16** (`migration-2026-08-16-retirar-hospedaje.sql`). Es la fase 1 de dejar Umbani solo con domicilios: se fueron las tablas `lodging_*`, la capacidad `lodging_enabled`, las etiquetas `##STAY_QUOTE##`/`##STAY_REQUEST##`, la pantalla del dueño y el flujo de estadía de la mini app. Con ello se fue también `hasActionConflict`, que solo existía para declarar hospedaje incompatible con las demás acciones. ⚠️ La migración se despliega **DESPUÉS** del código, al revés de lo habitual: el código viejo insertaba `lodging_enabled` al crear un negocio, así que soltar la columna antes rompe el alta de clientes. Si algún día vuelve, el módulo entero está en el historial del PR de esta fase.
- **Catálogo de arranque (`server/src/services/business-templates.ts`):** al crear un negocio, su tipo decide con qué categorías y grupos de opciones nace —una hamburguesería trae Hamburguesas, Combos, Acompañantes y Bebidas, con Término, Extras y Retira ingredientes ya cargados. Sigue la misma regla que las capacidades: **solo recomienda al crear**. La RPC `apply_business_template` no toca un negocio que ya tenga una categoría o un producto y devuelve `aplicada: false`, así que jamás pisa decisiones manuales ni negocios existentes. Falla en silencio hacia el registro de errores: la plantilla va después del alta y no puede tumbarla. Los nombres de tipo deben existir en el desplegable del panel (`apps/admin/src/features/clients/business-types.ts`) o la plantilla queda muerta — lo vigila `tests/plantillas-negocio.test.js`.
- **El desplegable solo ofrece comida y retail** (fase 5, 2026-08-20): 31 tipos —24 de comida, 6 de retail y «Otro / negocio genérico»—. Salieron los 21 de hospedaje/turismo, servicios profesionales y salud/belleza, junto con `BusinessMode` (el campo `mode: 'citas'`, muerto desde que se fueron las citas) y `isServiceBiz` del panel del cliente, que renombraba la barra lateral a «Servicios». Las **familias pasaron de cinco a dos**: `hospedaje`, `servicios` y `salud_belleza` se borraron de `business_families`. ⚠️ El orden de la migración no es negociable: `business_type_families.family_code` referencia a `business_families(code)` **on delete restrict**, así que primero los mapeos y después las familias. ⚠️ `businesses.type` es **texto libre** —sin CHECK ni foránea—, por eso ningún negocio existente se rompe: un tipo sin familia cae a la regla global y `calculate_platform_markup` falla ABIERTO. ⚠️ `negocio` sigue en el desplegable pero **a propósito sin familia**: un tipo genérico no puede heredar el margen de una familia que nadie eligió por él.
- **Grupos de opciones:** un grupo cuelga de un **producto** o de una **categoría**, nunca de ambos ni de ninguno (`option_groups_destino_check`). Por categoría es como los 19 sabores los comparten todas las pizzas sin repetirlos, y como una plantilla deja grupos cargados antes de que exista un solo producto. Los dos destinos usan foránea compuesta sobre `(id, business_id)`. La mini app los pinta con tres selectores (`single` radio · `multiple` casillas con tope · `quantity` contador por opción) y bloquea el botón diciendo **qué falta**; `create_storefront_order` lo vuelve a exigir, que es lo único que de verdad manda. **La mini app ya NO usa `menu_modifiers`** — los sigue editando el panel del dueño, así que durante esta etapa hay dos sitios donde se editan opciones.
- **Motor universal de productos:** `products.product_type` (simple·configurable·combo·daily_menu·weighted) NO es un `if` disfrazado — la app nunca pregunta «¿es pizza?», pregunta «¿este producto se arma eligiendo otros?». Un combo de hamburguesas y uno de pizzas recorren el mismo camino. **El importe se calcula POR GRUPO, no opción a opción** — es la única forma de responder «¿cuál es la más cara?». `option_groups.pricing_strategy` decide cómo cobra un grupo: `sum` (lo normal), `highest_selected` (**la pizza mitad y mitad**: media Suprema $10 + media Hawaiana $9 cuesta $10, no $19), `included`, `included_up_to_limit`, `extra_after_limit` con `free_selections`, y `fixed`/`lowest_selected`/`average`. Las **plantillas** (`option_templates` + `option_template_items`) se REFERENCIAN, no se copian: «Sabores de pizza» se define una vez y sirve a la primera pizza, la segunda, la tercera y las dos mitades — añadir un sabor lo añade en los cinco sitios. Prohibido crear columnas rígidas (`pizza_1`, `first_half`, `drink`): todo sale de grupos configurables. **Los combos no son un tipo aparte**: un producto `combo` es uno cuyos grupos tienen opciones con `references_product_id`, y la mini app los pinta como pasos numerados («1 Elige tu pizza», «2 Elige tu bebida») sin que exista ningún `ComboProductPage`. La opción que ES un producto hereda su foto y su descripción, para que el dueño no suba dos veces la misma imagen. **Tres motores calculan lo mismo y solo uno cobra**: `create_storefront_order` (la autoridad, regla #8), `server/src/services/pricing.ts` y `apps/store/src/lib/cart.ts` — la app tiene que pintar lo que se va a cobrar o el cliente se entera del precio real al confirmar. Los tres comparten los mismos ocho casos de prueba a propósito. Dos reglas que no son obvias: `highest_selected` mira el precio UNITARIO (dos medias pizzas son una), y las estrategias con límite descuentan las opciones MÁS CARAS, nunca por orden de clic — si dependiera del clic, dos clientes con lo mismo en el carrito pagarían distinto.
- **El dueño configura, la mini app obedece:** el motor de opciones se administra desde `Catálogo → Personalización` (`apps/client/src/features/catalog/OptionsManager.tsx` sobre `product-options.routes.ts`). Todo lo que el dueño cree ahí —grupos, opciones, plantillas, estrategias de precio— sale en su mini app **sin tocar código**: esa es la promesa entera del motor. El saneamiento de la ruta replica los CHECK de la base a propósito, para que el dueño lea «el máximo tiene que ser 1» en vez de un error de restricción de PostgreSQL. Verificado de punta a punta: crear un grupo obligatorio en el panel y verlo aparecer en `/api/store/:slug/catalog`.
- **Un doble toque no crea dos pedidos:** la mini app genera una clave POR CARRITO (`orders.idempotency_key`, única por negocio) y la repite si reintenta; `create_storefront_order` devuelve el pedido existente con `repetido: true` en vez de crear otro. Sin clave el comportamiento es el de siempre —cada envío, un pedido—, que es como pide el bot. Cada cambio de estado deja rastro en `order_events` (de dónde venía y a dónde fue): sin él, «¿cuándo se confirmó?» solo se responde mirando `updated_at`, que se pisa con cada cambio. Los estados son **doce y en español**: a los siete de siempre se suman `esperando_pago`, `pago_en_revision`, `aceptado`, `listo_para_retiro` y `rechazado`. `completado`, `cancelado`, `rechazado` y `expirado` son finales — de ahí no se sale, así que «cancelado → preparacion» queda fuera por no estar listado. ⚠️ El CHECK que MANDA es el `alter table` de más abajo en `schema.sql`, no el del `create table`: añadir un estado solo arriba lo deja fuera igualmente — lo vigila `tests/estados-pedido.test.js`, que además exige que el panel del dueño conozca **exactamente** los mismos estados que la base. Separarlos no rompe de golpe, rompe a medias: un estado que la base guarda y el panel no conoce deja al dueño con un hueco sin etiqueta ni botón para mover ese pedido.
- **Complemento incluido ≠ adicional independiente:** la bebida de un combo forma parte del producto y vive en `order_item_options`, DENTRO de su línea; el pan de ajo que se suma al final es OTRO producto y va como línea propia del carrito (`product_recommendations`). Confundirlos hace que el dueño vea «Pizza (con pan de ajo)» en vez de dos cosas que preparar, y que el reporte cuente una unidad donde hay dos. Un adicional cuelga de un producto, de una categoría o **de nada** (recomendaciones del negocio para el carrito) — aquí «de nada» sí es legítimo, al revés que en `option_groups`. Si el producto ofrecido trae grupos obligatorios, tocar «+» abre su ficha en vez de agregarlo a ciegas: la base lo exigiría igual.
- **El pago puede llegar por fuera de la app.** La mayoría transfiere desde su banco y manda la captura **por WhatsApp**, a veces desde la cuenta de un familiar. `orders.payment_confirmed_at` anota que el negocio dio ese pago por bueno; **no es un estado** —no dice dónde está el pedido, dice algo que le pasó— y por eso un pedido puede estar cobrado y todavía sin empezar. Lo marca la **ruta** por dos caminos (aceptar el pedido, o «Marcar pago recibido»), nunca las funciones del dinero: recrearlas por una fecha no compensa. Las condiciones van en el `where` de la consulta —negocio, transferencia, estado no final y **no marcado ya**—, así es una sola operación atómica y dos toques no mueven la hora. ⚠️ **El botón de aceptar sin comprobante NO se bloquea**: un dueño con el dinero en su cuenta y la foto en el chat no puede quedarse mirando un botón gris. Lo que cambia es que el botón no miente.
- **El aviso que falla se reintenta** (`outbox_events`, `services/outbox-worker.ts`, 2026-08-21). El aviso se RECLAMA antes de enviarse (`claimOrderNotification` en `orders.routes.ts`), y el reclamo es atómico para que dos toques no manden —ni cobren— dos mensajes. ⚠️ **La consecuencia que no se veía**: si el envío falla —fuera de la ventana de 24 h, sin saldo, canal caído—, el reclamo YA se consumió y ese aviso **no sale nunca más**; el cliente se queda sin saber que su pedido está listo y en el registro solo queda una línea de error. El outbox separa las dos cosas: el reclamo sigue garantizando UN aviso por hito, y la cola garantiza que se INTENTE hasta que salga. ⚠️ **El envío inmediato SE CONSERVA**: si el worker fuera el único camino, el cliente recibiría su aviso segundos tarde siempre y un worker caído dejaría a todos los negocios sin avisar. Se envía ya y solo se reintenta lo que falló. ⚠️ **El evento nace con una ventana de gracia de 60 s** — sin ella el worker podría tomarlo mientras el envío inmediato está en vuelo, y eso sería un segundo mensaje de pago. El envío inmediato cierra su propio evento **sin lease** (`p_token` nulo). ⚠️ **Índice único por hito** (`aggregate_id, event_type, payload->>'status'`): el reclamo ya lo garantiza aguas arriba, pero la base lo cierra por si algún camino futuro encola sin reclamar. ⚠️ El worker **NO reclama nada** —el reclamo se gastó al cambiar el estado, y volver a reclamar impediría el reintento—, y da por MUERTO lo que ya no puede salir (pedido o negocio borrados) en vez de gastar seis intentos. Mismo patrón de leases que `webhook_inbound_events`: código probado, no inventado.
- **Los avisos al cliente** (`services/order-notify.ts`): en `preparacion` (con el detalle de lo pedido, la NOTA del cliente y el total), en `en_camino` o `listo_para_retiro` —el mismo paso contado según quién espere—, en `completado`, que agradece y anuncia Umbani, y desde el 2026-08-13 en `cancelado` y `rechazado`, que se cuentan IGUAL —para el cliente son la misma noticia— y llevan el teléfono del local para llamar. Ese sexto y séptimo hito no multiplican el gasto como los demás: un pedido cancelado no recibe ninguno de los otros, así que es UN mensaje en vez de tres. Y no puede dispararse solo: `cancelado` y `rechazado` únicamente se escriben desde `PUT /api/client/orders/:id/status`, que exige permiso de ventas, y **no hay tarea que expire pedidos** (`expirado` está en las restricciones pero nadie lo escribe) — por eso `expirado` se queda fuera de la lista, para no adelantar una decisión de dinero que podría dispararse sobre cien pedidos de golpe. ⚠️ **Cada hito es un mensaje que se paga**: desde el **1 de octubre de 2026** Meta cobra cada mensaje de servicio. Se empezó con uno solo por eso; el dueño decidió los tres el 2026-08-08. Añadir un hito más multiplica el gasto de todos los negocios del SaaS, así que `HITOS_QUE_SE_AVISAN` tiene su propia prueba. ⚠️ **La ventana de 24 h no desaparece** —solo deja de ser gratis—: fuera de ella sigue haciendo falta plantilla aprobada, y YCloud hoy solo manda texto. Sale **sin await** y **nunca lanza**: el pedido ya está en la cocina, y un fallo va al registro de errores en vez de decirle al dueño que no arrancó. ⚠️ El aviso se **reclama POR HITO** (`orders.customer_notified_status` dentro del propio `update`), no se consulta antes: `set_order_status` responde `updated` aunque el estado ya fuera ese, así que sin el reclamo un doble toque manda —y cobra— dos mensajes; y con una sola marca sin estado, el primer aviso impediría los demás en silencio.
- **Lo que pidió el cliente se cuenta ENTERO y agrupado** (`services/order-detail.ts`). El pedido se enseña en TRES sitios y los tres decían cosas distintas del mismo plato: el panel y la app pintaban `extras_names` plano —«Tradicional · Sin borde · Extra queso · Sin ají · Cheese Burguer»— y el WhatsApp decía «1× Pizza (Personal)» y nada más, sin leer siquiera `extras_names`, que ya venía en la consulta. La lista plana no es solo fea, es **ambigua**: «Sin ají» es un retiro y «Extra queso» un añadido y salían idénticos; «Cheese Burguer» es un sabor de pizza y parecía una hamburguesa aparte. El dato estaba entero desde el principio en `order_item_options`. **Se agrupa en el SERVIDOR y las apps solo pintan** lo que reciben en `options`: son tres superficies y ya derivaron una vez. ⚠️ **El orden lo pone el dueño** (`order_item_options.group_sort`), no el alfabeto: una pizza se piensa por el sabor, no por el borde, y ese es además el orden en que el cliente la armó. Se **copia al crear el pedido** y no se consulta al leerlo porque el panel pide sus pedidos **cada 12 segundos** (`refetchInterval: 12_000`): unirse a `option_groups` ahí correría sin parar durante todo el servicio. El alfabético queda de desempate, y hace falta — los pedidos anteriores y los grupos que nadie ordenó llevan cero. Lo pone `Catálogo → Personalización` con flechas de subir y bajar, sobre `reorder_option_groups`/`reorder_options`, que reordenan la lista ENTERA en una operación: media lista movida es peor que la lista intacta. Consecuencia deliberada: reordenar mañana **no** reescribe la comanda de hoy, igual que cambiar un precio no reescribe lo cobrado. **Y la NOTA del cliente viaja con lo demás desde el 2026-08-12**: es lo único que escribió él con sus palabras —«sin cebolla»— y era lo único que no le volvía. El panel la enseñaba desde el principio; el WhatsApp de confirmación, no, y ese mensaje existe justo para que compruebe que le entendieron bien. Va la última y entre comillas, para que no se confunda con una opción del catálogo. **El resumen de la mini app también pinta lo elegido** (`apps/store/src/lib/resumen.ts`): decía «1× Pizza $16.83» justo después de que el cliente eligiera masa, borde y sabor, y el dato ya estaba en las dos fuentes —el carrito recién enviado y el pedido que devuelve el servidor—. Las dos se normalizan en ese módulo por el mismo motivo que el agrupado vive en el servidor: cuando cada camino arma su versión, empiezan a contar cosas distintas del mismo plato. ⚠️ **El corte a dos líneas es SOLO de la mini app**, donde el cliente ya sabe lo que pidió y puede desplegarlo tocándolo; en el panel del dueño va entero y sin cortar, porque lo lee la cocina y una descripción cortada se prepara mal. En WhatsApp va completo siempre: Meta cobra por mensaje, no por carácter. `extras_names` se queda como respaldo de los pedidos anteriores al motor de opciones.
- **El pedido se queda con la dirección, no con un puntero.** `orders.address_id` es una foránea `on delete set null` y el panel leía la dirección incrustándola por ahí: el pedido no guardaba a dónde iba, **preguntaba a dónde va HOY esa dirección**. Si el cliente la corregía a media entrega, la pantalla cambiaba debajo del repartidor; si la borraba, el pedido se quedaba sin destino. Ahora `create_storefront_order` la **copia** en `orders.delivery_*`, igual que `order_items` congela `product_name` y `unit_price`. `address_id` se queda como puntero —a qué casa pide más un cliente— pero ya no es de donde se lee para repartir. La comprobación de pertenencia (negocio + cliente + activa) es la MISMA de antes; lo único que cambió es que esa consulta además trae los datos. **El pin es opcional a propósito**: `navigator.geolocation` es del navegador —gratis, sin clave— y quien niega el permiso, o abre el enlace dentro de WhatsApp (cuyo navegador incrustado no siempre lo reenvía), tiene que poder pedir igual. Latitud y longitud viajan **juntas o no viajan**: media coordenada apunta al ecuador, y eso es peor que nada porque parece un dato. `accuracy_m` nulo es «no se sabe» y **nunca cero**, que significaría «exacto al centímetro» — el bug que cazó `tests/ubicacion.test.ts` porque `Number(null)` es 0. ⚠️ Sin PostGIS a propósito: el CI aplica `schema.sql` sobre `pgvector/pgvector:pg16`, que no lo trae, y no hay imagen oficial con ambos. Como lat/lng son la fuente de verdad, el día que la app de repartidor pida polígonos de zona se les cuelga encima una columna `geography` generada sin tocar un dato.
- **El mismo teléfono vive con y sin el `+`.** Un pedido de la mini app guarda `593990978367` —el CHECK de la sesión exige solo dígitos— y el MISMO cliente escribiendo por WhatsApp llega como `+593990978367`. Buscar con `=` no encuentra nada **y no falla**: devuelve vacío, que es peor porque parece que ese cliente nunca pidió. Por eso `getLastOrderForContact` busca con `in` sobre `variantesDelTelefono`. ⚠️ Y al ESCRIBIR se devuelve el teléfono que la base tiene guardado, no el que llegó por el canal: `attach_storefront_payment_proof` compara `contact_phone = btrim(...)`, exacto. ⚠️ Esto **no toca el envío**: `ycloud.sendText` pasa el número tal cual y no pasa por aquí — los avisos ya salían con el número sin `+` y llegaban.
- **Quien escribe por molestar tiene dos frenos, y son distintos a propósito** (2026-08-13). Desde que el enlace sale SIEMPRE, cada mensaje recibe una respuesta — y desde el 1 de octubre cada respuesta se paga. **El TECHO es automático y temporal**: a partir de la 5ª respuesta en una hora, el MISMO mensaje añade el teléfono del local (coste cero: es una línea más, no un mensaje más), y pasada la 10ª el bot calla **24 h**. ⚠️ El silencio NO se levanta a la hora siguiente: con una ventana que se reinicia sola, quien molesta con paciencia pagaría el techo entero cada hora — diez por hora son doscientos cuarenta al día. **El BLOQUEO lo pone el dueño** desde `Conversaciones` (`business_customers.blocked_at`), no caduca y es **total**: el bot calla en TODOS los modos y `POST /api/store/:slug/orders` lo rechaza con 403 aunque tenga su enlace guardado — si solo callara al bot, el bloqueo no bloquearía nada. ⚠️ **Al bloqueado NUNCA se le avisa**: quien escribe para molestar busca una reacción, y avisar cuesta justo el mensaje que se está ahorrando. ⚠️ El mensaje **se guarda igual** en los dos casos y la conversación se marca no leída: callar no es dejar de ver, y el dueño necesita leer para decidir. ⚠️ Ante un fallo de la base se **atiende**: quedarse mudo por un problema nuestro deja sin servicio a un cliente de verdad, mientras que equivocarse al revés cuesta un mensaje. Y el comprobante se contesta **aunque esté silenciado** — quien acaba de pagar no es quien molesta. El contador vive en la fila del cliente (`claim_miniapp_reply`, atómica), nunca en memoria: un `Map` se pierde al desplegar y con dos instancias cada una lleva su cuenta. ⚠️ Y es **idempotente por id de mensaje**: la entrada es *at-least-once* —si la confirmación a PostgreSQL no llega, el worker reintenta y el mensaje se procesa otra vez—, así que sin eso cinco reintentos dejaban silenciado 24 h a un cliente legítimo. Sin id se cuenta igual: contar de más es menos malo que no contar. ⚠️ **El corte va ANTES de crear el enlace y de marcar leído**: crear el enlace abre una sesión de tienda con su token, así que un silenciado seguía llenando la tabla que el techo existe para vaciar, y el doble check azul le daba justo la reacción que busca. ⚠️ **Bloquear apaga también el modo manual**, que se comprueba antes que el bloqueo: sin eso, un bloqueado en modo manual volvía a encender `unread_owner` con cada mensaje y la alarma sonaba por alguien recién bloqueado. ⚠️ **Telegram NO se puede bloquear todavía** y la ruta lo rechaza: `resolveCustomer` guarda por dígitos, así que un `tg_123` acabaría bloqueando al cliente de WhatsApp `123`. Por lo mismo, el panel compara **teléfonos normalizados** (`+593…` en la conversación contra `593…` en la ficha) — sin eso un bloqueado volvía a salir como «Bot activo» al recargar. ⚠️ **El cinturón está en la BASE**: el trigger `orders_reject_blocked` rechaza un pedido de un bloqueado dentro de la misma transacción que la inserción, así que cierra la carrera con el botón del dueño y no falla abierto como la comprobación de la ruta. Se hizo con un trigger y **no recreando `create_storefront_order`** a propósito: la regla de no tocar la función del dinero por añadidos pequeños sigue en pie, y así queda cubierto cualquier camino futuro. Acotado a `source = 'storefront'` — un pedido de **mostrador** lo teclea el dueño con la persona delante, y bloquear significa «no me escribas ni me pidas por la app», no «no me compres nunca». ⚠️ Y un bloqueado **no gasta**: `inbound-webhook.ts` corta antes de descargar la media, de Whisper y de visión, que son las llamadas más caras del sistema; el mensaje se entrega igual como `[foto]`/`[nota de voz]` para que el dueño lo lea.
- **El comprobante llega por el CHAT, y esa es ya la única puerta** (`services/payment-proof-inbox.ts`). Hasta el 2026-08-12 había dos —subirlo en la mini app o mandarlo por WhatsApp— y se retiró la de la app: eran dos caminos para lo mismo y el de la app era el que casi nadie tomaba, porque la captura del banco queda en la galería del teléfono, a un toque del chat donde llegó el enlace. Quitarla no perdió nada porque el buzón hace exactamente lo mismo: misma RPC, mismo estado, misma alarma. ⚠️ **Se acepta un hueco conocido**: si el cliente manda la foto desde un WhatsApp DISTINTO al que hizo el pedido, el buzón no lo encuentra —busca por el teléfono de quien envía— y el dueño lo resuelve con «Solo confirmar el pago». La ruta `POST /api/store/:slug/orders/:id/proof` sigue viva y protegida en el servidor, sin llamador desde la app. ⚠️ **En modo mini app la foto NO pasa por `handleImage`**: el atajo de `inbound-webhook.ts` manda un `[foto]` de texto sin descargar nada, para no pagar tráfico ni visión por una imagen que no se iba a mirar. Enganchar el buzón solo en `handleImage` no se disparó nunca en producción — se descubrió probándolo, con el cliente recibiendo «usa el enlace» después de pagar. El enganche bueno está en ese atajo, y el ahorro se conserva: se pregunta a la BASE si hay un pedido esperando comprobante *antes* de bajar los 5 MB. La mayoría transfiere desde su banco y manda la captura **por el chat**, no por la mini app; esa foto se perdía para el pedido —el dueño la veía en su WhatsApp, el panel nunca activaba «Ver comprobante» y el cliente se quedaba atascado en la pantalla de pago—. Ahora, si quien manda una imagen tiene un pedido en `esperando_pago` sin comprobante, se sube por la MISMA vía privada y se adjunta con la MISMA RPC: mismo estado `pago_en_revision`, misma alarma, misma firma temporal. ⚠️ **Solo si hay un pedido esperando pago**: sin eso no se toca Cloudinary, y el negocio no paga almacenamiento por cada foto que le manden. ⚠️ **Nunca lanza**: corre dentro del camino de un mensaje entrante, así que un fallo va al registro y el cliente recibe su respuesta igual. ⚠️ Si la foto no era un comprobante no pasa nada malo — el pedido queda `pago_en_revision`, que es justo el estado en el que una PERSONA lo mira antes de aceptar. Y el bot deja de responder con el enlace del menú a quien acaba de pagar, que era lo que hacía.
- **Una foto borrosa no cuesta una venta** (2026-08-15). Rechazar el comprobante CIERRA el pedido —`rechazado` es final y desde el 2026-08-13 al cliente le llega «tu pedido fue cancelado»—, así que el botón que decía «para que mande otro» prometía lo que el sistema no podía dar. `request_new_payment_proof` devuelve el pedido a `esperando_pago` y **borra el comprobante anterior**: las dos cosas van juntas porque el buzón de WhatsApp solo adjunta cuando no hay una foto ya puesta, así que sin borrarla el dueño se quedaría mirando la borrosa para siempre. Suelta también `payment_confirmed_at` y `customer_notified_status`. ⚠️ **No recrea `set_order_status`**, por lo mismo que el bloqueo no recreó `create_storefront_order`: es una acción con nombre propio, no un cambio de estado. ⚠️ **No manda ningún WhatsApp** — el pedido vuelve a esperar pago, así que al cliente le reaparece solo el aviso en la tienda; avisar automáticamente sería un hito más que se paga en todos los negocios del SaaS.
- **Los dos botones del pago NO hacen lo mismo.** «Solo confirmar el pago» anota `payment_confirmed_at` y **no mueve el pedido ni avisa al cliente**; «Aceptar el pago y preparar» anota el pago, arranca la cocina **y manda el WhatsApp**. El primero existe para el rato en que el dueño ya vio la transferencia pero no va a encender la cocina —y desde el 2026-08-11 hace algo más importante: es lo ÚNICO que libera al cliente de la pantalla de pago cuando mandó el comprobante por WhatsApp. Se llaman así porque con «Marcar pago recibido» el dueño no distinguía uno de otro.
- **El comprobante NO es público:** un movimiento bancario con el nombre y la cuenta de un cliente no puede vivir en una URL permanente. Se sube a Cloudinary como `authenticated` (`uploadPrivateMedia`) y solo se ve con una firma temporal de 10 minutos (`signedMediaUrl`), que el servidor genera al tocar el enlace —no al pintar la lista— y solo para el dueño del negocio del pedido. Si la firma falla se responde 503: **nunca** se cae de vuelta a la URL pública. Los comprobantes subidos antes de esto no tienen `payment_proof_public_id` y se siguen viendo tal cual, avisando `firmada: false` — romperles el acceso escondería el pago de un pedido en curso, que es peor que una fuga que ya ocurrió. Subir el comprobante mueve el pedido a `pago_en_revision` y lo anota en `order_events`: antes se quedaba en «pendiente» con una imagen colgada y nada avisaba al dueño.
- **El horario puede CRUZAR LA MEDIANOCHE.** «09:00 a 01:00» es el horario normal de media hostelería: se abre por la mañana y se cierra a la una de la madrugada siguiente. Comparando `abre <= ahora < cierra` a secas, esos negocios salían **cerrados las 24 horas** —la condición no se cumple nunca cuando el cierre es un número menor que la apertura—, así que el bot respondía «estamos fuera de horario» siempre y la tienda no dejaba pedir a nadie. Lo arregla `dentroDelTramo` en `services/schedule.ts`, que además mira el turno de la VÍSPERA: a las 00:30 de un jueves, quien sigue abierto es el turno del miércoles. ⚠️ El cruce es con cierre **estrictamente menor** que la apertura: «00:00 a 00:00» es un tramo de duración cero —ese día no se abre—, y tratarlo como cruce lo volvería un negocio abierto siempre.
- **Cuánto tarda el negocio:** `businesses.prep_time_minutes` (listo) y `businesses.delivery_extra_minutes` (llevarlo) los pone **el dueño**; el tipo solo recomienda el valor de arranque (`prepTimeForBusinessType`: heladería 10, pizzería 25, asadero 40), igual que las plantillas y las capacidades — y **jamás pisa a un negocio existente**. ⚠️ No es un texto de portada: `prep_time_minutes` decide **desde qué hora se puede programar**, y por eso la lista de franjas y su validación salen de la MISMA función (`prepOptions` en `storefront.routes.ts`). Estaba fijo en 30 para todos; separar los dos usos deja que la validación acepte horas que la lista no ofrecía.
- **Pedidos programados: RETIRADOS el 2026-08-07.** El «¿Para cuándo?» del checkout, `scheduleSlots` e `isValidSlot` se eliminaron por decisión del dueño — no están en el diagrama de referencia. **Consecuencia deliberada: con el local `cerrada` ya NO se puede pedir**, ni siquiera para más tarde; la tienda solo acepta pedidos inmediatos. La columna `orders.scheduled_for` y el parámetro `p_scheduled_for` de `create_storefront_order` siguen en la base (la ruta manda `null`): quitarlos obligaría a recrear la función del dinero por un campo que ya nadie llena. Si algún día vuelven, el motor está en el historial del PR #177.
- **Lo que gana la plataforma (`pricing_rules` + `calculate_platform_markup`):** hasta 2026-08-16 el SaaS solo cobraba la cuota mensual y un pedido no le dejaba nada. El margen es una TABLA y no un porcentaje porque **un restaurante y un supermercado no se pueden cobrar igual**: el segundo trabaja al 2–5 %, así que el 8 % de una canasta de $80 le costaría más de lo que gana. De ahí los tres frenos, y cada uno protege a alguien distinto — `max_amount` (techo) al comercio de volumen, `min_amount` (piso) a **nosotros** (cada pedido cuesta mensajes de WhatsApp y llamadas de IA: sin piso, los pequeños se atienden a pérdida) y `tiered` lo que no alcanzan los otros dos. La prioridad es negocio → tipo → global. ⚠️ **No se recrean `create_storefront_order` ni `set_order_status`**: lo sella el disparador `orders_stamp_pricing`, mismo criterio que `orders_reject_blocked`, y así cubre tienda, bot y mostrador de una vez. **Falla ABIERTO**: sin regla aplicable el margen es 0 y el pedido sigue — un problema de configuración de precios no puede dejar a una pizzería sin vender. El pedido **congela qué regla y qué versión** le aplicaron, así que subir el porcentaje mañana no reescribe lo de hoy. La base del cálculo es `subtotal − discount`: cobrar sobre un descuento sería cobrar sobre dinero que el comercio no recibió. ⚠️ `markup_mode` admite hoy **solo `absorbed`**; `on_top` está escrito y probado en `platform-pricing.ts` pero el CHECK lo impide hasta que el catálogo, el carrito y el resumen pinten el precio con margen — si no, el cliente descubriría el precio real al confirmar. Igual que `scope`, que aún no admite `category` ni `product`: **no se puede guardar una regla que el motor no vaya a honrar**.
- **El acumulado y el cierre de mes (`platform_markup_summary`, `settle_month_commission`):** se suma sobre **`sales` y no sobre `orders`** — un pedido aceptado todavía no es dinero, la venta nace al ENTREGAR. De ahí salen dos cosas gratis: un pedido cancelado nunca llega a `sales` y no genera comisión, y una venta anulada deja de contar. ⚠️ **El mes termina en Ecuador, no en UTC**: `sold_at` es `timestamptz` y sin `at time zone 'America/Guayaquil'` una venta de las 20:00 del día 31 se facturaba en el mes siguiente — son las cinco últimas horas de cada día, la franja de más ventas. El cierre corre solo a diario (mes actual y anterior), es **idempotente porque RECALCULA y escribe el valor absoluto**, y **nunca reescribe un mes ya `paid`**: si una venta se anula después de liquidar, se descuenta del siguiente. `billing.amount` sigue siendo la CUOTA; la comisión va en `commission_amount` y el total es la suma. ⚠️ Pensado para muchos negocios: es **una operación por conjuntos, no un bucle** —con 5.000 locales un bucle son 5.000 idas y vueltas— y `idx_sales_cierre` existe porque el índice anterior empieza por `business_id` y no sirve para un rango de fechas global.
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
- **Salud del canal** → [DECISIONES.md](DECISIONES.md#salud-del-canal)
- **Evals del bot** → [DECISIONES.md](DECISIONES.md#evals-del-bot)
- **Vigilante de precios** → [DECISIONES.md](DECISIONES.md#vigilante-de-precios)
- **Vigilancia de credenciales** → [DECISIONES.md](DECISIONES.md#vigilancia-de-credenciales)
- **Registro de errores** → [DECISIONES.md](DECISIONES.md#registro-de-errores)
- **Mini app de la tienda** → [DECISIONES.md](DECISIONES.md#mini-app-de-la-tienda)
- **El horario del dueño manda sobre todos los modos** → [DECISIONES.md](DECISIONES.md#el-horario-del-dueño-manda-sobre-todos-los-modos)
- **Lo que gana la plataforma (motor de margen)** → [DECISIONES.md](DECISIONES.md#lo-que-gana-la-plataforma)
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
| Crear o editar el system prompt de un bot de cliente (pizzería, perfumería, supermercado…) | **prompts-de-bots** |
| Crear o modificar gráficos, dashboards, KPIs o visualizaciones en el panel | **graficos-dashboard** (usa la bundled **dataviz**) |
| Crear, migrar o revisar pantallas React y componentes del sistema visual | **shadcn-ui** |

**Combinaciones frecuentes:**
- "Agrega una tabla/campo nuevo" → base-de-datos + arquitecto-saas + tester-saas + documentacion.
- "Cambia el login / cómo se guardan las keys" → seguridad-saas + arquitecto-saas + tester-saas.
- "El bot responde mal / no detecta venta" → debugging + (prompts-de-bots si es del prompt) + tester-saas.
- "Revisa esto antes de subirlo" → revisor-pr.

---

## 11. MÓDULOS FUTUROS (no construir hasta que haya demanda real)

> 📋 **La lista completa de módulos futuros —con lo que habría que definir antes de construir cada uno— está en [PENDIENTE.md](PENDIENTE.md).** No construir nada de ahí sin señal de un cliente real.

> **Estado del producto (nota estratégica):** el sistema está **listo para vender/demo**. La construcción de features está **en pausa a propósito** — el siguiente paso es **operativo**, no de código: demo → cambiar número a **Meta** (hoy YCloud) → **deploy 24/7 en servidor real** (hoy corre local + túnel). Campañas y recordatorios (los dos únicos que envían mensajes salientes) van **después** de eso. No construir más módulos de forma especulativa; esperar señal de un cliente/piloto real.
> **Escalabilidad (nota de arquitectura, a futuro):** hoy es un **monolito** (un solo servidor Node + Express). Es lo **correcto para la etapa actual** (primeros clientes) — simple, barato, fácil de operar. NO refactorizar de forma especulativa. Cuando haya **demanda real de escala** (muchos negocios/mensajes concurrentes), recién ahí evaluar: **Realtime/WebSockets** (empujar cambios al panel en vez de que pregunte cada X segundos — ataca de raíz el egress del polling), **caché (Redis)** (datos muy leídos en memoria, sin golpear la base), **colas** (procesar mensajes/IA sin bloquear), **workers** separados (envíos, embeddings, reportes pesados, transcodificar media), varias instancias + balanceador, réplicas de lectura, y quizás separar el bot del panel. Antes de todo eso, el paso barato es **Supabase Pro ($25/mes)** para subir los límites. Es un "problema de éxito": se aborda cuando el volumen lo justifique, no antes.
