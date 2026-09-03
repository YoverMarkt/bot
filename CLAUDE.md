# CLAUDE.md — BotPanel SaaS

Guía obligatoria para trabajar en este proyecto sin romper la arquitectura ni el trabajo existente. Léela completa antes de actuar.

**Este archivo es lo que hay que tener en la cabeza SIEMPRE.** Lo demás vive
aparte y se consulta cuando la tarea lo toca — así esta guía se puede leer
entera de verdad, que era el problema cuando todo estaba junto:

| Documento | Cuándo leerlo |
|---|---|
| **[DECISIONES.md](DECISIONES.md)** | **Antes de tocar CUALQUIER pieza con historia** — la tienda, los comprobantes, el marketplace, los frenos de abuso, el motor de opciones, la salud del canal… Desde el 2026-08-25 vive aquí también el razonamiento de las 62 piezas que antes estaba en la sección 7 de este archivo. Casi cada apartado existe porque algo falló: lo que parece complejidad de más suele ser una cicatriz. |
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
   - Si el cambio abre una **rama nueva** de comportamiento (un modo, una configuración, un camino de entrada), aplica además **camino-real**: demuestra que la configuración REAL de producción llega hasta el código nuevo, y qué corre ANTES que podría ganarle. Cinco veces en este proyecto el CI estuvo verde sobre código al que nadie llegaba.
7. **REPORTAR** — Di qué archivos cambiaron, qué se verificó y qué **NO** se tocó.

> Ante la duda, para y pregunta. Es preferible una pregunta de más que romper algo que ya funcionaba.

---

## 1. QUÉ ES EL PROYECTO

> 📐 **Arquitectura objetivo y plan de migración:** ver **`ARQUITECTURA.md`** (decidido 2026-07-06: migración GRADUAL a monorepo con server ordenado en routes/services + paneles en React+Vite+TS; patrón estrangulador, nunca big-bang; regla: todo lo NUEVO nace en la estructura nueva). Leerlo antes de crear archivos o features nuevas.

**BotPanel** es un SaaS **multi-empresa** que ofrece bots de atención al cliente con IA en **WhatsApp y Telegram**. Sirve a negocios de comida y retail que reparten a domicilio: cada negocio tiene su propio bot (prompt, catálogo, horarios), su mini app, su panel de cliente, y un panel de administración central (el dueño del SaaS) gestiona todos los negocios, sus credenciales y la facturación. El bot responde texto, voz e imágenes, vende, y deriva a un humano cuando hace falta.

---

## 2. STACK OFICIAL (no se cambia sin pedido explícito)

> 🧾 **La lista de dependencias con sus versiones se retiró el 2026-08-29.**
> `package.json` la dice entera y siempre al día, mientras que una copia aquí
> envejece en silencio. Lo que NO dice el manifiesto —y por eso se queda— es
> la regla: **este stack está cerrado.** Node ≥ 22 + Express, Supabase con
> pgvector, JWT + bcrypt, WhatsApp por YCloud y Meta, Telegram por telegraf,
> React + Vite + TypeScript + Tailwind + shadcn/ui. Cambiar cualquiera de esas
> piezas —o añadir una sexta librería para algo que ya resuelve una de ellas—
> necesita **pedido explícito del dueño**, no la conveniencia de una tarea.

---

## 3. ESTRUCTURA DEL PROYECTO

