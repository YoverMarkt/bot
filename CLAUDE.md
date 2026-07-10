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

- **Node.js** ≥ 18 + **Express** ^4.19
- **Supabase (PostgreSQL)** vía `@supabase/supabase-js` ^2.43, con **pgvector** (RAG)
- **Auth:** `jsonwebtoken` ^9 (JWT) + `bcryptjs` ^2.4
- **IA (multi-proveedor):** `openai` ^6.45 (OpenAI + compatible Groq), `@anthropic-ai/sdk` ^0.24 (Claude), Gemini (API nativo vía `axios`), Groq (vía SDK OpenAI con baseURL)
- **WhatsApp:** YCloud (principal), Meta Graph API, Kapso — vía `axios`
- **Telegram:** `telegraf` ^4.16
- **HTTP:** `axios` ^1.7 · **Rate limit:** `express-rate-limit` ^8.5 · **CORS:** `cors`
- **Túnel local:** `localtunnel` + `cloudflared` (solo desarrollo)
- **Frontend:** HTML + CSS + JavaScript puro (sin framework)
- **Sin TypeScript, sin linter, sin framework de tests, sin CI.**

---

## 3. ESTRUCTURA DEL PROYECTO

```
bot/
├── server/                    # Backend Node.js + Express
│   ├── index.js               # Servidor, rutas API, webhooks, auth middlewares
│   ├── bot.js                 # Núcleo del bot: callAI, visión, audio, RAG, processMessage, etiquetas
│   ├── db.js                  # TODO el acceso a Supabase (única capa de datos)
│   ├── reports.js             # 7 reportes de ventas para el dueño (intención + validación owner_phone)
│   ├── settings.js            # Config de keys de IA (tabla server_settings; panel > .env)
│   ├── telegram.js            # Integración Telegram (telegraf)
│   ├── ycloud.js              # Envío WhatsApp + typing indicator (YCloud)
│   ├── retell.js              # Voz telefónica (Retell) — opcional
│   ├── tunnel.js              # Túnel público (solo local)
│   ├── calendar.js            # Helper de tipos de negocio con calendario
│   ├── schema.sql             # Esquema consolidado y ACTUALIZADO (referencia única — ver sección 4)
│   ├── migration-ventas-reportes.sql  # Migración de ventas + reportes (correr en Supabase)
│   ├── migration-integraciones.sql    # Migración inicial (OBSOLETA — solo historial, no ejecutar)
│   └── .env                   # Credenciales (NUNCA a git)
├── apps/
│   ├── admin/                 # Panel del superadmin (React+Vite+TS) — OFICIAL, servido en /app-admin
│   └── client/                # Panel del cliente (React+Vite+TS) — OFICIAL, servido en /app
├── admin/index.html           # Panel viejo del superadmin (LEGACY — respaldo en /admin-legacy; se borra tras validar)
├── client/index.html          # Panel viejo del cliente (LEGACY — respaldo en /client-legacy; se borra tras validar)
└── CLAUDE.md / README.md / ARQUITECTURA.md
```

- **La llave de tenant es `business_id`** (en código, `req.user.businessId`). Cuando estas reglas digan "client_id", en este proyecto es **`business_id`**.

---

## 4. REGLAS INVIOLABLES

