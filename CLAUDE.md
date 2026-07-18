# CLAUDE.md — BotPanel SaaS

Guía obligatoria para trabajar en este proyecto sin romper la arquitectura ni el trabajo existente. Léela completa antes de actuar.

---

## AL INICIAR CUALQUIER TAREA (flujo obligatorio)

1. **ORIENTARTE** — Ten presente estas reglas y el **MAPA DE SKILLS** (sección 10). Identifica qué skills aplican al pedido y consúltalas ANTES de actuar.
2. **ACOTAR** — Reformula en una frase qué se va a cambiar y qué **NO** se va a tocar. Si el pedido es ambiguo, **pregunta antes de asumir**.
3. **PROTEGER** — Si el cambio toca base de datos, RLS, auth, etiquetas/tools del bot o multi-tenancy → consulta **arquitecto-saas** (y **base-de-datos** / **seguridad-saas** si corresponde) antes de seguir.
4. **PLAN** — Propón un plan breve (qué archivos se tocan y cómo) y **espera aprobación del usuario**. No escribas código hasta que el plan sea aprobado.
5. **CAMBIO MÍNIMO** — Haz el cambio más pequeño que cumpla el pedido. No reescribas archivos enteros ni borres funciones, campos, endpoints o validaciones que no se pidieron.
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
- **WhatsApp:** YCloud (principal), Meta Graph API, Kapso — vía `axios`
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
│   ├── src/services/bot-tags.ts # Parser puro de reservas, pedidos, handoff y media
│   ├── src/services/bot-actions.ts # Acciones tipadas y multi-tenant de reservas, sesiones y pedidos
│   ├── src/services/bot-media.ts # Selección estricta y envío tipado de media por negocio
│   ├── src/services/bot-conversation.ts # Flujo central tipado, desde sesión hasta respuesta
│   ├── src/services/bot-entry.ts # Debounce, resolución de negocio y adaptadores WA/TG tipados
│   ├── src/services/money.ts   # Resolución estricta, centavos, totales y resumen oficial
│   ├── src/services/lodging.ts # Contratos y normalización del núcleo de hospedaje
│   ├── src/services/tunnel.ts # Estado, arranque y cierre tipados del túnel local
│   ├── src/integrations/ycloud.ts # Envío WhatsApp + typing indicator tipados
│   ├── src/integrations/whatsapp.ts # Selección segura Meta/Kapso/YCloud por negocio
│   ├── src/integrations/telegram.ts # Comandos, voz, fotos, webhook/polling y sesión por slug
│   ├── src/integrations/retell.ts # Custom LLM, firmas HMAC y eventos de llamadas tipados
│   ├── src/integrations/cloudinary.ts # Media aislada por negocio
│   ├── src/middleware/async.ts  # Propagación tipada de errores async de Express
│   ├── src/middleware/auth.ts   # JWT, roles y permisos tipados
│   ├── src/routes/orders.routes.ts # Pedidos del cliente aislados por JWT
│   ├── src/routes/auth.routes.ts # Login admin/cliente con rate limit
│   ├── src/routes/reports.routes.ts # Reportes y dashboard aislados por JWT
│   ├── src/routes/sales.routes.ts # Ventas manuales y cotizaciones tipadas
│   ├── src/routes/sessions.routes.ts # Conversaciones, modo manual y etiquetas aislados
│   ├── src/routes/webhooks.routes.ts # Entradas Meta/YCloud/Kapso firmadas, limitadas y deduplicadas
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
│   ├── src/routes/lodging.routes.ts # Hospedaje aislado por JWT, capacidad y permiso
│   ├── src/types/express.d.ts   # Claims compartidos de autenticación Express
│   ├── schema.sql             # Esquema consolidado y ACTUALIZADO (referencia única — ver sección 4)
│   ├── migration-ventas-reportes.sql  # Migración de ventas + reportes (correr en Supabase)
│   ├── migration-atomicidad-onboarding.sql # Negocio, dueño, políticas y cuotas transaccionales
│   ├── migration-atomicidad-pedidos.sql # Cabecera, ítems y totales de pedidos transaccionales
│   ├── migration-atomicidad-reservas.sql # Lock + exclusión de intervalos activos por negocio
│   ├── migration-hospedaje.sql # Inventario, cotizaciones y holds de alojamiento transaccionales
│   ├── migration-preparacion-produccion.sql # Retiro seguro de cobros automáticos + horarios iniciales
│   ├── migration-deduplicacion-webhooks.sql # Reclamos atómicos de eventos por negocio
│   ├── migration-integraciones.sql    # Migración inicial (OBSOLETA — solo historial, no ejecutar)
│   └── .env                   # Credenciales (NUNCA a git)
├── apps/
│   ├── admin/                 # Panel del superadmin (React+Vite+TS) — OFICIAL, servido en /app-admin
│   └── client/                # Panel del cliente (React+Vite+TS) — OFICIAL, servido en /app
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