> 🗂️ **El árbol de directorios y el índice de las 110 migraciones se retiraron
> de aquí el 2026-08-25.** Eran 165 líneas que un `ls` reconstruye en un
> segundo, y cada `.sql` ya lleva dentro su propia cabecera explicando qué
> hace y por qué — que es donde de verdad se lee. Costaban ~4.300 tokens en
> CADA sesión para decir lo que el repositorio dice solo.
>
> · Backend: `server/src/` (`db/` repositorios · `services/` lógica ·
>   `routes/` endpoints · `integrations/` proveedores externos).
> · Paneles: `apps/admin` (superadmin) · `apps/client` (dueño) ·
>   `apps/store` (mini app) · `packages/ui` (shadcn compartido).
> · Migraciones: `server/migration-*.sql`, en orden por fecha. `schema.sql`
>   es el consolidado vivo y **toda tabla o función nueva tiene que llegar
>   ahí** (lo vigila `verify:drift`).
>
> ⚠️ **Tres migraciones del canal se aplican EN ESTE ORDEN y no en otro**, que
> es lo único de la estructura que no se deduce mirando el repositorio:
> `migration-firmas-webhooks.sql` → `migration-inbox-webhooks.sql` →
> `migration-agrupado-webhooks.sql`. Cada una construye sobre la anterior, y
> aplicarlas al revés deja el canal a medias. Hay guardianes que comprueban
> que este orden siga escrito aquí, en el README, en PASOS-INSTALACION.md y
> en DEPLOY.md — si borras estas líneas, fallan.

- **La llave de tenant es `business_id`** (en código, `req.user.businessId`). Cuando estas reglas digan "client_id", en este proyecto es **`business_id`**.

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

> ⚠️ **«Desplegado» solo se dice después de `verify:deploy`.** El 2026-08-29
> cuatro despliegues se quedaron colgados en Railway y producción sirvió el
> código de la mañana durante horas — con un arreglo de DINERO entre lo que se
> creía en vivo, que el dueño descubrió probando la app. Engañó que
> `gh api deployments` los listaba: esa API devuelve el último despliegue
> **pedido**, no el que corre. Ahora `/api/health` informa del commit vivo y
> `npm run verify:deploy -w @botpanel/server -- <url>` lo compara con `HEAD`.
> **Comprobar que EXISTE un despliegue no es comprobar que su código CORRE.**


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
- **Telegram (`server/src/integrations/telegram.ts`):** el negocio se selecciona/restaura por `slug`; la restauración consulta únicamente el `business_id` más reciente de `tg_<chatId>` mediante la capa `src/db` y luego valida que el negocio siga activo. La integración no crea clientes Supabase propios. Texto, voz y fotos entregan siempre `{ channel:'telegram', ctx, slug }` a `bot-entry.ts`.
- **Dinero (`server/src/services/money.ts`):** calcula importes oficiales y las RPC revalidan negocio, producto, stock y precio. El flujo es manual: la plataforma registra el pedido y su entrega, pero no procesa ni registra el cobro del cliente.
- **Capacidades por negocio:** `businesses.takes_orders` es la fuente de verdad de si el bot cierra pedidos; el tipo solo la recomienda al crear y nunca sobrescribe decisiones manuales ni negocios existentes. En modo informativo se responden precios, descripciones, stock, fotos y videos; solo la intención transaccional explícita deriva y jamás crea pagos o pedidos.
- **Arranque seguro:** `server/src/config/environment.ts` valida antes de abrir el puerto las credenciales críticas, `BASE_URL`, el fallback opcional `YCLOUD_WEBHOOK_SECRET` si existe y el secreto Telegram cuando aplica. El signing secret de YCloud se guarda preferentemente por negocio y valida la cabecera `YCloud-Signature`. Producción falla cerrado en vez de publicar un healthcheck verde con configuración incompleta.
- **Contraseñas nuevas:** superadmin, dueños y empleados usan un mínimo de 12 caracteres; siempre se almacenan con bcrypt y nunca se devuelven en APIs.
- **Sesiones cliente vigentes:** `activeClientGuard` revalida cada 15 segundos como máximo que usuario y negocio sigan activos, y reemplaza rol/permisos del JWT por los valores actuales de la base. Eliminar un usuario, suspender un negocio o revocar permisos falla cerrado sin esperar siete días.
- **Túnel local (`server/src/services/tunnel.ts`):** solo se usa en desarrollo; inicia y detiene `cloudflared` mediante dependencias inyectables, expone únicamente estado serializable (`url`, `active`, `provider`, `startedAt`) y nunca filtra el proceso hijo en respuestas administrativas. En producción la URL pública sale de `BASE_URL`.
- **Grafo interno del servidor:** los módulos bajo `server/src/` se enlazan directamente entre `db`, `services`, `integrations`, `middleware` y `routes`; comandos, pruebas y Railway ejecutan el resultado compilado en `server/dist/`.
- **Nombres:** `camelCase` en TypeScript/JavaScript; columnas y tablas en `snake_case`.