1. **Aislamiento multi-tenant:** TODA consulta de datos de un negocio se filtra por **`business_id`**. En endpoints de cliente, el `business_id` SIEMPRE sale del JWT (`req.user.businessId`), **nunca** de un parámetro que el cliente pueda manipular. Toda tabla nueva nace con columna `business_id` + RLS. **Nunca** se desactiva ni se debilita una política RLS.
2. **Service role key solo en el servidor.** `SUPABASE_SERVICE_KEY` jamás se expone al frontend ni se envía a `admin/` o `client/`. El frontend nunca habla directo con Supabase.
3. **Nunca hardcodear secretos ni claves.** Usa variables de entorno o la tabla `server_settings` (vía `settings.js`). Las keys de IA y de WhatsApp por cliente se guardan en BD, no en código.
4. **No reescribir archivos completos por cambios pequeños.** No borrar funciones, campos, endpoints ni validaciones que no se pidió tocar. Edición quirúrgica.
5. **Las etiquetas/tools del bot siempre operan sobre el `business_id` de la conversación.** El bot resuelve el negocio por el canal (slug de Telegram o número de WhatsApp) y SOLO usa datos de ese negocio (catálogo, horarios, políticas, historial).
6. **Checkout por WhatsApp; pasarela SOLO vía `payments.js`.** No se integran Stripe/PayPal/tarjetas. El cierre de venta emite `##PEDIDO:producto x cantidad##` → el servidor calcula el **total oficial** y deriva al dueño (modo manual) para coordinar pago/entrega. Cuando exista una pasarela (DeUna de Banco Pichincha, decidido 2026-07), se conecta ÚNICAMENTE en `payments.js` con credenciales POR NEGOCIO en BD (el dinero va directo al negocio, nunca al dueño del SaaS).
7. **El bot nunca inventa datos.** Precios, productos y horarios salen solo de los datos del negocio inyectados en el prompt.
8. **La IA conversa, el CÓDIGO calcula (núcleo de dinero).** Ningún monto que vea el cliente sale del modelo: totales, precios de pedidos, links de pago y descuentos se calculan/generan SOLO server-side (`money.js` + tablas `orders`/`order_items`). El prompt es cortesía, no seguridad. Si un ítem del pedido no se resuelve con certeza contra el catálogo, NO se envía total (pasa al dueño). Los descuentos, si algún día existen, serán regla de código/panel — jamás decisión de la IA.

> ✅ Esquema: `server/schema.sql` está **consolidado y actualizado** (refleja la base real: RLS activado, `bookings` con `booking_date`/`booking_time`/`duration_minutes`, todas las columnas y tablas vivas, y la función RAG `match_products`). `server/migration-integraciones.sql` quedó **OBSOLETO** (marcado como tal, solo historial — no ejecutar). Para el estado del esquema, usa `schema.sql` o consulta la BD.

---

## 5. CÓMO MANEJAR UN PEDIDO DE CAMBIO

1. **Entender el alcance** y declarar en una frase qué SÍ y qué NO se toca.
2. **Localizar los archivos mínimos** involucrados (casi todo el acceso a datos vive en `db.js`; la lógica del bot en `bot.js`; las rutas en `index.js`).
3. **Cambio más pequeño posible** — edición quirúrgica, sin tocar lo no pedido.
4. **Verificar** (tester-saas): cargar módulos, revisar sintaxis, arrancar, smoke test de la zona afectada.
5. **Reportar** qué cambió, qué se verificó y qué quedó intacto.

Para cambios amplios o ambiguos → **cambios-seguros**. Para tocar BD/RLS/auth/bot → **arquitecto-saas** primero.

---

## 6. COMANDOS DEL PROYECTO (reales, de package.json)

```bash
# Raíz (monorepo con npm workspaces — UN solo lockfile e install para todo)
npm install               # instala server + apps/client + apps/admin de una vez
npm start                 # node server/index.js  (producción)
npm run dev               # nodemon del server (desarrollo, recarga al guardar)
npm run build             # build de los dos paneles React (client + admin)
npm run check             # lint + tipos (@ts-check) + tests de dinero del server
npm test                  # solo los tests (Vitest)

# También se puede trabajar dentro de cada workspace (cd server && npm run dev, etc.)
```

> Los workspaces son `@botpanel/server`, `@botpanel/client` y `@botpanel/admin`. El CI corre `check` + builds en cada PR. El servidor en local arranca un túnel Cloudflare automático; en producción usa `BASE_URL`.

---

## 7. CONVENCIONES DE CÓDIGO

