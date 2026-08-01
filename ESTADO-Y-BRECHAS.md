# ESTADO Y BRECHAS — BotPanel SaaS

> **Qué es este documento:** auditoría de BotPanel contra el índice de 35 capítulos de un
> "libro técnico de SaaS de producción". Para cada capítulo dice **qué ya existe** (con
> archivos reales del repo), **qué falta**, **si conviene construirlo ahora o no**, y un
> **prompt listo para Codex**.
>
> **Método:** auditoría directa del código el **2026-07-29** (rama `feat/paginas-legales`,
> último commit `ecbaf07`). No es un plan aspiracional: cada "✅" está verificado en el repo.
>
> **Cómo usarlo:** lee §0 (tamaño), §1 (tabla resumen) y **§7 (evaluación final y plan por
> fases)**. Los 35 capítulos son la referencia de detalle, no una lista de tareas en orden.
>
> **Actualizado el 2026-07-29** con la lectura de los 4 volúmenes del *Manual Maestro SaaS IA
> para WhatsApp*: ver **§7**, que añade 8 hallazgos nuevos y **reemplaza el plan de §4**.
>
> **Lee antes:** [CLAUDE.md](CLAUDE.md) (reglas de trabajo) y [ARQUITECTURA.md](ARQUITECTURA.md)
> (arquitectura objetivo). Este documento no los reemplaza: los complementa midiendo la distancia.

---

## 0. TAMAÑO REAL DEL PROYECTO (medido, no estimado)

| Pieza | Archivos | Líneas |
|---|---|---|
| Backend TypeScript (`server/src`) | 99 | 26.672 |
| Pruebas del backend (`server/tests`) | 97 | 22.033 |
| SQL (esquema + 32 migraciones + seeds) | 34 | 15.578 |
| Panel del cliente (`apps/client/src`) | 33 | 5.221 |
| Panel admin (`apps/admin/src`) | 26 | 3.820 |
| UI compartida (`packages/ui/src`) | 26 | — |
| Documentación (`*.md` en la raíz) | 8 | 1.304 |
| **Total de código de producto** | **~315** | **~73.000** |

**Base de datos:** 30 tablas · 43 índices · 37 funciones/RPC PostgreSQL · RLS activado en 30 tablas.
**Pruebas:** ~786 casos en Vitest + E2E Playwright (Chromium) · CI en 4 jobs.
**Rutas HTTP:** 22 routers montados en [server/src/index.ts](server/src/index.ts).
**Servicios de dominio:** 32 en [server/src/services/](server/src/services/).
**Repositorios de datos:** 20 en [server/src/db/repositories/](server/src/db/repositories/).

**Traducción honesta del tamaño:** esto ya **no** es un proyecto pequeño. Es un SaaS
multi-tenant real de tamaño medio, con una capa de pruebas por encima del promedio de la
industria para su etapa (0,83 líneas de test por línea de producción) y una capa de datos
inusualmente sólida (atomicidad en PostgreSQL, no en JavaScript). Sus huecos **no** están
en la lógica de negocio: están en **operación** (backups, logs, despliegue, recuperación).

---

## 1. TABLA RESUMEN DE LOS 35 CAPÍTULOS

Leyenda: ✅ hecho · 🟡 parcial · ❌ no existe · 🚫 no se debe hacer ahora

| # | Capítulo | Estado | Veredicto para esta etapa |
|---|---|---|---|
| 1 | Visión y objetivos | 🟡 | Documentar (1 hora, sin código) |
| 2 | Arquitectura general | 🟡 | Faltan diagramas |
| 3 | Clean Architecture | 🟡 | 🚫 No migrar. Ya hay 3 capas que funcionan |
| 4 | Domain-Driven Design | 🟡 | Solo glosario + mapa de contextos |
| 5 | Patrones de diseño | ✅ | Ya se usan 8 patrones. Solo documentar |
| 6 | Backend Node + Express + TS | ✅ | Falta Zod + contrato de API |
| 7 | PostgreSQL avanzado | ✅ | Falta medir (EXPLAIN) y **backups** |
| 8 | Prisma ORM | ❌ | 🚫 No. Rompería RLS y las RPC |
| 9 | Redis | ❌ | 🚫 Esperar volumen |
| 10 | BullMQ | ❌ | 🚫 Ya hay cola durable en Postgres |
| 11 | Sistema de colas | 🟡 | **P0: el scheduler con `setInterval` es frágil** |
| 12 | WebSockets | ❌ | Primero bajar el polling (barato) |
| 13 | Multi-tenancy | ✅ | **Brecha: RLS sin políticas por tenant** |
| 14 | Autenticación y autorización | 🟡 | Falta reset de contraseña, 2FA, revocación |
| 15 | Seguridad OWASP | 🟡 | **P0: keys de negocios sin cifrar en BD** |
| 16 | WhatsApp Cloud API | 🟡 | **P0 comercial: migrar el número a Meta** |
| 17 | WhatsApp Flows | 🟡 | En obra. Falta cifrado RSA/AES del endpoint Meta |
| 18 | Agentes de IA | 🟡 | **P1: evals** (lo más rentable por esfuerzo) |
| 19 | Ingeniería de prompts | 🟡 | Falta versionado de prompts |
| 20 | Memoria conversacional | 🟡 | Falta compactación y retención |
| 21 | RAG y búsqueda | 🟡 | Solo catálogo. Falta RAG de documentos |
| 22 | Observabilidad | ❌ | 🚫 OTel/Grafana. **P0: Sentry + request-id** |
| 23 | Logging | ❌ | **P0: logger con nivel + `business_id`** |
| 24 | Testing | ✅ | Brecha: nadie ejecuta las RPC de verdad |
| 25 | CI/CD | 🟡 | Hay CI, no hay CD ni staging |
| 26 | Docker | ❌ | Útil para Postgres de pruebas, no para deploy |
| 27 | Kubernetes | ❌ | 🚫 No a esta escala |
| 28 | Alta disponibilidad | ❌ | Una instancia. Definir si hace falta HA todavía |
| 29 | Optimización de costos | 🟡 | Diagnosticado, sin aplicar (egress ~5,5 GB/mes) |
| 30 | Facturación | 🟡 | Se calcula y factura; **no se cobra** |
| 31 | Panel administrativo | ✅ | Falta auditoría de acciones del superadmin |
| 32 | Analítica y métricas | 🟡 | Métricas del negocio sí; **del SaaS no** (MRR/churn) |
| 33 | Roadmap de escalabilidad | 🟡 | Escrito, sin umbrales numéricos |
| 34 | Disaster Recovery | ❌ | **P0: el hueco más grave del proyecto** |
| 35 | Checklist de producción | ❌ | Escribirlo antes del primer cliente pagando |

**Conteo:** 7 ✅ · 18 🟡 · 10 ❌ · de los cuales **6 no se deben construir** (3, 8, 9, 10, 27 y la mitad de 22).

---

## 2. CAPÍTULO POR CAPÍTULO

### 1. Visión y objetivos del SaaS — 🟡

**Existe:** definición del producto y mercado en [CLAUDE.md](CLAUDE.md) §1; catálogo comercial
con 6 planes y límites reales en [server/src/config/plans.ts](server/src/config/plans.ts)
(Micro $25/50 contactos → Empresarial $899/4.000 contactos); calculadora de precios en el panel
admin ([apps/admin/src/features/calculator/Calculator.tsx](apps/admin/src/features/calculator/Calculator.tsx)).

**Falta:** cliente ideal (ICP) escrito, propuesta de valor por vertical (pizzería, hostal,
barbería, clínica), métrica norte (¿mensajes atendidos sin humano? ¿pedidos cerrados?),
justificación del precio contra el costo real por negocio (IA + WhatsApp + Supabase), y
criterio de "cuándo decimos no" a un cliente.

**Veredicto:** hacerlo ya, es una hora y sin código. Los planes existen pero nadie validó
que $25/mes cubra el costo de 50 contactos con IA.

**Prompt para Codex:** *"Lee `server/src/config/plans.ts` y `server/src/db/repositories/usage.ts`.
Calcula el costo variable real por negocio y por plan (tokens de IA por mensaje × mensajes del
plan + tarifa de WhatsApp) y dime en qué plan el margen es negativo."*

---

### 2. Arquitectura general — 🟡

**Existe:** [ARQUITECTURA.md](ARQUITECTURA.md) (163 líneas) con stack objetivo, estructura del
monorepo, reglas de capas y plan estrangulador; estructura documentada en CLAUDE.md §3.

**Falta:** diagramas. No hay ni uno. En concreto: (a) contexto — quién habla con qué (huésped →
WhatsApp → YCloud/Meta → Express → Supabase/IA); (b) contenedores — monorepo, server, 2 SPAs,
Postgres, Cloudinary; (c) **secuencia del mensaje entrante**, que es el corazón del sistema y hoy
solo se entiende leyendo 6 archivos (`webhooks.routes` → `inbound-webhook` → cola durable →
`webhook-inbox-worker` → `bot-entry` → `bot-conversation`).

**Veredicto:** el diagrama de secuencia del mensaje entrante es lo más valioso que puedes
agregar a la documentación hoy. Usa Mermaid en Markdown (se versiona, no se desactualiza como una imagen).