> 📚 **Las decisiones de implementación se movieron a [DECISIONES.md](DECISIONES.md) el 2026-08-25.**
> Eran 92.700 caracteres —unos 23.000 tokens— cargándose en CADA sesión para
> explicar piezas que solo se tocan de una en una. **No se recortó una palabra**:
> están enteras allí. Consulta la que toque tu tarea ANTES de tocarla —
> cada una existe porque algo falló.

<details>
<summary>Índice de las 93 (búscalas por título en DECISIONES.md)</summary>

- El dueño escribe una BIENVENIDA, no un prompt
- Quedan DOS modos de atención
- Con qué modo NACE cada tipo
- Cómo pide cada tipo: cuánto hay que ELEGIR, no cuántos productos hay
- El alta pide OCHO campos, no veintiuno
- Un local nuevo NACE en el marketplace
- Un negocio puede no tener canal propio
- Un pedido a la vez, y MENÚ como salida
- Umbani es CERRADO: el comprobante no suelta el candado
- Tres situaciones, tres mensajes
- El comprobante que NO cuadra se rechaza solo
- Que pague OTRA persona va a REVISIÓN, y el cliente no se entera
- La cuenta del panel manda sobre todo
- El comprobante falso deja el pedido EXPIRADO
- Un bloqueo de local NO es un bloqueo de Umbani
- Se cuenta la RACHA, no el historial
- Las defensas son para TODOS los locales
- El pedido AVISA a la conversación, y quien se va avisando no paga la multa
- MENÚ mata todo proceso, y el recordatorio deja de mentir
- El local cerrado se ve, pero se ve CERRADO
- Cerrado dice CUÁNDO abre, y «23:59» es el final del día
- La mini app abría lenta, y una cabecera explicaba casi todo
- El bot reconoce a quien VUELVE, y nombra lo que no es texto
- Cuatro marcadores, y ninguno se puede confundir
- Dos puertas más en la mini app
- UNA SOLA definición de «bloqueado», y la mini app la respeta
- La bienvenida de Umbani, y la pantalla del bloqueado
- El panel del dueño y sus dos botones, con la misma regla
- El enlace del marketplace sale como BOTÓN, y el visto azul se marca
- El enlace es de UN SOLO USO: uno vivo a la vez
- «Seguir mi pedido» DEVUELVE el enlace
- Buscar sin IA
- El menú del marketplace
- «Hola» recibe la bienvenida, no un reproche
- Las opciones del chat salen del MISMO motor que la mini app
- El bloqueo de «un pedido a la vez» SE ACTIVA
- Rechazar el comprobante avisa al cliente
- El checkout dentro del chat
- WhatsApp puede mandar una UBICACIÓN
- Cómo se pide lo decide el TIPO del local, no cuántos productos tiene
- El carrito del menú sale de la memoria
- El canal de la plataforma
- La cola durable admite un mensaje sin local
- La conversación del marketplace
- Citas: RETIRADAS el 2026-08-16
- Hospedaje: RETIRADO el 2026-08-16
- Catálogo de arranque (`server/src/services/business-templates.ts`):
- El desplegable solo ofrece comida y retail
- Grupos de opciones:
- Motor universal de productos:
- Un doble toque no crea dos pedidos:
- Complemento incluido ≠ adicional independiente:
- El pago puede llegar por fuera de la app.
- El aviso que falla se reintenta
- El pedido sin pagar CADUCA SOLO
- Los avisos al cliente
- Lo que pidió el cliente se cuenta ENTERO y agrupado
- El pedido se queda con la dirección, no con un puntero.
- El mismo teléfono vive con y sin el `+`.
- Quien escribe por molestar tiene dos frenos, y son distintos a propósito
- El local del comprobante sale del PEDIDO, nunca del número
- El número de la plataforma NO se lo puede quedar un local
- Se retira el canal propio del panel
- Se retira CONVERSACIONES del panel del dueño
- El BLOQUEO sobrevive y se muda a Clientes
- El mínimo de compra y el tope por hora
- Nadie deja diez pedidos abiertos
- El bloqueo de PLATAFORMA
- El marketplace ya no responde sin límite
- Se puede bloquear a quien NUNCA compró
- El bloqueo alcanza al menú del marketplace
- El umbral de silencio pasa de 12 h a 24
- El superadmin mira el MARKETPLACE, no un bot por local
- Una sola decisión dice si un local existe para el cliente
- Lo que se retira del panel del superadmin
- El simulador prueba el MARKETPLACE
- El comprobante tiene HUELLA, y el duplicado se caza
- El comprobante se LEE, se puntúa y el dueño lo ve
- El comprobante que llega al NÚMERO DEL MARKETPLACE ya no se pierde
- El comprobante llega por el CHAT, y esa es ya la única puerta
- Una foto borrosa no cuesta una venta
- El comprobante NO es público:
- El alta no pregunta lo que se deduce del tipo
- El número del marketplace se verifica
- El alta por API estaba ROTA y nadie lo veía
- El dueño configura, la mini app obedece
- Los dos botones del pago NO hacen lo mismo
- Cuánto tarda el negocio
- Pedidos programados: RETIRADOS el 2026-08-07
- EL MARGEN SE SUMA AL PRECIO, no se le quita al dueño
- El horario puede CRUZAR LA MEDIANOCHE.
- Lo que gana la plataforma (`pricing_rules` + `calculate_platform_markup`):
- El acumulado y el cierre de mes (`platform_markup_summary`, `settle_month_commission`):