- **JavaScript (CommonJS):** `const x = require('...')`, `module.exports = { ... }`. Sin TypeScript.
- **Funciones flecha** y `async/await`. Nada de callbacks anidados.
- **Todo el acceso a Supabase pasa por `db.js`** — no consultes `sb.from(...)` desde `index.js` o `bot.js`; agrega/usa una función en `db.js`.
- **Las keys de IA se leen siempre con `settings.get('...')`** (panel > .env), nunca `process.env` directo para IA salvo como fallback dentro de `settings.get`.
- **Comentarios y logs en español.** Emojis en logs siguiendo el estilo existente (`✅ ❌ 🤖 📡 🛒 🤚 🔔`).
- **Textos de cara al cliente (bot y paneles) en español** neutro (mercado Ecuador/Colombia).
- **Etiquetas del bot** en formato `##NOMBRE##` o `##NOMBRE:datos##`. Las existentes: `##BOOK:nombre|YYYY-MM-DD|HH:MM|servicio##`, `##HANDOFF##`, `##PEDIDO:producto x cantidad; ...##` (núcleo de dinero: el servidor resuelve productos contra la base, calcula el total EN CÓDIGO y envía él mismo el resumen oficial; crea fila en `orders`+`order_items`), `##VENTA##`/`##PEDIDO##` simples (legacy, solo avisan al dueño sin total oficial), `##IMG##`, `##CATALOG##`. Las reservas (`##BOOK##`) solo se ofrecen si el negocio está en **modo "Con citas"** (`businesses.takes_bookings = true`); en modo "Normal" el bot no agenda (una tienda/perfumería/venta de agua puede tener horario de atención sin ofrecer citas). La etiqueta `##BOOKING##` (derivación a Cal.com) fue **retirada** — Cal.com ya no se usa; la columna `calcom_link` quedó huérfana (obsoleta, sin dropear).
- **Reportes del dueño (`server/reports.js`):** NO son etiquetas ni function-calling. Son una **capa de intención server-side** que corre en `processMessage` ANTES del flujo de atención: si quien escribe es el `owner_phone` del negocio y el texto pide un reporte, se responde el reporte (texto plano WhatsApp) y se corta; si no es el dueño o no es un reporte, devuelve `handled:false` y sigue el flujo normal. 7 reportes (ventas, top, bajo movimiento, comparación, clientes frecuentes, stock bajo, pendientes), todos filtrados por `business_id`. Las ventas se registran a mano desde el panel del cliente (tablas `sales` + `sale_items`).
- **Nombres:** `camelCase` en JS; columnas y tablas en `snake_case`.

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
- **Alertas — Fase 2 (push instantáneo) y Fase 3 (resumen diario).** La Fase 1 YA está hecha: **banner de alertas en el panel** (sección Reportes, endpoint `/api/client/alerts` → `reports.computeAlerts`), que vigila con los cálculos existentes: productos agotados/últimas unidades, conversaciones sin cerrar, ventas ±20% vs semana pasada, clientes en riesgo, productos abandonados, preguntas sin responder, día sin ventas, plan por vencer. Falta: (a) **Fase 2 — push por WhatsApp al dueño** SOLO de las 4 críticas (conversación sin respuesta, cliente VIP escribió, stock a 0, plan por vencer), con **hook en `bot.js`/venta** (evento en tiempo real) + **umbral configurable** + **anti-duplicado** (no repetir la misma alerta; requiere estado, ej. tabla `alerts_sent` o campo por sesión) para no spamear; (b) **Fase 3 — resumen diario**: UN solo WhatsApp al día con lo no urgente, reusando el `setInterval` horario que ya existe en `index.js`. ⚠️ El push toca `bot.js`/envío y multi-tenancy → va con **arquitecto-saas**. Entregar al usuario para analizar antes de construir.
- **Reporte de IA — Fase 2: con IA.** La Fase 1 YA está hecha (sin IA): **preguntas más frecuentes** por reglas de palabras clave (horarios, precios, envíos, pago, garantía, ubicación, disponibilidad, promociones) + **preguntas que el bot no pudo responder** (tabla `ai_gaps`, capturadas en `bot.js` en el momento `isUncertain`/handoff). Falta: (a) que **IA agrupe preguntas abiertas** que las reglas no captan (temas nuevos no previstos), y (b) que **IA sugiera automáticamente** *"agrega esto a tu bot"* procesando los huecos juntos (una sola llamada por lote, no por mensaje). ⚠️ Usa IA sobre conversaciones del cliente → va con **seguridad-saas**; y con **arquitecto-saas** por el costo de llamadas y dónde persiste. Entregar al usuario para analizar antes de construir.
- **Clientes perdidos — Capa 2: razón completa.** El reporte "Clientes perdidos" (Capa 1) YA está hecho: lista de quienes **escribieron pero no compraron en el período**, con badge 🔁 ya-cliente / 🆕 nuevo y razón automática **"No respondió"** (el negocio habló al final). Falta la **razón completa**: **Precio / Sin stock / Cambió de opinión** (hoy quedan como "Sin clasificar"). Requiere definir el método de captura: (a) **manual** — el dueño marca la razón por cliente desde el panel (columna nueva, ej. tabla `lost_customers` o campo en sesión, por `business_id`); (b) **IA infiere** — clasificar leyendo la conversación (costo de llamadas IA, ~aproximado); (c) **mixto**. ⚠️ Si se usa IA sobre conversaciones del cliente → va con **seguridad-saas**; en todo caso con **arquitecto-saas** (dónde persiste la razón sin romper multi-tenancy). Entregar al usuario para analizar antes de construir.
- **Campañas / difusión (mensajes salientes).** NO existe. Mandar una promo a una audiencia (todos, clientes perdidos, en riesgo). Cimientos listos: envío (`ycloud.sendText/sendImage`, Telegram) + audiencias ya calculadas (directorio, perdidos, riesgo). Falta: módulo que arme el mensaje + elija audiencia + envíe a muchos, tabla de campañas + control de envíos, y UI. ⚠️ Envío proactivo en WhatsApp fuera de la ventana de 24h exige **plantillas aprobadas por Meta** + opt-in. **Construir SOLO después de estabilizar el canal (Meta) y el deploy.** Va con **arquitecto-saas** + **seguridad-saas**.
- **Asistente de voz para el dueño ("Jarvis" — ElevenLabs).** NO existe. Que el bot le RESPONDA con nota de voz al dueño por WhatsApp (hoy ya transcribe la voz entrante con Whisper; falta la voz de salida). Alcance sugerido: solo al `owner_phone` y solo cuando el dueño escribe por voz (si escribe texto, responde texto). Falta: API key de ElevenLabs (vía `settings.js`/env, NUNCA hardcodear) + generación TTS + envío de audio por el canal (YCloud/Meta) + control de costo (cobra por caracteres). ⚠️ Toca envío/bot y una key nueva → va con **arquitecto-saas** + **seguridad-saas**. **Construir después del deploy + Meta.** Decidido con el usuario (2026-07): en pausa hasta estabilizar el canal.
- **Recordatorios automáticos de citas (mensajes salientes).** NO existe. Avisar al cliente antes de su cita (reduce no-show; fuerte para barberías/clínicas). Cimientos listos: `bookings` (fecha/hora/teléfono/servicio) + envío + el `setInterval` horario de `index.js`. Falta: lógica que busque citas próximas y envíe, + control de "ya recordado" (no repetir; ej. columna `reminded_at` en `bookings`). ⚠️ Mismo tema de plantillas Meta que campañas. **Construir después de Meta + deploy.** Es de las más rápidas (cimientos completos). Va con **arquitecto-saas**.
- **Reglas de descuento automáticas por código (promos).** NO existe (anotado 2026-07: construir SOLO cuando un cliente real lo pida). Que el dueño configure promos con condiciones desde su panel — ej. "10% en pedidos sobre $50", "2x1 los martes", "descuento por combo" — y que las aplique `money.js` en el campo `discount` que YA existe en `orders` (cimiento listo). La IA solo ANUNCIA la promo; la condición y la resta las calcula el SERVIDOR (regla inviolable #8: la IA jamás decide montos). Requiere: tabla de reglas por `business_id` + RLS, UI en el panel del dueño, y lógica de condiciones en `money.js` (monto mínimo, día de semana, producto/combo). Mientras tanto, el **Precio oferta** (`price_sale`) por producto ya cubre promos simples y el núcleo lo respeta. Va con **arquitecto-saas** + **base-de-datos**; diseñar con el caso real del cliente que lo pida, no especulando.
- **Optimización de egress / consumo de datos de Supabase.** NO hecho (decidido con el usuario 2026-07: por ahora se paga/aguanta, no se toca el código; anotado para cuando se justifique). **Contexto:** en plan free (5 GB egress/mes = datos leídos que SALEN de la base, NO storage) el consumo llegó a ~5.47 GB **sin subir archivos pesados**. Causa: **polling del panel** — `loadConversations` cada **3s** trae hasta **100 mensajes completos** + todas las sesiones con `select('*')`; `checkForUpdates` cada 5s; `checkNewBookings` cada 12s. Se acumula solo con el panel abierto. Segundo culpable: `getProducts` ([db.js:63](server/db.js)) usa `select('*')` y **arrastra el `embedding` vector(1536)** por producto en cada lectura del catálogo. **Cloudinary NO influye** (la media va a Cloudinary, no a Supabase). **Optimizaciones pendientes (por impacto/riesgo):** (1) bajar polling de conversaciones 3s→~10s + **pausar con Page Visibility API** cuando la pestaña no está visible → corta ~70-80%, riesgo mínimo (solo el panel refresca más lento; el bot responde igual, es webhook, no polling); (2) **quitar `embedding` del select** de `getProducts` (traer solo columnas necesarias) → ganancia pura, sin contra; (3) traer **solo lo nuevo** en conversaciones (incremental desde el último visto) en vez de 100 completos → más delicado, dejar para el final. **Alternativa operativa:** migrar a **Supabase Pro ($25/mes → 250 GB egress, 8 GB DB, 100 GB storage, sin pausa, backups)** — sobra con holgura para decenas de negocios. **Solución de fondo (gran escala):** Realtime/WebSockets (empujar cambios en vez de polling) + caché (Redis) eliminan el problema de raíz; más trabajo, solo cuando el volumen lo justifique. Va con **arquitecto-saas** + **base-de-datos**.

> **Estado del producto (nota estratégica):** el sistema está **listo para vender/demo**. La construcción de features está **en pausa a propósito** — el siguiente paso es **operativo**, no de código: demo → cambiar número a **Meta** (hoy YCloud) → **deploy 24/7 en servidor real** (hoy corre local + túnel). Campañas y recordatorios (los dos únicos que envían mensajes salientes) van **después** de eso. No construir más módulos de forma especulativa; esperar señal de un cliente/piloto real.

> **Escalabilidad (nota de arquitectura, a futuro):** hoy es un **monolito** (un solo servidor Node + Express). Es lo **correcto para la etapa actual** (primeros clientes) — simple, barato, fácil de operar. NO refactorizar de forma especulativa. Cuando haya **demanda real de escala** (muchos negocios/mensajes concurrentes), recién ahí evaluar: **Realtime/WebSockets** (empujar cambios al panel en vez de que pregunte cada X segundos — ataca de raíz el egress del polling), **caché (Redis)** (datos muy leídos en memoria, sin golpear la base), **colas** (procesar mensajes/IA sin bloquear), **workers** separados (envíos, embeddings, reportes pesados, transcodificar media), varias instancias + balanceador, réplicas de lectura, y quizás separar el bot del panel. Antes de todo eso, el paso barato es **Supabase Pro ($25/mes)** para subir los límites. Es un "problema de éxito": se aborda cuando el volumen lo justifique, no antes.