**Prompt para Codex:** *"Traza el recorrido completo de un mensaje de WhatsApp desde
`server/src/routes/webhooks.routes.ts` hasta la respuesta enviada por
`server/src/integrations/ycloud.ts`. Genera un diagrama Mermaid `sequenceDiagram` con cada salto,
incluyendo la cola durable, el debounce y el punto donde se decide IA vs modo menú. Añádelo a
ARQUITECTURA.md sin modificar el resto del archivo."*

---

### 3. Clean Architecture — 🟡 / 🚫

**Existe:** arquitectura por capas real y respetada: `routes/` (HTTP delgado) → `services/`
(lógica) → `db/repositories/` (datos), con la regla "ningún servicio ni ruta llama a
`sb.from(...)` directo" (CLAUDE.md §7) — verificada en 99 archivos. Inyección de dependencias
por parámetros en los servicios críticos ([webhook-inbox-worker.ts](server/src/services/webhook-inbox-worker.ts),
[whatsapp-flow-data-exchange.ts](server/src/services/whatsapp-flow-data-exchange.ts)), que es
exactamente lo que Clean Architecture busca: lógica testeable sin infraestructura.

**Falta (respecto a Clean pura):** capa de dominio con entidades y casos de uso, puertos e
interfaces explícitas, y modelos de dominio separados de las filas de la BD.

**Veredicto: 🚫 no migrar.** Ya tienes el 80% del beneficio con el 20% del costo. Clean pura
añadiría una capa de mapeo entre `snake_case` de Postgres y objetos de dominio en ~20
repositorios, a cambio de cero valor para el cliente. Lo único que sí conviene: escribir la
**regla de dependencia** como texto y que el CI la verifique (una ruta no puede importar
`db/repositories` salvo por el compositor).

**Prompt para Codex:** *"Escribe una prueba en Vitest que falle si algún archivo de
`server/src/routes/` importa directamente `../db/client` o llama a `sb.from(`, y si algún archivo
de `server/src/services/` importa `express`. Solo la prueba, sin tocar el código existente."*

---

### 4. Domain-Driven Design — 🟡