> ✅ Esquema: `server/schema.sql` está **consolidado y actualizado** (refleja la base real: RLS activado, `bookings` con `booking_date`/`booking_time`/`duration_minutes`, todas las columnas y tablas vivas, y la función RAG `match_products`). `server/migration-integraciones.sql` quedó **OBSOLETO** (marcado como tal, solo historial — no ejecutar). Para el estado del esquema, usa `schema.sql` o consulta la BD.

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
- **Etiquetas del bot** en formato `##NOMBRE##` o `##NOMBRE:datos##`; `server/src/services/bot-entry.ts` agrupa mensajes y resuelve el negocio por número WhatsApp o slug Telegram, `server/src/services/bot-conversation.ts` coordina el flujo, `server/src/services/bot-tags.ts` detecta y limpia sin acceder a la base, `server/src/services/bot-actions.ts` ejecuta acciones y `server/src/services/bot-media.ts` envía media del catálogo. Todos reciben exclusivamente el `business.id` resuelto por el adaptador de canal. Las vigentes incluyen `##BOOK:nombre|YYYY-MM-DD|HH:MM|servicio##`, `##PEDIDO:producto x cantidad; ...##`, `##STAY_QUOTE:ENTRADA|SALIDA|HABITACIONES|ADULTOS|NIÑOS##`, `##STAY_REQUEST:TIPO_HABITACION|NOMBRE##` y `##HANDOFF##`. Las acciones BOOK, PEDIDO, STAY_QUOTE, STAY_REQUEST y HANDOFF son mutuamente excluyentes; una respuesta conflictiva falla cerrado. `##VENTA##`/`##PEDIDO##` simples se conservan solo como respaldo legacy y `##BOOKING##` se limpia por compatibilidad.
- **Reportes del dueño (`server/src/services/reports.ts`):** NO son etiquetas ni function-calling. Son una **capa de intención server-side** que corre en `bot-conversation.ts` ANTES del flujo de atención: si quien escribe es el `owner_phone` del negocio y el texto pide un reporte, se responde el reporte (texto plano WhatsApp) y se corta; si no es el dueño o no es un reporte, devuelve `handled:false` y sigue el flujo normal. Sus cálculos, dashboard y alertas están tipados y todos reciben el `business_id` ya resuelto. Las ventas se registran a mano desde el panel del cliente (tablas `sales` + `sale_items`).
- **Telegram (`server/src/integrations/telegram.ts`):** el negocio se selecciona/restaura por `slug`; la restauración consulta únicamente el `business_id` más reciente de `tg_<chatId>` mediante la capa `src/db` y luego valida que el negocio siga activo. La integración no crea clientes Supabase propios. Texto, voz y fotos entregan siempre `{ channel:'telegram', ctx, slug }` a `bot-entry.ts`.
- **Retell (`server/src/integrations/retell.ts`):** `/api/retell/call-events` exige HMAC SHA-256 con ventana anti-replay de cinco minutos cuando existe `retell_api_key`; `/api/retell/llm` exige `RETELL_LLM_SECRET` en producción. Ambos conservan el rate limit de `src/index.ts`. El negocio se resuelve exclusivamente desde `call.to_number`; catálogo, políticas y mensajes usan ese `business.id`. La integración consume directamente `ai.ts` y nunca registra keys ni el payload completo.
- **Dinero (`server/src/services/money.ts`):** calcula importes oficiales y las RPC revalidan negocio, producto, stock y precio. El flujo es manual: la plataforma registra el pedido y su entrega, pero no procesa ni registra el cobro del cliente.
- **Capacidades por negocio:** `businesses.takes_bookings`, `businesses.takes_orders` y `businesses.lodging_enabled` son fuentes de verdad independientes; el tipo solo recomienda valores al crear y nunca sobrescribe decisiones manuales ni negocios existentes. Pizzería/retail recomienda pedidos; servicios de cita recomiendan agenda e informativo; hotel/hostal/alojamiento recomienda hospedaje sin reutilizar citas ni pedidos. En modo informativo se responden precios, descripciones, stock, fotos y videos; solo la intención transaccional explícita deriva y jamás crea pagos o pedidos.
- **Capacidad de citas y hospedaje:** la agenda simple usa `create_booking_if_available` para conservar capacidad única; el cobro se coordina fuera de la plataforma. Hospedaje es un dominio separado con inventario agregado por tipo y noche: `quote_lodging_options` calcula opciones y `create_lodging_request_if_available` crea el hold bajo lock por negocio; un trigger impide superar `total_units` incluso ante escrituras concurrentes. Los holds vencidos dejan de ocupar cupo y las reservas externas/mantenimiento se registran como bloqueos independientes.
- **Arranque seguro:** `server/src/config/environment.ts` valida antes de abrir el puerto las credenciales críticas, fortaleza mínima de secretos, `BASE_URL` y el secreto Telegram cuando aplica. Producción falla cerrado en vez de publicar un healthcheck verde con configuración incompleta.
- **Contraseñas nuevas:** superadmin, dueños y empleados usan un mínimo de 12 caracteres; siempre se almacenan con bcrypt y nunca se devuelven en APIs.
- **Sesiones cliente vigentes:** `activeClientGuard` revalida cada 15 segundos como máximo que usuario y negocio sigan activos, y reemplaza rol/permisos del JWT por los valores actuales de la base. Eliminar un usuario, suspender un negocio o revocar permisos falla cerrado sin esperar siete días.
- **Túnel local (`server/src/services/tunnel.ts`):** solo se usa en desarrollo; inicia y detiene `cloudflared` mediante dependencias inyectables, expone únicamente estado serializable (`url`, `active`, `provider`, `startedAt`) y nunca filtra el proceso hijo en respuestas administrativas. En producción la URL pública sale de `BASE_URL`.
- **Grafo interno del servidor:** los módulos bajo `server/src/` se enlazan directamente entre `db`, `services`, `integrations`, `middleware` y `routes`; comandos, pruebas y Railway ejecutan el resultado compilado en `server/dist/`.
- **Nombres:** `camelCase` en TypeScript/JavaScript; columnas y tablas en `snake_case`.

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