</details>

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
- **Qué pide el alta de un negocio** → [DECISIONES.md](DECISIONES.md#el-alta-no-pregunta-lo-que-se-deduce-del-tipo)
- **Verificar el número del marketplace** → [DECISIONES.md](DECISIONES.md#el-número-del-marketplace-se-verifica)
- **El alta por API y sus modos de chat** → [DECISIONES.md](DECISIONES.md#el-alta-por-api-estaba-rota-y-nadie-lo-veía)
- **El motor de opciones del catálogo** → [DECISIONES.md](DECISIONES.md#el-dueño-configura-la-mini-app-obedece)
- **Los dos botones del pago** → [DECISIONES.md](DECISIONES.md#los-dos-botones-del-pago-no-hacen-lo-mismo)
- **Cuánto tarda el negocio (prep_time)** → [DECISIONES.md](DECISIONES.md#cuánto-tarda-el-negocio)
- **Pedidos programados (retirados)** → [DECISIONES.md](DECISIONES.md#pedidos-programados-retirados-el-2026-08-07)
- **Cómo se suma el margen al precio** → [DECISIONES.md](DECISIONES.md#el-margen-se-suma-al-precio-no-se-le-quita-al-dueño)
- **Cortar un flujo (modos, atajos, `return` temprano)** → [cambios-seguros](.claude/skills/cambios-seguros/SKILL.md#cortar-un-flujo-el-inventario-de-lo-que-hacía-de-paso)
- **Construido y desconectado (el fallo que las pruebas no ven)** → [camino-real](.claude/skills/camino-real/SKILL.md)
---

## 8. HIGIENE DE GIT

### La regla de oro: **una sola rama viva, y es `main`**

Decidida el 2026-08-28, después de encontrar **132 ramas** acumuladas en el
remoto. Ninguna guardaba trabajo —todas eran de PRs ya fusionados— pero cada
una era una copia vieja del código esperando a confundir a alguien. La local
del último PR, por ejemplo, conservaba el `size-10` de las dianas, la utilidad
muerta que se había retirado y el `check` sin los tests de la tienda: **una
rama abandonada no protege trabajo, resucita decisiones ya revertidas.**

**El ciclo se cierra SIEMPRE, en el mismo turno:**

```
rama → trabajo → verificación → PR → CI en verde → merge → despliegue → comprobar en producción
```

Nada de «lo dejo en un PR y mañana veo». Un trabajo que no llegó a `main` no
está hecho, y a los tres días nadie recuerda en qué estado quedó.

- **Ramas de vida corta.** Nacen del `main` de hoy y mueren al fusionarse. Si
  una rama sobrevive más de un par de días, el problema es el tamaño del
  cambio: pártelo.
- **GitHub borra la rama al fusionar** (`delete_branch_on_merge`, activado el
  2026-08-28). No hay que acordarse de nada. Al terminar, `git fetch --prune`
  y borrar también la local.
- **Cada PR se fusiona o se cierra con su motivo escrito.** Un PR cerrado sin
  explicación es trabajo perdido que nadie sabe si hacía falta. El ejemplo a
  seguir es el #231: se cerró diciendo qué se rescataba (las tres guardas del
  ejecutor, ya en #272) y qué se descartaba por obsoleto — así, un mes después,
  se pudo borrar su rama con la certeza de no perder nada.
- **Un punto histórico es una ETIQUETA, no una rama.** El respaldo de WhatsApp
  Flows vive en `respaldo-whatsapp-flows`: una etiqueta es inmutable, no se
  trabaja sobre ella por error y no ensucia la lista de ramas.

⚠️ **Lo que MIENTE al comprobar si una rama se puede borrar** (aprendido a base
de equivocarse):
- `git branch --no-merged` marca como «sin fusionar» todo lo fusionado con
  **squash**, porque el commit resultante tiene otro SHA.
- `git diff main rama` cuenta además lo que `main` cambió **después**, así que
  una rama perfectamente fusionada aparenta tener «74 archivos que main no
  tiene».
- `git fetch` **no purga**: las referencias `origin/*` locales sobreviven a
  ramas borradas hace meses. Sin `--prune`, la lista local dice 10 cuando el
  remoto tiene 132.

**Lo que sí decide**, y solo esto: el estado del PR (`gh pr list --head <rama>
--state all`) o buscar su commit de squash en main
(`git log origin/main --grep="(#NNN)"`). Si el PR está `MERGED`, el código está
en `main` y la rama sobra; GitHub conserva sus commits en la pestaña del PR.

### Lo de siempre

- **Commits pequeños y descriptivos**, en español (ej: "fix: monto mensual no se guardaba al editar cliente").
- **Punto limpio antes de un cambio grande**: confirma que el árbol está estable o haz commit de lo pendiente primero.
- **NUNCA** `git reset --hard`, `git clean -fd`, ni borrar ramas sin **confirmación explícita** del usuario.
- **NUNCA** subir `server/.env` (ya está en `.gitignore`). Si una credencial entra al diff, deténte y avisa.
- Trabaja en rama si el cambio es grande; no commitees en `main` sin pedirlo.

### `main` está protegida, y se aplica también a los admins

Exige PR, los **seis** checks del CI en verde, estar al día con `main`, y
prohíbe force-push y borrado. No se debilita para «salir del paso»: si el CI
molesta, es que el CI está diciendo algo.

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
| Antes de dar por terminada una feature, un modo o una rama nueva; o ante un «está construido pero no responde» | **camino-real** |
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