**Existe:** contextos delimitados de facto, bastante limpios: **conversación/bot**
(`bot-*.ts`), **dinero** (`money.ts` + `orders`/`order_items`), **hospedaje** (`lodging.ts`,
dominio deliberadamente separado de citas y pedidos — regla inviolable #9), **agenda**
(`bookings`), **facturación SaaS** (`billing`, `plans`, `usage`), **canales**
(`channel-resolution.ts`, `types/channels.ts`), **Flows** (12 archivos `whatsapp-flow-*`).

**Falta:** glosario de lenguaje ubicuo. Hoy convive `business` / negocio / cliente / tenant, y
"cliente" significa dos cosas distintas (el negocio que paga el SaaS y el comprador que escribe
al bot) — eso ya causa ambigüedad en el panel y en las conversaciones sobre el producto. Falta
también el mapa de contextos con las relaciones (quién depende de quién).

**Veredicto:** haz el glosario, no reestructures el código. La separación de contextos ya
existe y es buena.

**Prompt para Codex:** *"Extrae de `server/src/` y `server/schema.sql` todos los términos de
dominio y arma un glosario en Markdown de dos columnas: término del código (inglés/snake_case) ↔
término del negocio (español). Marca los términos ambiguos que significan dos cosas distintas
según el contexto."*

---

### 5. Patrones de diseño — ✅

**Existe (patrones ya aplicados, verificados en el código):**

| Patrón | Dónde |
|---|---|
| Repository | [server/src/db/repositories/](server/src/db/repositories/) — 20 repos por tabla |
| Adapter | [integrations/](server/src/integrations/) (YCloud, Meta, Telegram, Cloudinary) + adaptadores de canal en `bot-entry.ts` |
| Strategy | [ai.ts](server/src/services/ai.ts) (4 proveedores de IA), [whatsapp.ts](server/src/integrations/whatsapp.ts) (Meta vs YCloud por negocio) |
| Inyección de dependencias | `webhook-inbox-worker.ts`, `whatsapp-flow-data-exchange.ts`, `tunnel.ts` |
| Máquina de estados | [bot-menu-flow.ts](server/src/services/bot-menu-flow.ts) — menú estilo banco |
| Inbox durable + lease | `webhook_inbound_events` + `leaseWebhookEvents` + reintentos + dead-letter |
| Idempotencia por clave | `claim_webhook_event` con SHA-256 del evento |
| Fallo cerrado (fail-closed) | [bot-tags.ts](server/src/services/bot-tags.ts) — etiquetas conflictivas se descartan |

**Falta:** nada estructural. Solo que estos 8 patrones no están documentados en ningún lado, así
que un programador nuevo los redescubre leyendo código.

**Veredicto:** capítulo cerrado. Documentar cuando escribas el libro, no antes.

---

### 6. Backend con Node.js + Express + TypeScript — ✅

**Existe:** Express 4.19 + TypeScript estricto compilado a `server/dist`; 22 routers;
middleware de errores async tipado ([middleware/async.ts](server/src/middleware/async.ts));
cabeceras de seguridad ([middleware/security-headers.ts](server/src/middleware/security-headers.ts));
rate limit por ruta; validación de entorno **antes** de abrir el puerto
([config/environment.ts](server/src/config/environment.ts)); apagado ordenado con `SIGTERM`/`SIGINT`
([index.ts:133](server/src/index.ts#L133)); healthcheck en `/api/health`.

**Falta:** (a) **validación runtime con Zod** — hoy hay ~32 chequeos manuales tipo
`typeof x !== 'string'` dispersos, y ARQUITECTURA.md ya declaró Zod como objetivo; (b) contrato
de API (OpenAPI) — los paneles y el server acuerdan formas de datos solo por convención;
(c) versionado de rutas (`/api/v1`), que importa el día que un panel viejo quede cacheado en el
navegador de un cliente; (d) paginación consistente en listados (hoy `limit` fijo de 100).

**Veredicto:** Zod en los bordes públicos primero (webhooks, data-exchange de Flows, login), no
en todo el proyecto de golpe.

**Prompt para Codex:** *"Introduce Zod solo en `server/src/routes/whatsapp-flow-data-exchange.routes.ts`
y `server/src/routes/webhooks.routes.ts`: define esquemas para el cuerpo entrante y reemplaza los
chequeos manuales, manteniendo exactamente los mismos códigos de estado y mensajes de error que
esperan las pruebas actuales. Corre `npm test -w @botpanel/server` y no toques otras rutas."*

---

### 7. PostgreSQL avanzado — ✅ (con una brecha grave que no es de SQL)

**Existe (lo más fuerte del proyecto):** 30 tablas, 43 índices, **37 funciones PostgreSQL**.
La atomicidad no está en JavaScript, está en la base: `create_order_with_items`,
`create_sale_with_items`, `create_business_onboarding`, `create_booking_if_available`,
`create_lodging_request_if_available` (con lock por negocio + trigger anti-sobreventa),
`claim_webhook_event`. Restricción de exclusión de intervalos para reservas. **pgvector** con
`match_products` para RAG del catálogo. Permisos revocados a `anon`/`authenticated` y otorgados
solo a `service_role`.

**Falta:** (a) **backups** — la base vive en el plan free de Supabase, es decir **sin backups
diarios**; ARQUITECTURA.md lo marca como "no negociable con clientes reales" y sigue pendiente;
(b) nadie midió nada: cero `EXPLAIN ANALYZE`, no se sabe qué consulta duele; (c) sin
`pg_stat_statements` ni revisión de índices no usados; (d) `conversation_history` crece sin
política de retención ni particionado; (e) no hay pool de conexiones propio (se usa PostgREST vía
`supabase-js`), lo cual está bien hoy pero es un límite conocido a futuro.

**Veredicto:** el SQL está mejor que en la mayoría de SaaS de esta etapa. **El problema no es la
base, es que no tiene copia de seguridad.** Ver §34.

**Prompt para Codex:** *"Lee `server/schema.sql` y lista: (1) tablas sin índice en `business_id`,
(2) índices declarados que ninguna consulta de `server/src/db/repositories/` puede usar,
(3) tablas que crecen sin límite y no tienen política de limpieza. No modifiques SQL, solo reporta."*

---

### 8. Prisma ORM — ❌ / 🚫

**Existe:** nada de Prisma, y está bien. El acceso a datos va por `supabase-js` + RPC.

**Por qué NO migrar:** Prisma no habla el idioma de este proyecto. Perderías: las 37 funciones
PostgreSQL con locks (Prisma las llamaría como SQL crudo, sin ventaja), el modelo de permisos
`service_role`, y el multi-tenancy tal como está implementado. Ganarías tipos generados — que ya
tienes escritos a mano en 20 repositorios tipados. Es un refactor de meses con riesgo alto en el
núcleo de dinero, a cambio de comodidad.

**Lo que sí falta (y es la razón real por la que la gente quiere un ORM):** **migraciones
versionadas**. Hoy hay 32 archivos `migration-*.sql` en `server/` que se aplican **a mano** en el
panel de Supabase, sin numeración, sin orden garantizado y **sin registro de qué se aplicó en qué
base**. La consecuencia ya ocurrió: hay migraciones pendientes de aplicar en el entorno de
pruebas. Cuando existan dos entornos (staging + producción) o un segundo programador, esto rompe
algo con certeza.

**Veredicto:** 🚫 Prisma. ✅ **P0: un corredor de migraciones mínimo** (tabla
`schema_migrations` + prefijo numérico + comando `npm run migrate` idempotente).

**Prompt para Codex:** *"Diseña el cambio mínimo para versionar las migraciones de `server/*.sql`
sin renombrar lo ya aplicado: crea una tabla `schema_migrations(id, nombre, aplicada_en, hash)`,
un script `server/scripts/migrate.ts` que aplique en orden solo lo no registrado usando la
conexión de `server/src/db/client.ts`, y un `npm run migrate`. Propón cómo registrar como
'ya aplicadas' las 32 migraciones históricas sin re-ejecutarlas. Entrega el plan antes de escribir código."*

---

### 9. Redis — ❌ / 🚫

**Existe:** caché en memoria del proceso para configuración global
([services/settings.ts](server/src/services/settings.ts)) y estado del menú por conversación
(30 min, en memoria).

**Falta:** caché compartida entre instancias.

**Veredicto: 🚫 esperar** (CLAUDE.md §11 ya lo decidió). Con **una** instancia, la memoria del
proceso *es* la caché correcta: cero latencia de red, cero infraestructura, cero costo.
**Disparador para reconsiderar:** el día que corras 2 instancias — ahí la caché en memoria se
vuelve incoherente y el estado del menú se pierde según a qué instancia caiga el mensaje.
Anótalo como precondición de §28, no como tarea propia.

---

### 10. BullMQ — ❌ / 🚫

**Existe:** una cola durable **ya construida sobre PostgreSQL**: tabla `webhook_inbound_events`
con leases (`leaseWebhookEvents`), renovación de lease, reintentos con retroceso exponencial,
dead-letter y limpieza periódica — más un worker con inyección de dependencias
([webhook-inbox-worker.ts](server/src/services/webhook-inbox-worker.ts), 505+ líneas, con pruebas).

**Veredicto: 🚫 no migrar.** Ya resolviste el problema que BullMQ resuelve, sin añadir Redis. Tu
cola es más lenta que BullMQ y le da igual: procesa mensajes de WhatsApp, no ticks de bolsa.
**Disparador:** miles de trabajos por minuto o necesidad de varios tipos de cola con prioridades.

---

### 11. Sistema de colas — 🟡 (aquí sí hay una brecha P0)

**Existe:** cola de **entrada** completa (§10) — ningún webhook se pierde si el proceso muere a
mitad, y los duplicados se reclaman por SHA-256.

**Falta, y es serio:** los **trabajos programados** no son una cola, son cuatro `setInterval` en
[server/src/index.ts](server/src/index.ts#L300):

- facturación mensual cada 24 h,
- limpieza del inbox cada 24 h,
- expiración de sesiones de Flows cada 15 min.

Problemas concretos: (a) si el proceso reinicia a las 23:00, el `setInterval` de 24 h reinicia su
cuenta y **la facturación de ese día no corre**; (b) si algún día hay 2 instancias, **la
facturación corre dos veces**; (c) nadie sabe si corrió (no hay registro de ejecución ni alerta
si falla). Falta además cola de **salida** para el futuro (campañas, recordatorios) — pero eso es
posterior a Meta, según CLAUDE.md §11.

**Veredicto: P0 antes del deploy 24/7.** No hace falta infraestructura: basta una tabla
`scheduled_jobs` con "última ejecución exitosa" y que cada tarea verifique si le toca (idempotencia
por ventana de tiempo). Es el patrón que ya usas para webhooks.

**Prompt para Codex:** *"Revisa los `setInterval` de `server/src/index.ts` (facturación mensual,
limpieza de inbox, expiración de sesiones de Flows). Propón el cambio mínimo para que cada tarea
sea idempotente y registre su ejecución en una tabla, de modo que un reinicio no se salte la
facturación y dos instancias no la dupliquen. Respeta CLAUDE.md: nada de Redis ni dependencias
nuevas. Plan primero."*

---

### 12. WebSockets — ❌

**Existe:** polling desde los paneles: conversaciones cada 3 s (hasta 100 mensajes completos),
verificación de cambios cada 5 s, nuevas reservas cada 12 s.

**Falta:** empuje del servidor al panel.

**Veredicto:** no empieces por WebSockets. El problema real de hoy no es la latencia, es el
**egress** (~5,5 GB/mes en plan free, con el panel abierto y sin subir archivos). El arreglo barato
está ya diagnosticado en CLAUDE.md §11: bajar el polling a ~10 s + **pausar con Page Visibility
API** cuando la pestaña no está visible → corta 70-80% con riesgo mínimo. Realtime/WebSockets
cuando el volumen lo justifique.

**Prompt para Codex:** *"En `apps/client/src/features/conversations/`, baja el intervalo de
`loadConversations` de 3 s a 10 s y pausa todo sondeo cuando `document.visibilityState !== 'visible'`,
reanudando con una recarga inmediata al volver. No cambies el contrato de la API ni otras pantallas."*

---

### 13. Multi-tenancy — ✅ (con una brecha de defensa en profundidad)

**Existe:** el pilar del proyecto. `business_id` en todas las tablas; en endpoints de cliente
sale **siempre** del JWT (`req.user.businessId`), nunca de un parámetro; resolución de negocio
por canal exacto (`provider`, `identifier_type`, `canonical_identifier`) sin comparar sufijos de
teléfono; `activeClientGuard` revalida cada 15 s que usuario y negocio sigan activos y reemplaza
rol/permisos por los actuales; pruebas dedicadas (`tenant-integrity-migration.test.js`,
`security.test.js`); medición de consumo por negocio (`usage`) y planes con límites.

**Brecha real:** **RLS está activado en 30 tablas pero no hay una sola `CREATE POLICY`.** El
modelo actual es "denegar a todos, permitir solo a `service_role`" — y `service_role` **ignora
RLS**. Es decir: el aislamiento entre negocios lo garantiza **el código de la aplicación, y solo
él**. Es una decisión coherente (el frontend nunca habla con Supabase, regla inviolable #2), pero
significa que **un bug en un `where` puede cruzar datos entre negocios sin que la base lo impida**.
No hay segunda línea de defensa.

**Veredicto:** no es urgente hoy (un solo servidor, código revisado, pruebas de aislamiento),
pero es la pregunta que te hará el primer cliente con datos sensibles. Opción incremental:
políticas por tenant + una conexión sin `service_role` que fije `app.business_id` para las
lecturas del panel, empezando por las tablas más sensibles (`conversation_history`, `sales`).
Requiere **arquitecto-saas** antes de tocar nada.

**Prompt para Codex:** *"Sin modificar código, audita el aislamiento: lista todas las funciones de
`server/src/db/repositories/` que consultan una tabla con columna `business_id` **sin** filtrar por
ella, y todas las rutas de `server/src/routes/` que toman un `business_id` del body/query/params en
vez del JWT. Reporta archivo y línea."*

---

### 14. Autenticación y autorización — 🟡

**Existe:** JWT 7 días para admin y cliente ([routes/auth.routes.ts](server/src/routes/auth.routes.ts)),
bcrypt, rate limit en login, roles (superadmin / dueño / empleado) con permisos granulares,
mínimo 12 caracteres en contraseñas nuevas, revalidación en vivo de sesión
(`activeClientGuard`: eliminar un usuario o suspender un negocio corta el acceso en ≤15 s en
lugar de esperar 7 días), pruebas de auth y de rutas.

**Falta:** (a) **recuperación de contraseña** — no existe ningún flujo; hoy el superadmin la
resetea a mano, lo cual no escala y no está documentado para el cliente; (b) refresh tokens y
rotación (un token robado vale 7 días); (c) revocación explícita por `jti` (el guard cubre
usuario/negocio inactivo, no "cerrar sesión en todos los dispositivos"); (d) **2FA para el
superadmin**, que hoy es la llave de todos los negocios; (e) registro de auditoría de accesos
(no existe la palabra `audit` en el backend); (f) bloqueo por intentos fallidos (solo hay rate
limit por IP).

**Veredicto:** P1. Recuperación de contraseña y 2FA del superadmin son las dos que un cliente
real nota. Va con **seguridad-saas**.

**Prompt para Codex:** *"Diseña (sin implementar) el flujo de recuperación de contraseña para
dueños y empleados: tabla de tokens de un solo uso con expiración, endpoints, envío por WhatsApp
o correo, y rate limit. Respeta: bcrypt, mínimo 12 caracteres, aislamiento por `business_id`, y
que ninguna API devuelva hashes. Entrega el plan y los riesgos."*

---

### 15. Seguridad OWASP — 🟡

**Existe:** firma HMAC de webhooks por negocio (`YCloud-Signature`) con
[webhook-signatures.ts](server/src/services/webhook-signatures.ts); deduplicación de eventos;
cabeceras de seguridad + CSP verificada por prueba (`panels-csp.test.js`); rate limit por ruta,
con cuidado explícito de que un tenant no bloquee a otro en Flows; límite de tamaño de cuerpo
(64 KB en data-exchange); saneamiento de datos de negocio antes de exponerlos al admin
([services/secrets.ts](server/src/services/secrets.ts)); arranque que **falla cerrado** si falta
configuración crítica; `security.test.js` + `security-headers.test.js`.

**Falta:** (a) **las credenciales de los negocios (keys de IA, tokens de WhatsApp) se guardan en
la base sin cifrar** — `secrets.ts` solo las *oculta al mostrarlas*, no las cifra en reposo. Si
alguien accede a la base, tiene las keys de todos tus clientes. Es la brecha de seguridad más
concreta del proyecto; (b) `npm audit` / Dependabot no están en el CI; (c) sin revisión formal
del OWASP Top 10 (IDOR sistemático, SSRF en descarga de media por URL, validación de tipo real de
archivos subidos con multer); (d) sin rotación de secretos ni procedimiento de credencial
comprometida; (e) sin política de retención/borrado de datos personales de conversaciones.

**Veredicto: (a) es P0**, y no es difícil: cifrado simétrico con una clave en entorno
(`SECRETS_KEY`) al escribir/leer las keys por negocio. (b) es media hora. El resto es P1 con
**seguridad-saas**.

**Prompt para Codex:** *"Propón el plan para cifrar en reposo las credenciales por negocio
(keys de IA, tokens de WhatsApp) que hoy se guardan en claro: dónde se leen y escriben hoy
(recórrelo desde `server/src/db/repositories/businesses.ts` y `server/src/services/secrets.ts`),
cómo cifrar con AES-256-GCM usando una clave de entorno, y cómo migrar los valores existentes sin
dejar el bot caído. No escribas código todavía."*

---

### 16. WhatsApp Cloud API — 🟡 (bloqueante comercial, no técnico)

**Existe:** doble proveedor con selección por negocio ([integrations/whatsapp.ts](server/src/integrations/whatsapp.ts)):
YCloud (principal hoy) y Meta Graph API con versión validada
([config/meta-graph.ts](server/src/config/meta-graph.ts), `v25.0`); envío de texto, imagen,
botones interactivos e indicador de escritura; recepción firmada, deduplicada y encolada; marcado
de lectura; resolución exacta de número → negocio.

**Falta (casi todo operativo, no de código):** número propio en Meta con verificación de negocio;
plantillas aprobadas (obligatorias para escribir fuera de la ventana de 24 h → precondición de
campañas y recordatorios); manejo del *quality rating* y los tiers de mensajería; webhook de
estados de entrega (enviado/entregado/leído/fallido) para saber si tus mensajes llegan; reintentos
tipificados ante errores de la Graph API; opt-in registrado por contacto.

**Veredicto:** **es el paso #1 del proyecto** según CLAUDE.md y la memoria del proyecto. Todo lo
demás de esta lista es secundario frente a "el bot habla por un número propio en Meta".

**Prompt para Codex:** *"Compara `server/src/integrations/ycloud.ts` con la ruta Meta de
`server/src/integrations/whatsapp.ts` y dime exactamente qué capacidades tiene YCloud que la
implementación Meta todavía no cubre (tipos de mensaje, plantillas, estados de entrega, errores).
Entrega una tabla de paridad y el orden de implementación. Solo lectura."*

---

### 17. WhatsApp Flows — 🟡 (en obra ahora mismo)

**Existe (rama actual, 49 archivos modificados o nuevos sin commitear):** 12 servicios
`whatsapp-flow-*`: plantillas por capacidad del negocio
([whatsapp-flow-templates.ts](server/src/services/whatsapp-flow-templates.ts): `order`,
`appointment`, `lodging`, `lead`, derivadas de `takes_orders` / `takes_bookings` /
`lodging_enabled`), generadores de JSON por capacidad, contratos, runtime, lanzador,
aprovisionador con verificación de borradores, métricas, expiración de sesiones cada 15 min, y
data-exchange con **validación y cálculo server-side** (el total no lo decide el Flow, lo decide
`money.ts`/las RPC — regla inviolable #8 respetada). Migración `migration-whatsapp-flows*.sql`,
repositorio `whatsapp-flows.ts`, pantalla de Flows en el panel admin, ~15 archivos de prueba.

**Falta:** (a) **cifrado RSA + AES-GCM del endpoint de data-exchange** — el propio código lo
documenta: el transporte del piloto es YCloud en JSON plano, y "un futuro adaptador Meta podrá
descifrar RSA/AES-GCM y llamar al mismo servicio". Meta **exige** ese cifrado, más el
health-check firmado del endpoint; (b) publicación y versionado de Flows en Meta (borrador →
publicado → deprecado); (c) prueba end-to-end con un Flow real en un número Meta; (d) el trabajo
está **sin commitear**: 49 archivos en el árbol, lo cual es un riesgo por sí solo.

**Veredicto:** cerrar y commitear lo que ya funciona con YCloud (con **revisor-pr**), y dejar el
adaptador Meta cifrado como la tarea que se hace junto con §16. La arquitectura ya está preparada
para eso, que es lo difícil.

**Prompt para Codex:** *"Lee `server/src/routes/whatsapp-flow-data-exchange.routes.ts` y
`server/src/services/whatsapp-flow-data-exchange.ts`. Diseña el adaptador de transporte Meta
(descifrado RSA-OAEP de la clave AES, AES-128-GCM del cuerpo, cifrado de la respuesta con el IV
invertido, y respuesta al health-check) que reutilice el servicio existente sin duplicar
validaciones ni cálculo de totales. Plan y puntos de fallo primero; no escribas código."*

---

### 18. Agentes de IA — 🟡

**Existe:** [ai.ts](server/src/services/ai.ts) multi-proveedor (OpenAI, Claude, Gemini, Groq) con
visión, audio y embeddings; "herramientas" propias por etiquetas `##TAG##` parseadas sin tocar la
base ([bot-tags.ts](server/src/services/bot-tags.ts)) y ejecutadas con aislamiento por negocio
([bot-actions.ts](server/src/services/bot-actions.ts)); etiquetas mutuamente excluyentes con fallo
cerrado; detector de suplantación de resúmenes oficiales (la IA imitando una cotización con datos
inventados se descarta y deriva); **modo menú sin IA** ([bot-menu-flow.ts](server/src/services/bot-menu-flow.ts))
donde el código conduce toda la conversación; derivación a humano (`##HANDOFF##`).

**Falta:** (a) **evals** — CLAUDE.md §11 ya los identificó como "la capa que más paga por
esfuerzo" y siguen sin construirse: ~20 conversaciones doradas por tipo de negocio, verificando
automáticamente "¿inventó datos? ¿emitió la etiqueta correcta? ¿derivó cuando debía?";
(b) validador de precios en salida (todo `$X` que escriba la IA comparado contra el catálogo
real); (c) *function calling* nativo en lugar de etiquetas de texto (menos frágil, pero es un
cambio grande y las etiquetas hoy funcionan); (d) fallback automático entre proveedores y
timeouts/reintentos explícitos por proveedor; (e) costo en dólares por negocio (hoy se miden
mensajes, no tokens).

**Veredicto:** **evals es la mejor inversión técnica disponible en todo este documento**
(centavos por corrida, detecta regresiones de prompt y de modelo antes de una demo).

**Prompt para Codex:** *"Diseña `npm run evals` para el server: un archivo de conversaciones
doradas por tipo de negocio (pizzería, hostal, barbería) con el mensaje del cliente y las
aserciones esperadas (etiqueta emitida, si debía derivar, montos permitidos). Debe llamar al flujo
real de `bot-conversation.ts` con negocios de prueba y reportar fallos sin depender de la BD de
producción. Propón la estructura y el formato de los casos antes de escribir código."*

---

### 19. Ingeniería de prompts — 🟡

**Existe:** [prompt.ts](server/src/services/prompt.ts) compone catálogo real, políticas del
negocio, variables, horario de Ecuador, fecha de hoy y calendario de 7 días (para que el modelo no
haga aritmética de fechas) y reglas técnicas; prompt editable por negocio desde el panel
([BotPrompt.tsx](apps/client/src/features/settings/BotPrompt.tsx)); skill `prompts-de-bots` con la
estructura estándar; plantillas por tipo de negocio en el onboarding.

**Falta:** versionado del prompt (histórico + rollback: hoy si un dueño empeora su prompt, no hay
vuelta atrás), comparación A/B, biblioteca por vertical mantenida como dato y no como texto libre,
y medición de calidad — que es imposible sin §18.

**Veredicto:** el versionado es una columna y una tabla; hazlo cuando toques esa pantalla.

**Prompt para Codex:** *"Propón el cambio mínimo para versionar el prompt por negocio: tabla
histórica con `business_id` + RLS, guardar versión anterior al editar, y un botón de 'restaurar
versión' en `apps/client/src/features/settings/BotPrompt.tsx`. Sigue las reglas de base-de-datos
de CLAUDE.md. Plan primero."*

---

### 20. Memoria conversacional — 🟡

**Existe:** historial persistido por contacto y negocio
([conversation-history.ts](server/src/db/repositories/conversation-history.ts), últimos **24**
mensajes al prompt); sesiones con modo manual, estado y lectura
([sessions.ts](server/src/db/repositories/sessions.ts)); debounce y agrupación de mensajes rápidos
con ventana durable en base ([bot-entry.ts](server/src/services/bot-entry.ts) +
`migration-agrupado-webhooks.sql`); estado del menú por conversación (30 min).

**Falta:** (a) compactación/resumen de conversaciones largas — al pasar de 24 mensajes el contexto
antiguo simplemente se cae, sin resumen; (b) memoria de largo plazo del comprador (preferencias,
"lo de siempre"); (c) política de retención y borrado (el historial crece para siempre: costo +
exposición de datos personales); (d) el estado del menú vive **en memoria del proceso**: un
reinicio deja al cliente a medio flujo sin contexto.

**Veredicto:** (d) es la más barata y la que un cliente nota; (c) es la que un cliente *pregunta*.

**Prompt para Codex:** *"Lee `server/src/services/bot-menu-flow.ts` y dime exactamente qué estado
vive en memoria del proceso, qué pasa con una conversación a mitad de flujo si el server
reinicia, y cuál es el cambio mínimo para persistirlo por `business_id` + contacto respetando el
TTL de 30 minutos. Solo análisis y plan."*

---

### 21. RAG y búsqueda — 🟡

**Existe:** pgvector + `match_products` + `text-embedding-3-small`; embeddings por producto con
reindexación desde el panel; consultas del catálogo aisladas por negocio.

**Falta:** (a) RAG de **documentos** del negocio (FAQ, políticas, menús en PDF) — hoy solo se
buscan productos; (b) chunking y solapamiento; (c) reranking; (d) umbral de similitud calibrado
con casos reales; (e) fallback léxico cuando el vector no encuentra nada (búsqueda por texto);
(f) medición de recall (¿cuántas veces el bot no encontró un producto que sí existía?).

**Veredicto:** el fallback léxico y el umbral son los que evitan el "no tengo ese producto"
cuando sí lo hay. RAG de documentos: cuando un cliente traiga un PDF de políticas.

**Prompt para Codex:** *"En `server/src/db/repositories/products.ts` y el flujo que lo consume,
añade un respaldo léxico: si `match_products` devuelve menos de N resultados sobre el umbral,
buscar por coincidencia de texto en nombre y descripción filtrando por `business_id`. Mantén el
contrato de retorno actual y agrega pruebas."*

---

### 22. Observabilidad (OpenTelemetry, Prometheus, Grafana) — ❌

**Existe:** `/api/health` y nada más. Sin trazas, sin métricas, sin identificador de petición.

**Falta:** todo. Pero **no todo hace falta**.

**Veredicto:** 🚫 OpenTelemetry + Prometheus + Grafana a esta escala es operar tres sistemas más
para mirar un servidor. **P0 en su lugar:** (a) **Sentry** (ya está en el plan de
ARQUITECTURA.md) — errores con contexto en vez de `console.error` que nadie lee; (b) **request-id**
propagado y añadido a cada log; (c) cuatro contadores en `/api/health` o un endpoint interno
(mensajes procesados, fallos de IA, tamaño de la cola, dead-letter) — la cola con eventos
atascados es exactamente lo que quieres saber sin que un cliente te lo diga; (d) una alerta de
caída (uptime externo). Grafana el día que haya más de un servicio.

**Prompt para Codex:** *"Propón el mínimo de observabilidad para un monolito Express en Railway:
integración de Sentry en `server/src/index.ts` con el `business_id` como etiqueta (sin filtrar
datos personales ni credenciales), middleware de `request-id`, y un endpoint interno protegido con
contadores de mensajes procesados, fallos de IA y estado de la cola de webhooks. Plan primero,
sin dependencias innecesarias."*

---

### 23. Logging — ❌

**Existe:** 98 llamadas a `console.*` en `server/src` (63 `error`, 24 `log`, 11 `warn`) con emojis
según el estilo del proyecto.

**Falta:** niveles reales, formato estructurado (JSON) legible por máquina, **`business_id` y
`request_id` en cada línea** (hoy es imposible reconstruir qué le pasó a un negocio concreto),
redacción automática de credenciales y datos personales, y control de verbosidad por entorno.

**Veredicto: P0, y es de las más baratas del documento.** Un módulo `lib/logger.ts` de ~40 líneas
que mantenga el estilo con emojis pero añada nivel + contexto, y sustitución gradual de los
`console.*` empezando por el flujo del bot. Sin dependencias: `console.log(JSON.stringify(...))`
alcanza.

**Prompt para Codex:** *"Crea `server/src/lib/logger.ts`: niveles (debug/info/warn/error), salida
JSON en producción y legible con emojis en desarrollo, campos obligatorios `business_id` y
`request_id` cuando existan, y redacción de claves cuyo nombre contenga token/key/secret/password.
Después reemplaza los `console.*` **solo** en `server/src/services/bot-conversation.ts` y
`bot-entry.ts` como piloto, y corre las pruebas."*

---

### 24. Testing (unitario, integración y E2E) — ✅ (con una brecha concreta)

**Existe:** 97 archivos de prueba, ~786 casos, Vitest; E2E con Playwright (login, navegación,
permisos, responsive) sin necesitar BD ni secretos; 4 jobs de CI que bloquean el merge; pruebas
dedicadas a lo que importa: atomicidad de dinero, aislamiento entre tenants, seguridad, CSP,
firmas de webhooks, deduplicación, calendario.

**Falta:** (a) **las pruebas de atomicidad verifican el *texto* del SQL, no su comportamiento** —
por ejemplo `orders-atomicity.test.js` hace `expect(schema).toContain('create or replace function
public.create_order_with_items')`. Eso detecta que alguien borró la función, pero **nadie ejecuta
jamás las 37 funciones PostgreSQL** contra una base real: si una tiene un error lógico de
concurrencia, ninguna prueba lo nota; (b) sin pruebas HTTP de integración reales (no hay
supertest; las rutas se prueban con dependencias inyectadas, que es bueno pero no cubre
middleware, orden de rutas ni serialización); (c) sin cobertura medida; (d) sin evals de IA (§18);
(e) sin pruebas de carga (nadie sabe cuántos negocios aguanta una instancia).

**Veredicto:** la suite es mejor que la de la mayoría de proyectos de esta etapa. La brecha (a) es
la que importa: **es tu núcleo de dinero y anti-sobreventa el que no se ejecuta en las pruebas**.
Aquí sí vale Docker (§26): Postgres local + aplicar `schema.sql` + probar las RPC en concurrencia.

**Prompt para Codex:** *"Diseña una suite de integración que ejecute de verdad las RPC críticas
(`create_order_with_items`, `create_booking_if_available`, `create_lodging_request_if_available`)
contra un Postgres desechable con `server/schema.sql` aplicado, incluyendo un caso de concurrencia
que intente sobrevender la última habitación desde dos conexiones simultáneas. Debe poder saltarse
sola si no hay Postgres disponible, para no romper el CI actual. Plan y estructura primero."*

---

### 25. CI/CD — 🟡

**Existe:** [.github/workflows/ci.yml](.github/workflows/ci.yml) con 4 jobs (lint+tipos+tests del
server, build del panel cliente, build del panel admin, E2E con Chromium), caché de npm,
plantilla de PR, [CONTRIBUTING.md](CONTRIBUTING.md); [railway.json](railway.json) con healthcheck
y política de reinicio.

**Falta:** la **D** de CD. (a) Sin despliegue automático ni versionado de releases; (b) sin
entorno de **staging** — hoy lo que se prueba es local y lo que se ve es producción; (c) las
migraciones no forman parte de ningún pipeline (§8); (d) sin `npm audit`/Dependabot; (e) sin
cobertura reportada; (f) sin rollback definido ("¿qué hago si el deploy sale mal?" no está escrito);
(g) conviene verificar que la protección de rama en `main` esté realmente activada en GitHub.

**Veredicto:** staging + rollback documentado son P0 del deploy 24/7. El resto, P1.

**Prompt para Codex:** *"Añade a `.github/workflows/ci.yml` un job de `npm audit --audit-level=high`
que no bloquee el merge (continue-on-error) y reporte en el resumen. No modifiques los jobs
existentes."*

---

### 26. Docker — ❌

**Existe:** nada (Railway construye con RAILPACK desde el `npm run build` del monorepo).

**Falta:** imagen reproducible y, más útil, un `docker-compose` con **Postgres + pgvector** para
desarrollo y pruebas.

**Veredicto:** para *desplegar*, Railway ya funciona y Docker no aporta hoy. Para *probar*, Docker
es la pieza que desbloquea §24(a) — ejecutar las RPC de verdad. Ese es el motivo válido para
adoptarlo, y es prioridad media.

**Prompt para Codex:** *"Crea un `docker-compose.yml` de desarrollo con Postgres 16 + extensión
vector, que aplique `server/schema.sql` al arrancar, y documenta en 5 líneas cómo apuntar las
pruebas a esa base. No toques el despliegue de Railway ni `railway.json`."*

---

### 27. Kubernetes — ❌ / 🚫

**Veredicto: 🚫 no.** Kubernetes resuelve orquestar decenas de servicios y escalado automático
complejo. Tienes **un** proceso Node. Adoptarlo ahora te añade un trabajo de operación a tiempo
parcial y cero valor para el cliente. **Disparador realista:** varios servicios independientes
(workers, API, landing) con escalado distinto y un equipo que lo mantenga. Antes de Kubernetes
están, en orden: staging, backups, logs, dos instancias en Railway.

---

### 28. Alta disponibilidad — ❌

**Existe:** healthcheck + reinicio automático en Railway (3 intentos), apagado ordenado con
`SIGTERM`, cola durable que no pierde webhooks si el proceso muere, reintentos con dead-letter.
Es más de lo que parece: **el sistema ya tolera reiniciarse sin perder mensajes**.

**Falta:** (a) más de una instancia — y hoy **no puede haberla** sin arreglar antes §11
(facturación duplicada), §9 (caché y estado del menú en memoria) y el worker de webhooks
compartiendo proceso con la API; (b) el túnel Cloudflare sigue en el camino en desarrollo;
(c) sin objetivos declarados de disponibilidad (RTO/RPO) ni prueba de que un reinicio en pleno
pico no rompa nada.

**Veredicto:** con los primeros clientes, "una instancia que reinicia rápido y no pierde mensajes"
es una respuesta legítima. Lo importante es **saber** que 2 instancias hoy causarían facturación
doble — está anotado aquí para que nadie escale por accidente.

**Prompt para Codex:** *"Audita `server/src/index.ts` y lista todo lo que se rompería o duplicaría
si se corrieran 2 instancias del server en paralelo (trabajos programados, cachés en memoria,
estado del menú, worker de webhooks, túnel). Ordénalo por gravedad. Solo análisis."*

---

### 29. Optimización de costos — 🟡

**Existe:** diagnóstico hecho y documentado en CLAUDE.md §11 (egress ~5,47 GB/mes en plan free,
causado por el polling del panel; culpable histórico: lecturas que traían el vector `embedding`);
medición de consumo por negocio ([usage.ts](server/src/db/repositories/usage.ts) + pantalla de
Uso en el panel admin); planes con límites de contactos y mensajes.

**Falta:** aplicar lo diagnosticado. (a) Polling + Page Visibility (§12); (b) confirmar selects
mínimos del catálogo; (c) traer solo lo nuevo en conversaciones en vez de 100 mensajes completos;
(d) `reports.getAllReports` dispara ~8 lecturas idénticas de `getSalesWithItems` por carga —
deduplicar; (e) costo de IA en dólares por negocio (hoy se cuentan mensajes, no tokens);
(f) alertas de presupuesto; (g) elegir modelo de IA según plan (palanca que ya existe en el panel).

**Veredicto:** (a) y (d) son horas de trabajo y cortan la mayor parte del gasto. Vale la pena
antes del deploy, porque en producción el panel estará abierto todo el día.

**Prompt para Codex:** *"En `server/src/services/reports.ts`, `getAllReports` llama a
`getSalesWithItems` una vez por cada cálculo (~8 lecturas idénticas). Refactoriza para leer las
ventas una sola vez y pasarlas a cada cálculo, sin cambiar el resultado ni el contrato de la API.
Corre `npm test -w @botpanel/server`."*

---

### 30. Facturación — 🟡

**Existe:** repositorio de facturación ([billing.ts](server/src/db/repositories/billing.ts)),
catálogo de 6 planes con límites, generación automática de la cuota mensual
(`generateCurrentMonthBilling` cada 24 h), medición de consumo por negocio, rutas de superadmin
([admin-billing.routes.ts](server/src/routes/admin-billing.routes.ts)), pantalla de Facturación y
de Uso en el panel admin, migraciones `migration-facturacion-planes.sql` y
`migration-consumo-planes.sql`, pruebas de automatización.

**Falta:** **cobrar**. No hay pasarela (ni Stripe ni PayPhone/Kushki/Datafast): el sistema
*calcula* lo que se debe, y el cobro es manual fuera de la plataforma. Además: comprobantes o
facturas (y si vas a facturar en Ecuador, el asunto SRI/impuestos), suspensión automática por
impago (dunning), prorrateo al cambiar de plan a mitad de mes, y cobro de excedentes cuando un
negocio pasa su límite de contactos.

**Veredicto:** con pocos clientes, cobrar a mano es correcto y evita meses de integración. El
disparador es la cantidad de clientes, no la elegancia. Lo que sí conviene ya: **suspensión por
impago** (hoy alguien puede no pagar y seguir usando el bot indefinidamente).

**Prompt para Codex:** *"Lee `server/src/db/repositories/billing.ts` y el flujo de
`generateCurrentMonthBilling`. Dime qué pasa hoy si un negocio no paga: ¿algo lo suspende
automáticamente? Propón el cambio mínimo para marcar la cuota vencida y suspender el negocio tras
N días de gracia, reutilizando el `activeClientGuard` existente. Plan primero, con
arquitecto-saas en mente."*

---

### 31. Panel administrativo — ✅

**Existe:** panel de superadmin en React+Vite+TS con clientes y onboarding, herramientas por
cliente, facturación, uso/consumo, Flows, conexiones y verificación de canales, configuración
global con keys enmascaradas, simulador del bot persistido por negocio, calculadora de precios y
dashboard. 26 archivos, ~3.800 líneas, sobre `packages/ui` (24 componentes shadcn compartidos).

**Falta:** (a) **registro de auditoría de acciones del superadmin** — hoy nada queda anotado
cuando se cambia un plan, se toca una key o se suspende un negocio; con clientes reales eso es
"¿quién cambió esto?" sin respuesta; (b) búsqueda y paginación en listados (crecerán); (c) "ver
como cliente" seguro para soporte; (d) 2FA (§14); (e) vista de salud por negocio (¿su bot está
respondiendo? ¿su key sirve? ¿la cola tiene eventos atascados de ese negocio?).

**Veredicto:** (a) y (e) son las que convierten el panel en herramienta de operación y no solo de
configuración.

**Prompt para Codex:** *"Diseña una tabla de auditoría para acciones del superadmin (quién, qué,
sobre qué negocio, antes/después, cuándo) con RLS, y el punto único donde engancharla en
`server/src/routes/admin-*.routes.ts` sin repetir código en cada endpoint. Nunca debe guardar
credenciales en claro. Plan primero."*

---

### 32. Analítica y métricas — 🟡

**Existe (para el negocio cliente):** 7 reportes + dashboard + alertas
([services/reports.ts](server/src/services/reports.ts)), directorio de clientes, clientes
perdidos con razón automática, reactivación, ingresos por estadías, huecos de conocimiento del bot
(`ai_gaps`), consultas de productos, gráficos con Recharts sobre `packages/ui/chart`.

**Falta (para ti, el dueño del SaaS):** MRR, churn, activación (¿cuántos negocios llegaron a tener
su bot respondiendo?), retención, LTV/CAC, y el embudo que más importa —
**conversaciones → pedidos/reservas cerradas por negocio**, que es literalmente la prueba de que
tu producto funciona y tu mejor argumento de venta. También: uso por feature (¿alguien usa la
pestaña X?) y márgenes por negocio (costo de IA vs precio del plan).

**Veredicto:** P1, alto valor comercial y bajo riesgo técnico: los datos ya están en la base, falta
la consulta y la pantalla.

**Prompt para Codex:** *"Con los datos ya existentes (`businesses`, `billing`, `usage`,
`conversation_sessions`, `orders`, `bookings`), diseña un panel de métricas del SaaS para el
superadmin: MRR, negocios activos vs suspendidos, activación (negocios con al menos un pedido o
reserva del bot), y tasa de conversación→pedido por negocio. Define las consultas y respeta el
aislamiento: solo superadmin. Plan primero, con graficos-dashboard."*

---

### 33. Roadmap de escalabilidad — 🟡

**Existe:** CLAUDE.md §11 (módulos futuros con criterios de "no construir hasta que un cliente lo
pida") y ARQUITECTURA.md §2 (Redis/BullMQ/workers/Realtime "solo cuando el volumen lo pida"). Es
un roadmap **con freno**, que es lo raro y lo correcto.

**Falta:** los **números**. "Cuando el volumen lo pida" no es accionable. Faltan umbrales:
¿a cuántos mensajes por minuto se satura una instancia? ¿a cuántos negocios el polling agota el
egress de Supabase Pro? ¿a partir de qué punto la cola en Postgres deja de alcanzar? Nadie ha
medido nada (§24e), así que no hay forma de saber si el próximo cliente cabe o rompe el sistema.

**Veredicto:** una prueba de carga sencilla (N conversaciones simultáneas contra el flujo del bot,
midiendo latencia y saturación) convierte todo este capítulo de opinión en datos.

**Prompt para Codex:** *"Diseña una prueba de carga mínima para el flujo del bot: N webhooks
simultáneos hacia el endpoint entrante con negocios de prueba, midiendo latencia hasta la
respuesta, profundidad de la cola y errores. Debe poder correrse contra una instancia local sin
tocar producción ni gastar en IA (proveedor de IA simulado). Plan y métricas a reportar."*

---

### 34. Disaster Recovery — ❌ **(el hueco más grave del proyecto)**

**Existe:** tolerancia a reinicios del proceso (cola durable, idempotencia, apagado ordenado).
Eso cubre "el server se cayó", que es el desastre *pequeño*.

**Falta prácticamente todo el desastre grande:**

- **Sin backups.** Supabase plan free → **no hay copias diarias**. Si la base se corrompe, se
  borra por error o pierdes acceso al proyecto, se pierden **todos** los negocios, catálogos,
  conversaciones, ventas y reservas. ARQUITECTURA.md lo marcó como "no negociable con clientes
  reales" y sigue pendiente. **No hay ninguna otra tarea en este documento más urgente que esta.**
- Sin restauración probada (un backup que nunca se restauró no es un backup).
- Sin RPO/RTO declarados (¿cuántos datos aceptas perder? ¿cuánto puedes estar caído?).
- Sin export de datos por negocio (te lo pedirá el primer cliente que se vaya, o la ley).
- Sin procedimiento de credencial comprometida (rotar keys de IA/WhatsApp/JWT sin dejar el bot
  caído) — agravado porque las keys de los negocios están **sin cifrar** en la base (§15).
- Sin runbook de caída de terceros: ¿qué pasa si YCloud, Meta, OpenAI o Supabase se cae? Hoy: el
  bot deja de responder y nadie se enterará hasta que un cliente escriba.

**Veredicto: P0 absoluto, y la parte más importante cuesta $25/mes** (Supabase Pro) más una tarde
de escribir el procedimiento y **probar una restauración**.

**Prompt para Codex:** *"Escribe `RECUPERACION.md` con el plan de recuperación ante desastres de
este proyecto: inventario de dónde vive cada dato (Supabase, Cloudinary, variables de entorno de
Railway, secretos en `server_settings`), qué se pierde en cada escenario de fallo, procedimiento
de restauración paso a paso, RPO/RTO propuestos, y el procedimiento de rotación de credenciales
comprometidas. Marca claramente lo que hoy es imposible por falta de backups."*

---

### 35. Checklist final de producción — ❌

**Existe:** [DEPLOY.md](DEPLOY.md), [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md),
[PASOS-INSTALACION.md](PASOS-INSTALACION.md),
[CREDENCIALES-DONDE-CONSEGUIRLAS.md](CREDENCIALES-DONDE-CONSEGUIRLAS.md) — el *cómo* desplegar
está cubierto (338 líneas entre los dos de deploy).

**Falta:** el checklist de **go-live**: la lista que se marca una vez, antes del primer cliente
pagando. No es documentación de cómo desplegar, es la verificación de que puedes prometer un
servicio. Borrador en §38.

---

## 3. LOS 8 HUECOS QUE IMPORTAN (todo lo demás es secundario)

Ordenados por "qué tan mal la pasas si esto falla":

1. **Sin backups de la base** (§34) — riesgo de pérdida total, se arregla con $25/mes.
2. **El número no está en Meta** (§16) — bloqueante comercial; sin esto no hay campañas,
   recordatorios ni escala del canal.
3. **Keys de los negocios sin cifrar en la base** (§15) — una filtración expone las credenciales
   de todos tus clientes.
4. **Trabajos programados con `setInterval`** (§11) — la facturación puede saltarse un mes sin que
   nadie lo note.
5. **Sin logs útiles ni Sentry** (§22, §23) — cuando el bot de un cliente falle, no podrás
   reconstruir qué pasó.
6. **Migraciones sin versionado ni registro** (§8) — ya hay migraciones pendientes; con dos
   entornos, rompe.
7. **Las RPC de dinero y anti-sobreventa nunca se ejecutan en pruebas** (§24) — la lógica más
   crítica está verificada por coincidencia de texto.
8. **RLS activado pero sin políticas por tenant** (§13) — el aislamiento depende de una sola capa:
   el código.

Nota: **ninguno** de estos ocho es una feature. El producto está construido; lo que falta es
poder operarlo con clientes reales — exactamente lo que ya decía la nota estratégica de CLAUDE.md.

---

## 4. PLAN PRIORIZADO

### P0 — antes del primer cliente pagando (~1-2 semanas)

| # | Tarea | Cap. | Esfuerzo |
|---|---|---|---|
| 1 | Supabase Pro + **probar una restauración** + escribir `RECUPERACION.md` | 34, 7 | 1 día |
| 2 | Cifrar en reposo las keys por negocio (AES-256-GCM + migración) | 15 | 1-2 días |
| 3 | Logger con nivel + `business_id` + `request_id`, y Sentry | 23, 22 | 1-2 días |
| 4 | Trabajos programados idempotentes con registro de ejecución | 11 | 1 día |
| 5 | Corredor de migraciones con `schema_migrations` | 8 | 1 día |
| 6 | Cerrar y commitear el trabajo de Flows (49 archivos sueltos) con revisor-pr | 17 | medio día |
| 7 | Número en Meta + plantillas + estados de entrega | 16 | operativo |
| 8 | Checklist de go-live + rollback escrito + staging | 35, 25 | 1 día |

### P1 — primeros 3 meses con clientes

| # | Tarea | Cap. |
|---|---|---|
| 9 | **Evals del bot** (`npm run evals`) | 18 |
| 10 | Pruebas de integración que **ejecuten** las RPC (con Docker/Postgres) | 24, 26 |
| 11 | Bajar polling + Page Visibility + deduplicar `getSalesWithItems` | 12, 29 |
| 12 | Recuperación de contraseña + 2FA del superadmin | 14 |
| 13 | Auditoría de acciones del superadmin | 31 |
| 14 | Métricas del SaaS (MRR, activación, conversación→pedido) | 32 |
| 15 | Zod en los bordes públicos | 6 |
| 16 | Suspensión automática por impago | 30 |
| 17 | Diagramas (secuencia del mensaje entrante) + glosario de dominio | 2, 4 |

### P2 — cuando haya señal real (un cliente lo pide o el volumen lo exige)

Adaptador Meta cifrado de Flows (junto a §16) · políticas RLS por tenant · retención y compactación
de conversaciones · RAG de documentos · pasarela de pago · prueba de carga y umbrales de escala ·
Realtime/WebSockets · segunda instancia (requiere P0#4 y §9).

### 🚫 NO construir (decisión, no pendiente)

Prisma · Redis · BullMQ · Kubernetes · Clean Architecture pura · OpenTelemetry + Prometheus +
Grafana · microservicios.

Estos siete aparecen en el índice del libro porque son buenas prácticas **a otra escala**.
Adoptarlos hoy añade operación y riesgo sin beneficio para el cliente, y contradice la nota
estratégica de CLAUDE.md ("no construir de forma especulativa"). Cada uno tiene su disparador
escrito en su capítulo: cuando el disparador ocurra, se reevalúa.

---

## 5. BORRADOR DEL CHECKLIST DE GO-LIVE (cap. 35)

**Datos y recuperación**
- [ ] Supabase Pro activo con backups diarios
- [ ] Una restauración **realmente probada** y su tiempo medido
- [ ] `RECUPERACION.md` escrito, con RPO/RTO
- [ ] Export de datos por negocio posible

**Seguridad**
- [ ] Keys de negocios cifradas en reposo
- [ ] `JWT_SECRET` y credenciales de producción distintas de las de desarrollo
- [ ] Procedimiento de rotación de credenciales escrito
- [ ] `npm audit` sin vulnerabilidades altas
- [ ] 2FA del superadmin (o decisión consciente de aplazarlo)

**Canal**
- [ ] Número en Meta, negocio verificado
- [ ] Plantillas necesarias aprobadas
- [ ] Webhook de estados de entrega funcionando
- [ ] Prueba end-to-end con un teléfono real por cada capacidad (pedido, cita, hospedaje)

**Operación**
- [ ] Sentry recibiendo errores
- [ ] Logs con `business_id` en cada línea
- [ ] Alerta externa de caída
- [ ] Trabajos programados idempotentes y verificables
- [ ] Rollback escrito y probado una vez
- [ ] Staging separado de producción

**Negocio**
- [ ] Margen por plan verificado contra el costo real de IA + WhatsApp
- [ ] Suspensión por impago definida (automática o manual, pero decidida)
- [ ] Términos, privacidad y retención de datos publicados
- [ ] Onboarding del primer cliente ensayado de principio a fin

---

## 6. CÓMO MANTENER ESTE DOCUMENTO

- Revísalo cuando cambie el **estado** de algo, no cada semana.
- Al cerrar una brecha: cambia el estado del capítulo, tacha la línea del plan (§4) y anota la
  fecha. Si la solución fue distinta a la propuesta, escribe **por qué** — eso es lo que vale
  dentro de seis meses.
- Al decidir **no** hacer algo: déjalo en 🚫 con su disparador. Un "no" con motivo es información;
  un pendiente eterno es ruido.
- Este documento mide la distancia a un ideal de gran escala. Estar en 🟡 en 18 capítulos no es
  deuda: en varios es **la decisión correcta para la etapa**. El objetivo no es llenar de ✅, es
  que ningún ❌ te tome por sorpresa con un cliente pagando.

---

## 7. EVALUACIÓN FINAL CONTRA EL MANUAL MAESTRO (4 volúmenes)

> Añadido el **2026-07-29** tras auditar el proyecto contra los 36 capítulos de los volúmenes I-IV.
> **Este plan por fases reemplaza el de §4**, que se escribió sin los hallazgos de los volúmenes
> II-IV. Los capítulos de §2 siguen siendo la referencia de detalle.

### 7.1 Marcador por volumen

| Volumen | Qué mide | ✅ | 🟡 | ❌ | de los ❌: no construir |
|---|---|---|---|---|---|
| I — Fundamentos y backend | Cómo está construido | 7 | 0 | 3 | 3 |
| II — Integraciones, seguridad, IA | Cómo se comporta con el mundo real | 1 | 8 | 1 | 0 |
| III — Infra y DevOps | Cómo se opera | 1 | 4 | 5 | 3 |
| IV — Operación y producción | Cómo se sostiene el negocio | 2 | 2 | 2 | 0 |
| **Total (36 capítulos)** | | **11** | **14** | **11** | **6** |

**Lectura:** de los 11 capítulos vacíos, **6 no deben construirse**. Solo 5 faltan y hacen falta:
logging, mínimo de observabilidad, resiliencia de salida, disaster recovery y checklist de go-live.
El proyecto está **fuerte en construcción y en cero en operación**.

### 7.2 Hallazgos nuevos (no estaban en §2, verificados en código)

1. **Los envíos no tienen reintentos.** [ycloud.ts](server/src/integrations/ycloud.ts#L271) solo
   hace `catch` y sigue. El bot puede procesar todo bien y no contestar nunca, en silencio.
   La entrada es a prueba de balas; la salida no tiene red.
2. **Los límites de plan se miden pero no se aplican.** `recordOutboundUsage` registra cada envío
   ([whatsapp.ts:100](server/src/integrations/whatsapp.ts#L100)), pero `monthlyContactLimit` solo
   lo usan el panel admin y el onboarding: **nada en el camino del mensaje bloquea ni avisa**.
3. **No se procesan los estados de entrega.** [webhooks.routes.ts](server/src/routes/webhooks.routes.ts)
   solo encola mensajes entrantes; no escucha `statuses`. No sabes si tus mensajes llegan.
4. **Sin fallback de modelos.** Si el proveedor de un negocio falla o se queda sin saldo (ya pasó
   con DeepSeek en el hostal demo), ese bot deja de responder. No hay respaldo automático.
5. **No se registra el prompt ni el modelo por respuesta.** Imposible reconstruir por qué el bot
   dijo algo. Se guarda el mensaje, no la causa.
6. **Los embeddings dependen de OpenAI** aunque el negocio use Groq/Gemini/DeepSeek
   ([ai.ts:181](server/src/services/ai.ts#L181)): costo no atribuido y punto único de fallo.
7. **Hay límite de tokens de salida (60/500/800) y cero visibilidad de los de entrada.** El prompt
   inyecta el catálogo completo en cada mensaje: no sabes cuánto te cuesta ningún negocio.
8. **No hay canal de email en el sistema** ([notify.ts](server/src/services/notify.ts) solo tiene
   Telegram). Explica por qué no existe recuperación de contraseña: no hay por dónde enviarla.

**Corrección a §2 (cap. 24):** el E2E cubre **más** de lo documentado en CLAUDE.md — también prueba
Flows (borradores, publicación, habilitación), Facturación, Medición de uso, alta con capacidades
seguras, hospedaje separado de citas y permisos de empleados. El hueco es **Conversaciones**: la
pantalla más usada por los clientes es la única sin E2E.

**Confirmado correcto (cap. 21):** el RAG **sí** aísla por tenant —
`match_products(query_embedding, biz_id, match_count)` filtra por negocio dentro de la propia función.

### 7.3 Plan por fases (reemplaza §4)

Orden por riesgo, no por dificultad. Las fases 0-1 son "robustez"; las precondiciones de §7.4 son
"escalabilidad". Esfuerzos aproximados para un desarrollador.

**FASE 0 — No perder el negocio (~3 días)**

| # | Tarea | Cap. | Esfuerzo |
|---|---|---|---|
| 1 | Supabase Pro + **restauración probada** + `RECUPERACION.md` con RPO/RTO decididos | 34 | 1 día |
| 2 | Cifrar en reposo las keys de los negocios (AES-256-GCM + migración sin caída) | 15 | 1-2 días |
| 3 | Cerrar y commitear el trabajo de Flows (49 archivos sueltos) con revisor-pr | 17 | medio día |

**FASE 1 — Poder operar a ciegas nunca más (~1 semana)**

| # | Tarea | Cap. | Esfuerzo |
|---|---|---|---|
| 4 | Logger con nivel + `business_id` + `request_id` + redacción de secretos | 23 | 1 día |
| 5 | Sentry + alerta externa de caída | 22 | medio día |
| 6 | **Resiliencia de salida**: reintentos con backoff, circuit breaker y fallback de modelo | 11, 18, 28 | 2 días |
| 7 | Trabajos programados idempotentes con registro de ejecución | 11 | 1 día |
| 8 | Contadores mínimos: profundidad de cola, dead-letter, fallos de IA, latencia | 22 | medio día |

**FASE 2 — Que el negocio cobre lo que vende (~1 semana)**

| # | Tarea | Cap. | Esfuerzo |
|---|---|---|---|
| 9 | **Aplicar** los límites de plan (avisar al 80%, decidir qué pasa al 100%) | 13, 30 | 1-2 días |
| 10 | Suspensión automática por impago tras N días de gracia | 30 | 1 día |
| 11 | Tokens y costo en dólares por negocio → margen real por plan | 29, 32 | 1-2 días |
| 12 | Escuchar estados de entrega de WhatsApp (enviado/entregado/leído/fallido) | 16 | 1 día |
| 13 | Bajar polling a 10 s + Page Visibility + deduplicar `getSalesWithItems` | 12, 29 | 1 día |

**FASE 3 — El canal definitivo (operativo, en paralelo)**

| # | Tarea | Cap. |
|---|---|---|
| 14 | Número en Meta: verificación de negocio, plantillas aprobadas, opt-in | 16 |
| 15 | Adaptador Meta cifrado de Flows (RSA-OAEP + AES-128-GCM + health-check) | 17 |

**FASE 4 — No romper lo que ya funciona (~1 semana)**

| # | Tarea | Cap. |
|---|---|---|
| 16 | Corredor de migraciones con `schema_migrations` | 8 |
| 17 | Entorno de staging + deploy automático + smoke test + **rollback escrito** | 25 |
| 18 | Ejecutar de verdad las RPC en pruebas (Postgres desechable + caso de concurrencia) | 24, 26 |
| 19 | E2E de Conversaciones | 24 |
| 20 | `npm run evals` del bot (conversaciones doradas por vertical) | 18 |

**FASE 5 — Profesionalizar (cuando haya clientes, no antes)**

| # | Tarea | Cap. |
|---|---|---|
| 21 | Auditoría de acciones del superadmin | 31 |
| 22 | Métricas del SaaS: MRR, activación, conversación→pedido, costo por cliente | 32 |
| 23 | Recuperación de contraseña (requiere canal de email) + 2FA del superadmin | 14 |
| 24 | Zod en los bordes públicos | 6 |
| 25 | Retención/compactación de `conversation_history` + resumen automático | 7, 20 |
| 26 | Versionado de prompts + log de prompt/modelo por respuesta | 19, 23 |
| 27 | Políticas RLS por tenant (defensa en profundidad) — con arquitecto-saas | 13 |
| 28 | Prueba de carga → umbrales numéricos de escala | 33 |

### 7.4 Precondiciones de escala (no son tareas: son requisitos)

**Para correr una segunda instancia** hacen falta, obligatoriamente y antes:
(a) trabajos programados idempotentes (#7) — o la facturación se cobra dos veces;
(b) caché y estado del menú compartidos (hoy viven en memoria del proceso);
(c) worker de webhooks separado del proceso web.

Sin esas tres, escalar horizontalmente **rompe cosas que hoy funcionan**. La Etapa 2 del roadmap
del manual no la desbloquea un balanceador: la desbloquean estos tres arreglos.

Y una corrección al capítulo 33 del manual: medir escala por **número de clientes** engaña. Lo que
satura este sistema es el volumen de mensajes de **un** negocio grande, no tener 100 pequeños.
Nadie ha medido la capacidad de una instancia (#28), así que las cuatro etapas son literatura
hasta que exista esa medición.

### 7.5 Seguimiento visual (página viva)

La misma auditoría, en matriz visual con filtro por estado, barra de progreso y registro de avance:

- **Página publicada:** https://claude.ai/code/artifact/b3787c1f-7ff4-4bf0-b7f6-29b3c47e700f
  (privada; solo se comparte desde el menú de la propia página)
- **Fuente:** [ESTADO-Y-BRECHAS.html](ESTADO-Y-BRECHAS.html) en la raíz del proyecto

**Cómo actualizarla cuando algo pase a verde:**

1. Cambiar el estado del capítulo en `ESTADO-Y-BRECHAS.html` (la clase del bloque:
   `s-none` → `s-half` → `s-have`, y su `badge`), y actualizar el texto de *Tengo* / *Falta*.
2. Ajustar los cuatro conteos del encabezado, la barra de progreso (`11 / 29` y los `width` de los
   segmentos) y la fecha de "Actualizado".
3. Añadir la línea al **Registro de avance**: fecha, capítulo, qué lo cerró y —si la solución fue
   distinta a la propuesta— por qué.
4. Republicar **pasando la URL de arriba**, para conservar el mismo enlace en lugar de crear otro.
5. Reflejar el mismo cambio en §1 y en el capítulo correspondiente de §2 de este documento.

**La meta es 29, no 36.** Siete capítulos (Prisma, Redis, BullMQ, Kubernetes, Clean Architecture
pura, el stack de observabilidad y Docker para desplegar) están en rojo **a propósito**: dejarlos
así es el resultado correcto. Pintarlos de verde sería el error.

### 7.6 Definición de "robusto" (cómo saber que terminaste)

No es una sensación, son seis preguntas con respuesta verificable:

1. Si la base se borra hoy, ¿en cuánto tiempo vuelve y cuántos datos se pierden? → hay que poder
   responder con números **ya probados**, no estimados.
2. Si un cliente reclama algo de la semana pasada, ¿puedo reconstruir qué pasó? → logs con
   `business_id`.
3. Si YCloud, OpenAI o Supabase falla 10 minutos, ¿qué ve el cliente del negocio? → hoy: silencio.
4. Si el deploy sale mal, ¿cuál es el comando para volver atrás? → hoy: no está escrito.
5. ¿Cuánto me cuesta y cuánto me deja cada negocio? → hoy: desconocido.
6. Si un negocio se pasa de su plan, ¿qué ocurre? → hoy: nada.

Cuando las seis tengan respuesta, la plataforma es robusta. **La escalabilidad viene después y
sola**: con §7.4 resuelto, escalar es subir una réplica — no un rediseño.