- **Sucursales / multi-local por negocio.** Un negocio con varios locales. Enfoque **aditivo** cuando se pida: tabla `locations` + columna `location_id` (nullable) en `products`, `sales`, `bookings`, `conversation_sessions`. Los negocios de un solo local quedan con `location_id` nulo (sin cambios). NO construir de forma especulativa: mete "impuesto de complejidad" a todos y toca multi-tenancy (filtrar por `business_id` **y** `location_id`). Requiere definir antes: ¿cada sucursal tiene su propio número de WhatsApp?, ¿comparten catálogo?, ¿un empleado pertenece a una o varias? Va con **arquitecto-saas**.
- **Ventas por sucursal** (reporte) depende del módulo anterior.
- **Perfil de cliente ampliado (paso 2 del directorio de clientes).** Agregar al directorio: **ciudad, cédula y correo del cliente**, y permitir **buscar por cédula y correo**. Hoy NO se recopilan esos datos. Requiere definir: (a) dónde se guardan (tabla/perfil de cliente por `business_id`, hoy el cliente es solo `contact_phone` disperso en `sales`/`conversation_sessions`), y (b) **cómo se capturan** (¿el dueño los escribe a mano?, ¿el bot los pide?). ⚠️ La **cédula es PII sensible** → va con **seguridad-saas** (para qué se usa, consentimiento, almacenamiento cuidado). El directorio base (nuevos/frecuentes/inactivos, última compra, total gastado, frecuencia, búsqueda por nombre/teléfono) YA está hecho.
- **Alertas — Fase 2 (push instantáneo) y Fase 3 (resumen diario).** La Fase 1 YA está hecha: **banner de alertas en el panel** (sección Reportes, endpoint `/api/client/alerts` → `reports.computeAlerts`), que vigila con los cálculos existentes. Falta: (a) **Fase 2 — push por WhatsApp al dueño** de las críticas, con hook en `server/src/services/bot-conversation.ts`/venta, umbral configurable y anti-duplicado; (b) **Fase 3 — resumen diario**, programado desde `server/src/index.ts`. ⚠️ Toca envío y multi-tenancy → va con **arquitecto-saas**.
- **Reporte de IA — Fase 2: con IA.** La Fase 1 YA está hecha (sin IA): preguntas frecuentes por reglas y huecos persistidos en `ai_gaps` desde `server/src/services/bot-actions.ts`. Falta agrupar preguntas abiertas y sugerir automáticamente mejoras por lotes. ⚠️ Usa IA sobre conversaciones → va con **seguridad-saas** y **arquitecto-saas**.
- **Clientes perdidos — Capa 2: razón completa.** El reporte "Clientes perdidos" (Capa 1) YA está hecho: lista de quienes **escribieron pero no compraron en el período**, con badge 🔁 ya-cliente / 🆕 nuevo y razón automática **"No respondió"** (el negocio habló al final). Falta la **razón completa**: **Precio / Sin stock / Cambió de opinión** (hoy quedan como "Sin clasificar"). Requiere definir el método de captura: (a) **manual** — el dueño marca la razón por cliente desde el panel (columna nueva, ej. tabla `lost_customers` o campo en sesión, por `business_id`); (b) **IA infiere** — clasificar leyendo la conversación (costo de llamadas IA, ~aproximado); (c) **mixto**. ⚠️ Si se usa IA sobre conversaciones del cliente → va con **seguridad-saas**; en todo caso con **arquitecto-saas** (dónde persiste la razón sin romper multi-tenancy). Entregar al usuario para analizar antes de construir.
- **Campañas / difusión (mensajes salientes).** NO existe. Mandar una promo a una audiencia (todos, clientes perdidos, en riesgo). Cimientos listos: envío (`ycloud.sendText/sendImage`, Telegram) + audiencias ya calculadas (directorio, perdidos, riesgo). Falta: módulo que arme el mensaje + elija audiencia + envíe a muchos, tabla de campañas + control de envíos, y UI. ⚠️ Envío proactivo en WhatsApp fuera de la ventana de 24h exige **plantillas aprobadas por Meta** + opt-in. **Construir SOLO después de estabilizar el canal (Meta) y el deploy.** Va con **arquitecto-saas** + **seguridad-saas**.
- **Asistente de voz para el dueño ("Jarvis" — ElevenLabs).** NO existe. Que el bot responda con nota de voz al `owner_phone`. Falta key mediante `server/src/services/settings.ts`, generación TTS, envío por la integración del canal y control de costo. ⚠️ Va con **arquitecto-saas** + **seguridad-saas** después del deploy + Meta.
- **Recordatorios automáticos de citas (mensajes salientes).** NO existe. Avisar antes de una cita usando `bookings`, la capa de envío y una tarea programada desde `server/src/index.ts`; requiere `reminded_at` o estado equivalente para no repetir. ⚠️ Construir después de Meta + deploy con **arquitecto-saas**.
- **Hospedaje — extensiones futuras (anotado 2026-07-17; construir SOLO cuando un hostal real lo pida).** El módulo base está COMPLETO (cotización oficial → retención con vencimiento → confirmación del equipo, anti-sobreventa con locks + trigger, bloqueos manuales, tarifas por fecha, panel de 4 pestañas). Candidatos por orden de valor real: (1) **Sincronización iCal con Booking/Airbnb** — hoy las reservas externas se registran como bloqueos manuales; los OTAs exponen calendarios iCal que se podrían importar periódicamente para descontar cupo solo (es lo primero que sufrirá un hostal que venda en OTAs). ⚠️ Tarea programada + escritura de bloqueos por `business_id` → va con **arquitecto-saas**. (2) **Vista calendario de ocupación** en el panel (mes con ocupación por tipo de habitación; hoy solo hay búsqueda por fechas) — va con **graficos-dashboard**. (3) **Recordatorio de llegada al huésped** — pertenece a la familia de mensajes salientes post-Meta/deploy, junto a recordatorios de citas y campañas.
- **Reglas de descuento automáticas por código (promos).** NO existe (anotado 2026-07: construir SOLO cuando un cliente real lo pida). Que el dueño configure promos con condiciones desde su panel — ej. "10% en pedidos sobre $50", "2x1 los martes", "descuento por combo" — y que las aplique `server/src/services/money.ts` en el campo `discount` que YA existe en `orders` (cimiento listo). La IA solo ANUNCIA la promo; la condición y la resta las calcula el SERVIDOR (regla inviolable #8: la IA jamás decide montos). Requiere: tabla de reglas por `business_id` + RLS, UI en el panel del dueño, y lógica de condiciones en `money.ts` (monto mínimo, día de semana, producto/combo). Mientras tanto, el **Precio oferta** (`price_sale`) por producto ya cubre promos simples y el núcleo lo respeta. Va con **arquitecto-saas** + **base-de-datos**; diseñar con el caso real del cliente que lo pida, no especulando.
- **Optimización de egress / consumo de datos de Supabase.** NO hecho (decidido con el usuario 2026-07: por ahora se paga/aguanta, no se toca el código; anotado para cuando se justifique). **Contexto:** en plan free (5 GB egress/mes = datos leídos que SALEN de la base, NO storage) el consumo llegó a ~5.47 GB **sin subir archivos pesados**. Causa: **polling del panel** — `loadConversations` cada **3s** trae hasta **100 mensajes completos** + todas las sesiones con `select('*')`; `checkForUpdates` cada 5s; `checkNewBookings` cada 12s. Se acumula solo con el panel abierto. Segundo culpable histórico: lecturas de catálogo que incluían el `embedding` vector(1536); revisar `server/src/db/repositories/products.ts` antes de optimizar. **Cloudinary NO influye** (la media va a Cloudinary, no a Supabase). **Optimizaciones pendientes (por impacto/riesgo):** (1) bajar polling de conversaciones 3s→~10s + **pausar con Page Visibility API** cuando la pestaña no está visible → corta ~70-80%, riesgo mínimo; (2) confirmar selects mínimos del catálogo; (3) traer **solo lo nuevo** en conversaciones en vez de 100 completos; (4) detectado 2026-07-16: `reports.getAllReports` lanza ~8 lecturas idénticas de `getSalesWithItems` por carga (una por cada compute) — deduplicar trayendo las ventas UNA vez y pasándolas a los cálculos. **Alternativa operativa:** Supabase Pro. **Solución de fondo:** Realtime/WebSockets + caché cuando el volumen lo justifique. Va con **arquitecto-saas** + **base-de-datos**.

> **Estado del producto (nota estratégica):** el sistema está **listo para vender/demo**. La construcción de features está **en pausa a propósito** — el siguiente paso es **operativo**, no de código: demo → cambiar número a **Meta** (hoy YCloud) → **deploy 24/7 en servidor real** (hoy corre local + túnel). Campañas y recordatorios (los dos únicos que envían mensajes salientes) van **después** de eso. No construir más módulos de forma especulativa; esperar señal de un cliente/piloto real.

> **Escalabilidad (nota de arquitectura, a futuro):** hoy es un **monolito** (un solo servidor Node + Express). Es lo **correcto para la etapa actual** (primeros clientes) — simple, barato, fácil de operar. NO refactorizar de forma especulativa. Cuando haya **demanda real de escala** (muchos negocios/mensajes concurrentes), recién ahí evaluar: **Realtime/WebSockets** (empujar cambios al panel en vez de que pregunte cada X segundos — ataca de raíz el egress del polling), **caché (Redis)** (datos muy leídos en memoria, sin golpear la base), **colas** (procesar mensajes/IA sin bloquear), **workers** separados (envíos, embeddings, reportes pesados, transcodificar media), varias instancias + balanceador, réplicas de lectura, y quizás separar el bot del panel. Antes de todo eso, el paso barato es **Supabase Pro ($25/mes)** para subir los límites. Es un "problema de éxito": se aborda cuando el volumen lo justifique, no antes.
