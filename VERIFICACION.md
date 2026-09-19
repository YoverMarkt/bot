# VERIFICACION.md — las capas que evitan que un fallo llegue al cliente

Movido de `CLAUDE.md` **sin cambiar una frase**.

Cada capa nació después de un incidente concreto. El diagnóstico de fondo
(2026-08-02) fue que **todos los guardianes se escribieron después de un
fallo**: la red dependía de que alguien se acordara, y nadie se acuerda de lo
que aún no ha visto romperse. Varias de estas invierten esa carga.

> ⚠️ Ninguna sustituye a otra. `verify:schema` comprueba que las funciones
> FUNCIONEN, `verify:drift` que producción SEA el archivo, y `verify:smoke`
> que la app RESPONDA. Las tres miran cosas distintas.

---

> ⚖️ **Presupuesto de tamaño de la tienda (`npm run size -w @botpanel/store`, job `Mini app de la tienda` del CI):** la mini app la abre el cliente final desde WhatsApp, con datos móviles y a menudo con mala señal; cada kilobyte se paga en gente que cierra antes de que cargue, y **una venta perdida así no deja rastro en ningún log**. Mide el gzip de lo que el navegador descarga para pintar la primera pantalla (`.js` + `.css` + `.html`; fuentes e imágenes quedan fuera porque llegan después y no bloquean). Hoy **76,0 kB** con un presupuesto de **82 kB**. ⚠️ **El margen de 6 kB está calibrado por DEBAJO de la librería más pequeña que querríamos cazar** (react-router son ~10 kB gzip): un presupuesto con más holgura que eso deja pasar justo lo que dice vigilar y solo da tranquilidad falsa. Verificado de verdad, no en teoría — se instaló `react-router-dom` y se envolvió la app: subió a **89,8 kB** y el CI habría fallado; se revirtió y volvió a 76,0. El presupuesto no premia adelgazar, solo impide engordar sin darse cuenta: si un cambio lo necesita, se sube el número a propósito y queda escrito en el historial quién decidió que valía la pena.
>
> 📊 **Cobertura con umbral (`npm run test:coverage -w @botpanel/server`, dentro del job `Lint + Tipos + Tests`):** mide qué líneas del servidor no ejecuta ninguna prueba. Hoy: **71% sentencias · 61% ramas · 66% funciones · 74% líneas**, y los umbrales están **por debajo** de eso a propósito — existen para que la cobertura no RETROCEDA, no para exigir una cifra bonita; un margen de uno o dos puntos evita que un refactor inocente rompa el CI sin haber empeorado nada. Se mide sobre `dist/` porque es lo que las pruebas cargan de verdad, y los sourcemaps devuelven la medida al TypeScript original. ⚠️ **No se lee como nota del proyecto:** los repositorios de `db/` salen bajos *a propósito* — son envoltorios finos de Supabase y probarlos sería probar el cliente de Supabase; lo que de verdad los verifica es `verify:schema`, que EJECUTA sus funciones contra PostgreSQL real. **El hallazgo que sí importó:** `storefront.routes.ts` estaba al **21%** — las pruebas comprobaban el CABLEADO (qué rutas existen, qué middleware llevan) pero jamás ejecutaban un manejador, así que nadie había hecho nunca un pedido por ahí… justo el camino que usa el cliente final desde su teléfono. Se añadieron pruebas de comportamiento (el precio que manda el teléfono se descarta, el negocio sale de la SESIÓN y no del slug de la dirección, `42501` se traduce a 403 y no a 500, el horario del dueño manda también aquí) y subió a **39%**. Quedan cortos `middleware/storefront.ts` (21%) e `index.ts` (0%, composición y arranque).
>
> 📒 **Ejecutor de migraciones (`npm run migrate:status` · `migrate:baseline` · `migrate`, en `server/tests/migraciones.mjs`):** las 34 migraciones del proyecto se corrían a mano en el editor SQL de Supabase y **nadie llevaba la cuenta**; olvidar una no avisa —la app responde 500 cuando el código busca una tabla que no existe— y ya pasó con las del hostal y las de la tienda. La tabla `schema_migrations` es el libro de cuentas: nombre, huella SHA-256 y cuándo se aplicó. Cada migración va en **su propia transacción** (PostgreSQL soporta DDL transaccional, así que una a medias no existe: o entra entera o no entra) y las anteriores quedan aplicadas si una falla. **La huella no es adorno:** editar un `.sql` ya aplicado —lo que la guía prohíbe— deja de cuadrar y el comando se niega a seguir; sin ella un archivo cambiado se ve idéntico a uno intacto. ⚠️ **`migrate:baseline` es una AFIRMACIÓN, no una comprobación:** marca migraciones como aplicadas **sin ejecutarlas**, que es lo único que permite adoptar el registro en una base que ya existe, pero si una nunca se corrió de verdad queda invisible para siempre. Por eso exige `--si`, acepta `--excepto=a.sql,b.sql` y remite a `verify:drift` antes. `migrate` se niega a correr si el registro está vacío y hay muchas pendientes: sería la señal de que nadie hizo el baseline. `migration-integraciones.sql` está en una lista de **jamás ejecutar** dentro del código (tiene el esquema viejo de tablas que ya no existen; aplicarlo hoy rompería la base) y no depende de que alguien se acuerde. Necesita `DATABASE_URL` —la conexión **directa** de Postgres, no `SUPABASE_URL`—, que es credencial de herramienta: vive en el `.env` local y **no hace falta en Railway**, porque el servidor nunca aplica migraciones solo (cuatro instancias significarían cuatro procesos corriendo el mismo DDL a la vez). Verificado de punta a punta contra un PostgreSQL real en Docker: los dos frenos, el baseline con exclusión, aplicar, el rechazo por huella y el rollback de una migración rota (ni la tabla ni el registro quedaron).
>
> 🐘 **Verificación contra PostgreSQL real (`npm run verify:schema -w @botpanel/server`, job `esquema` del CI):** levanta un PostgreSQL con pgvector, emula el entorno de Supabase (`server/tests/sql/bootstrap-supabase.sql` crea el esquema `extensions` con pgcrypto dentro y los roles `anon`/`authenticated`/`service_role`), aplica `schema.sql` **en una base vacía** y **EJECUTA** las funciones críticas con datos de prueba (`server/tests/sql/verificar-esquema.sql`): cola durable + trigger de consumo, registro de errores y su agrupación, cálculo del total de un pedido y su rechazo si el precio no cuadra, y creación de reserva. El CI además reintroduce a propósito el fallo de julio de 2026 y exige que la verificación salte: una verificación que deja de detectar es peor que ninguna. ⚠️ Es una **imitación** de Supabase, no Supabase: detecta migraciones rotas, funciones que revientan y contratos que no cuadran, pero no garantiza comportamiento idéntico en producción. Como `schema.sql` se aplica de cero, **toda tabla o función nueva debe añadirse también al consolidado**, no solo a su migración.
>
> 💾 **Respaldo de producción y su prueba (`npm run backup` · `npm run backup:verify`, en `server/tests/respaldo.mjs`):** ⚠️ **En el plan gratuito Supabase NO hace respaldos automáticos** — los diarios son de Pro en adelante, y su propia documentación recomienda a los proyectos gratuitos exportar por su cuenta. Hasta que existió esto, perder la base era perderlo todo. `backup` vuelca en formato `custom` con permisos locales `0600` (comprimido, y permite recuperar UNA tabla sin tragarse el volcado entero) y **acto seguido lo restaura en un PostgreSQL limpio y cuenta las filas**: un respaldo que nunca se restauró no es un respaldo, es un archivo del que nadie sabe nada. Falla si aparecen menos de 30 tablas o falta cualquiera de las cuatro tablas base núcleo (`businesses`, `products`, `orders`, `client_users`); admite que estén vacías porque una instalación nueva puede no tener filas todavía. ⚠️ Usa `pg_dump` **dentro de un contenedor** en vez del que haya en la máquina, porque un pg_dump más viejo que el servidor se niega a trabajar — y esa es la forma más común de descubrir que el respaldo no se puede hacer justo cuando hace falta. **La imagen es `pgvector`, no el postgres normal:** `products` guarda embeddings de 1536 dimensiones y sin esa extensión la tabla ni se crea. La imagen local no incluye `supabase_vault`: la restauración solo tolera sus tres errores exactos de extensión/tabla ausente y el cierre `errors ignored on restore: 3`, con `pg_restore` terminado normalmente en estado 1 y sin ninguna línea externa; cualquier otra salida, estado o señal falla. Los errores de las herramientas se capturan y sanean antes de mostrarse para que `DATABASE_URL` y su contraseña nunca lleguen al terminal o al CI. Necesita `DATABASE_URL`, la misma de las migraciones. ⚠️ Un respaldo en la misma máquina no protege de perder la máquina: hay que copiarlo fuera.
>
> 🚧 **Guardián de fronteras entre negocios (`server/tests/sql/verificar-fronteras.sql`, job `esquema` del CI):** responde la pregunta que ninguna otra comprobación respondía — *¿hay alguna tabla desde la que se pueda apuntar al dato de OTRO negocio?*. Busca el patrón exacto del fallo: una tabla con `business_id` con una foránea hacia otra tabla que **también** tiene `business_id`, sin incluir `business_id` en la pareja. Esa foránea comprueba «esa fila existe», no «esa fila es de este negocio», y como el negocio sale del JWT mientras el otro id viaja en la petición, ahí se cruza la frontera con un uuid ajeno. **Así estuvieron `product_variants.product_id` y `products.category_id` durante meses** sin que nadie los viera: el agujero existía, pero no había ninguna ruta que escribiera esas tablas — no había puerta. En cuanto se construyó la puerta (PR #132), se volvió real. ⚠️ **Ese es el punto:** antes la protección se ponía caso por caso y NADA comprobaba el caso siguiente. Acepta **dos** formas de cerrar cada frontera: una foránea **compuesta** sobre `(id, business_id)` —lo impide la base—, o una **RPC que compruebe pertenencia y lance `42501`**, y entonces se anota en el archivo diciendo qué función lo cierra. Hoy hay 10 anotadas (pedidos, ventas, direcciones, facturación…) y 2 cerradas por la base. Verificado creando una tabla nueva con el patrón: el CI para y explica cómo cerrarla. **Este guardián vigila la FORMA; `verificar-aislamiento.sql` vigila el COMPORTAMIENTO** ejecutando el intento con dos negocios reales — hacen falta los dos.
>
> 🔒 **Aislamiento multi-tenant contra PostgreSQL real (`server/tests/sql/verificar-aislamiento.sql`, mismo job del CI):** la regla #1 del proyecto estaba probada solo con simulacros; aquí conviven **DOS negocios reales** en la misma base y cada comprobación intenta ACTIVAMENTE cruzar la frontera, exigiendo que la base lo impida: el negocio A no puede vender ni facturar un producto de B (`create_order_with_items` y `create_sale_with_items` deben rechazar con `42501`), la búsqueda semántica de A nunca devuelve catálogo de B, el mismo `message_id_hash` en dos negocios se encola por separado (deduplicar sin mirar el negocio silenciaría al cliente de otro), la misma huella de error genera dos registros, y **borrar un negocio se lleva lo suyo y solo lo suyo** (verificado sobre productos, pedidos y errores del vecino). Un fallo aquí no es un bug: es un incidente de seguridad. Verificado quitando el filtro `business_id` de la RPC de pedidos y comprobando que salta `FUGA: el negocio A pudo crear un pedido con el producto de B`.
>
> 🔎 **Cobertura obligatoria de funciones (`server/tests/rpc-cobertura.test.js`):** el CI lee el código, encuentra cada `db.rpc()` y **falla si la verificación contra PostgreSQL real no la ejecuta**. Nació del 2 de agosto de 2026, cuando se descubrió que ningún cliente nuevo se podía crear: `create_business_onboarding` llevaba meses rota y era una de las 6 (de 20) que ninguna prueba tocaba. El problema de fondo no era el disparador, era que la verificación cubría *lo que alguien se acordó de añadir*, y nadie se acuerda de lo que aún no ha visto fallar. Este guardián invierte la carga: añade una función mañana y el CI te para hasta que la pruebes. ⚠️ Al medir la cobertura por primera vez salieron 10 funciones y resultaron ser **20** — la mitad se llaman con el nombre en la línea siguiente y el patrón ingenuo no las veía; un contador que miente por la mitad es peor que no contar, así que hay un test que vigila al extractor.
>
> 🔀 **Detector de deriva (`npm run verify:drift -w @botpanel/server`):** responde la pregunta que ninguna otra comprobación responde — *¿la base REAL es lo que dice `schema.sql`?*. El CI verifica que el archivo sea correcto, no que producción se le parezca: si se corre una migración y se olvida el consolidado (ya pasó con `platform_errors`), el CI sigue en verde verificando una ficción. Aplica `schema.sql` a un PostgreSQL limpio en Docker y **le pregunta a él** qué produjo —intentar parsearlo con expresiones regulares daba una lista donde faltaban `businesses` y `products`—, y lo compara contra el catálogo que PostgREST publica en `/rest/v1/`. Solo lectura, no toca producción, no corre en el CI (que no debe tener las llaves). ⚠️ Compara **nombres** de tablas, columnas y funciones: NO ve disparadores ni el cuerpo de las funciones, así que el fallo del 2026-08-02 habría pasado por aquí sin despeinarse. Vía descartada y anotada para que nadie la reintente: sondear funciones con `rpc(x, {})` no sirve — PostgREST devuelve el mismo `PGRST202` para una función que existe con argumentos y para una que no existe, y esa versión daba 25 falsos positivos.
>
> > 🔥 **Prueba de humo contra producción (`npm run verify:smoke -w @botpanel/server -- https://…`):** la única capa que mira la aplicación DE VERDAD. Las otras verifican simulaciones — `verify:schema` ejecuta sobre un PostgreSQL en Docker (una imitación de Supabase) y `verify:drift` compara nombres sin ejecutar nada. Entre ambas queda el hueco por donde caben los fallos de configuración: una variable de entorno ausente, un despliegue que no llegó, una credencial caducada; nada de eso lo ve el CI y es justo lo que deja la app muerta con todo en verde. Comprueba salud y cola de webhooks, que se sirvan los tres frontales, que la tienda exija sesión y que el enlace corto no filtre negocio, que el panel rechace sin token, y **da de alta un cliente y lo borra** — el camino que estuvo roto meses. ⚠️ **ESCRIBE EN PRODUCCIÓN**: crea UN negocio con nombre inequívoco (`ZZZ PRUEBA DE HUMO …`) y lo borra en el `finally`; si el borrado falla lo grita con el id para limpiarlo a mano. **Nunca manda mensajes de WhatsApp** (costaría dinero y gastaría el saldo del canal). `BASE_URL` va vacío en el `.env` local a propósito —para que el servidor levante su túnel—, así que la dirección se pasa por argumento o `SMOKE_URL`. Se lanza después de cada despliegue; no corre en el CI porque el CI no debe tener las llaves de producción.
>
> > 🛡️ **Guardián de migraciones (`server/tests/migraciones-guardian.test.js`):** revisa TODOS los `.sql` del proyecto —los de hoy y los que se escriban mañana— contra cinco reglas que fallan el CI: (1) ninguna función usa **pgcrypto** (`digest`, `crypt`, `hmac`, `gen_random_bytes`) con un `search_path` que no incluya `extensions`; (2) toda tabla creada habilita **RLS** en el mismo archivo; (3) ninguna política usa `using (true)`; (4) toda FK a `businesses` lleva `on delete cascade`; (5) tablas e índices se crean con `if not exists`, porque las migraciones se aplican a mano y repetirlas no puede romper nada. Nació del apagón del 26–31 jul 2026: `record_inbound_message_usage()` llamaba a `digest()` fuera de alcance, el trigger reventaba en cada mensaje entrante y el bot estuvo cinco días mudo. **PostgreSQL no valida el cuerpo de una función plpgsql al crearla**, así que el SQL se aplicó "con éxito" y el fallo solo apareció al ejecutarse. El guardián incluye un test que reintroduce ese SQL defectuoso y comprueba que lo detecta: si la regla se rompe, se sabe. ⚠️ Sigue sin haber pruebas contra un PostgreSQL real, así que estas reglas atrapan la familia de errores conocida, no cualquier error posible.
>
> ✅ Esquema: `server/schema.sql` está **consolidado y actualizado** (refleja la base real: RLS activado, todas las columnas y tablas vivas, y la función RAG `match_products`). `server/migration-integraciones.sql` quedó **OBSOLETO** (marcado como tal, solo historial — no ejecutar). Para el estado del esquema, usa `schema.sql` o consulta la BD.

---

## Guardián de funciones de base de datos sin dueño

**De dónde sale:** una pregunta del dueño del SaaS el 2026-08-02 — «todo lo que se borra o el código viejo, ¿ya no existe en mi sistema? ¿se está verificando?». La respuesta honesta entonces era **«a mano»**. Esto lo automatiza.

`server/tests/funciones-huerfanas.test.js` cubre los dos riesgos reales de tocar funciones en PostgreSQL:

1. **Un permiso que nombra una firma inexistente.** `create or replace function` con un parámetro nuevo **no reemplaza**: crea una SEGUNDA función con el mismo nombre. Ese mismo día, cuatro `grant` se quedaron con la firma vieja y `psql` abortó al aplicar el esquema entero. El test lo caza sin necesidad de levantar PostgreSQL — comprobado reintroduciendo el fallo a propósito.
2. **Funciones que no llama nadie**: ni el servidor, ni un disparador, ni otra función. Código muerto esperando a que alguien lo invoque por error.

⚠️ Distingue `execute function X()` (un disparador **usándola**) de `create function X(` (declarándola). Confundirlas marcaba como muertas todas las funciones de trigger del proyecto.

**Y en PostgreSQL real** (`verificar-esquema.sql`, que el CI ejecuta en cada PR): **ninguna función del proyecto puede tener dos versiones vivas**. Las sobrecargas de extensiones (pgvector, pgcrypto) se excluyen mirando `pg_depend`: esas sí son legítimas.

### Dos guardianes se acotaron, y por qué

`orders-atomicity` y `sales-atomicity` prohibían `exception when` en **todo** `schema.sql` para impedir escrituras compensatorias. Al incorporar al consolidado la función que activa RLS en tablas nuevas —que **necesita** capturar para no romper donde falte un permiso de superusuario— el guardián saltaba por algo que no era su objetivo. Ahora cada uno mira **solo su función** (`create_order_with_items`, `create_sale_with_items`), que es la garantía que de verdad protegían.

El guardián de migraciones también aprendió a **ignorar los literales de cadena**: una función que filtra eventos DDL por su etiqueta (`command_tag in ('CREATE TABLE AS', …)`) se leía como si estuviera creando una tabla llamada «as».

### La deriva que encontró

Existía en producción un disparador de evento `ensure_rls` con su función `rls_auto_enable` —activa RLS automáticamente en toda tabla nueva de `public`— que **no estaba en `schema.sql`**. Una instalación nueva nacía sin esa red de seguridad. Ya está en el consolidado.

## Los E2E fallan ante un error de la página (2026-08-15)

**Daban 32/32 con el dashboard del superadmin sin renderizar.** React lanzaba
`Cannot read properties of undefined (reading 'length')` y Playwright ni se
inmutaba, porque las pruebas miraban la URL, el tema o el token — cosas que
siguen ahí aunque el contenido no aparezca.

`e2e/fixtures.ts` añade un fixture automático que escucha `pageerror` y los
`console.error` de React y pone la prueba en rojo. Se ignoran a propósito los
errores de RED: un `fetch` fallido es cosa de los mocks de cada prueba, y
hacerlas fallar por eso las volvería ruidosas hasta que alguien las apagara.

⚠️ **Y hacía falta algo más que el fixture: ninguna prueba abría el dashboard
con sesión.** Un guardián no sirve de nada en una pantalla donde nadie entra.
Por eso se añadieron dos pruebas — una que lo abre entero, y otra que le
devuelve basura a la salud del canal y exige que el resto siga en pie.

⚠️ Ese par no es redundante, y comprobarlo cuesta un minuto: **arreglado el
mock, la primera pasa aunque se quite la defensa del componente**. La que de
verdad la protege es la que manda `{}` a propósito. Es el mismo patrón que en
`client.spec.ts` con la lista de bloqueados.

## La transacción de una migración la pone el ejecutor

`tests/migraciones.mjs` abre una transacción por migración y registra dentro de
ella el `insert` en `schema_migrations`. Una migración con su propio `commit`
**cierra esa transacción antes de tiempo**: el registro queda fuera y, si
fallara, el `rollback` no desharía el DDL — esquema cambiado sin constancia,
que es el peor estado en el que se puede quedar una migración.

Lo vigila `migraciones-guardian.test.js` con una lista de indultados: las 16
que ya lo llevaban están aplicadas y **un `.sql` aplicado no se edita nunca**
—cambiaría su huella y el ejecutor las marcaría como modificadas—. La lista no
puede crecer.

⚠️ Y una lección del mismo día: **aplicar una migración por fuera del ejecutor
deja el registro desincronizado**. Se aplicó con un cliente `pg` suelto, quedó
en la base y no en `schema_migrations`. Se reconcilió reejecutándola con
`npm run migrate` —es idempotente—, que además demuestra que se puede reaplicar
sin daño.

## Detector de código muerto (knip)

Corre dentro de `npm run check`, así que el CI lo ejecuta en cada PR. Encuentra **archivos que no importa nadie**, **dependencias declaradas que ya no se usan** y **dependencias que se usan sin declarar**. Comprobado que muerde: un archivo huérfano de prueba lo hace fallar.

Su primer hallazgo real fue `express-serve-static-core`, que `middleware/async.ts` importaba **sin declararlo** — llegaba de rebote a través de `@types/express`. Si ese árbol de dependencias cambiaba, el import se rompía sin que nadie hubiera tocado nada. Ya está declarado.

### ⚠️ Lo que NO detecta, y por qué

**Exports muertos del servidor.** Está apagado a propósito (`"exports": "off"`), no por comodidad: el servidor importa con `require('...')` tipado —el patrón CommonJS deliberado del proyecto— y knip no rastrea esas importaciones. En la primera pasada marcó **71 exports como muertos**, y el primero que se comprobó, `authClient`, tenía **66 usos reales**.

Un guardián que reporta 71 falsos positivos es peor que no tenerlo: se aprende a ignorarlo y el día que acierte, nadie mirará. Por eso solo queda encendido lo que este proyecto puede verificar con certeza.

Para el riesgo grave —código viejo que **sí se ejecuta**— está el guardián de funciones de base de datos, que es donde una versión olvidada puede correr sola. Una función TypeScript que nadie importa es peso muerto, pero no se ejecuta.

**Y para los exports del servidor está `exports-huerfanos.test.js`**, que sí entiende el patrón: los módulos terminan en `export = { … }` y quien los usa escribe `modulo.laClave(...)`, así que basta con mirar si alguien nombra esa clave en el código o en las pruebas. Es deliberadamente **conservador** —solo caza lo que nadie nombra en ningún sitio— porque un guardián ruidoso se acaba ignorando.

**Lo que destapó al escribirlo:** cuatro exports muertos, y uno de ellos era un problema de verdad. `cleanupStorefrontSessions` existía desde el primer día de la mini app pero **nadie la llamaba**: la tabla de sesiones crecía sin límite, una fila por cada enlace que manda el bot. No se borró — se **conectó** al mismo ciclo diario que ya limpia el inbox de webhooks y el registro de errores. Los otros tres (`getVariantForOrder`, `getExtrasForOrder`, `revokeStorefrontSessions`) sí eran peso muerto y se retiraron.

**En los paneles la auditoría se corre aparte** (`npx knip -c knip.exports.json`), porque ahí los imports son ESM y knip sí acierta. Encontró dos restos reales: `salesApi.getOrders`, que quedó huérfano al mover Pedidos a su propia sección, y `BotForm`, la versión anterior de la pantalla del prompt que `BotPrompt.tsx` ya había reemplazado.

`ignoreDependencies` cubre las que usa `packages/ui` y las apps declaran para el hoisting de los workspaces (`clsx`, `tailwind-merge`, `radix-ui`, `class-variance-authority`), y `apps/*/public/theme-boot.js`, que lo carga el HTML y no un import.

## El guardián de fronteras ahora corre en el CI

**Encontrado el 2026-08-02, y es el fallo más instructivo de esa sesión.**
`verificar-fronteras.sql` busca claves foráneas que apuntan a otra tabla **sin
comprobar de quién es la fila**: una simple garantiza que exista, no que sea de
tu negocio. Pero solo se ejecutaba desde `npm run verify:schema`, que **necesita
Docker y corre en local**.

Resultado: el CI estuvo **verde todo el día** mientras se abrían cuatro
fronteras nuevas —`sales(order_id)`, `sales(booking_id)`,
`sales(order_id)`—, creada ese mismo
día al construir el estándar de ventas. Las funciones `crear_venta_desde_*` ya
impedían el cruce, pero eso depende de que nadie escriba nunca por otro camino,
y **la regla #1 dice que lo impida la base**.

Se cerraron con claves foráneas **compuestas** sobre `(id, business_id)` —el
mismo patrón de `product_variants`— y el guardián se añadió al CI.

**La lección, que vale más que el arreglo:** un guardián que depende de que
alguien se acuerde de correrlo no es un guardián. Si una verificación existe,
tiene que estar en el camino automático.

---
## Las plantillas REALES del alta, contra PostgreSQL (2026-09-16)

`server/tests/sql/plantillas-reales.mjs`, en el job `esquema` del CI y en
`npm run verify:schema`. Da de alta un negocio por **cada** tipo con plantilla,
le aplica la plantilla **de verdad** —la de `business-templates.ts`, no una
copia escrita a mano— y exige que la base la acepte, que el local nazca con su
producto de ejemplo, que ese ejemplo nazca **agotado** (nadie lo puede pedir)
pero **activo** (aquí inactivo es borrado, y su dueño no lo vería) y que ningún
grupo vivo quede vacío. Todo dentro de una transacción que se deshace.

**Por qué hace falta aunque `plantillas-negocio.test.js` ya replique las reglas
de la base:** este fallo es **silencioso por diseño**. El alta se traga el
error de la plantilla a propósito —el negocio ya existe y no puede devolver un
500—, así que una plantilla que la base rechace deja al local naciendo con el
catálogo **vacío** y el motivo escondido en el registro de errores. Una copia
de las reglas en JavaScript envejece; la base no.

⚠️ **Lee el TypeScript sin compilar** (Node quita los tipos desde la 22.18):
el job del esquema no instala dependencias y así sigue. Funciona porque
`business-templates.ts` solo importa **tipos**. Si algún día importa un valor,
el paso falla en voz alta, no en silencio.

**Verificado que detecta**, no solo que pasa: una lista mal escrita
(`"Sabore"`) para con «La plantilla enlaza «Sabores» a la lista «Sabore», que
no trae», y una parte del plato sin marcar como parte para con la restricción
`option_groups_parte_del_plato_check`.

## Las dos capas que vigilan lo que YA está en producción (2026-09-18)

Todo lo de arriba corre **antes** de desplegar, y por eso comparte un punto
ciego: ninguna de esas capas dice nada a las tres de la mañana de un martes.
Estas dos corren en GitHub Actions, **fuera del servidor**, que es la única
manera de cubrir el fallo que ningún detector interno puede avisar — que el
proceso haya muerto.

### El vigía · `.github/workflows/vigia.yml` + `.github/scripts/vigia.mjs`

Cada 15 minutos le pregunta a producción por `/api/health` (público) y por
`/api/health/detalle` (con token). Da la producción por rota si no contesta, si
contesta algo que no es nuestro health —el proxy de Railway con el servicio
caído—, si `ok` es `false`, si la cola de webhooks no está lista, si el canario
encontró fallos, si hay entregas del webhook rechazadas, si el canal lleva 24 h
mudo, o si el registro de errores tiene algo abierto.

**No manda correos: termina en rojo**, y de eso se encarga GitHub. Cero cuentas
y cero credenciales de envío que mantener.

⚠️ **Distingue una CAÍDA de un aviso**, y no es cosmético. El primer aviso real
que mandó decía «🔴 Producción ha caído» porque al número le quedaban 0,50 USD
—con el bot vivo y vendiendo—, y un título que exagera se deja de leer: el día
que se caiga de verdad parecerá uno más. Caída es no contestar, `ok:false` o la
cola parada; lo demás —saldo, credenciales, canario, silencio— es «🟠 necesita
atención». Y cada uno tiene su ritmo: la caída se recuerda cada **4 h**, la
atención cada **24 h**, porque un saldo bajo puede llevar semanas ahí.

⚠️ **Lo que de verdad hubo que pensar es cuándo callarse.** Corriendo cada 15
minutos, fallar siempre que algo va mal son 96 correos al día, y una alarma que
suena 96 veces se apaga el primer día. Así que solo falla cuando la noticia es
nueva: al romperse, y como recordatorio cada 4 h mientras siga rota. Su memoria
es la conclusión de su propia ejecución anterior, consultada por la API — no
guarda estado en ningún sitio. La recuperación queda en verde y escrita en el
resumen, pero **no genera correo**: es una limitación asumida.

⚠️ El umbral de silencio son **24 h** y tiene que valer lo mismo que
`DEFAULT_SILENCE_HOURS` en `channel-health.ts`. `vigia.test.js` lo comprueba,
porque desincronizarlos haría que los dos digan cosas distintas del mismo canal.

### El respaldo · repositorio privado `YoverMarkt/bot-respaldos`

Cada día a las 03:00 de Ecuador vuelca la base, **la restaura en un PostgreSQL
limpio para comprobar que sirve**, la cifra con AES-256 y la publica como
Release con 30 días de retención. Si la restauración no trae el esquema
completo, no se publica nada y el run queda en rojo.

⚠️ **Vive en otro repositorio a propósito**, y por dos motivos: este es público
—los artifacts de Actions de un repo público los descarga cualquiera— y así
ninguna credencial de producción tiene que existir aquí. El código sigue siendo
el de aquí: el workflow hace checkout de este repositorio y ejecuta
`server/tests/respaldo.mjs`.

⚠️ **Usa la cadena del POOLER, no la directa.** `db.<ref>.supabase.co` resuelve
solo a IPv6 y los runners de GitHub no tienen IPv6. Con la directa falla con
«Network is unreachable», que parece un problema de credenciales y no lo es.
La que funciona es `aws-1-sa-east-1.pooler.supabase.com:5432` con usuario
`postgres.<ref>` — `aws-0` contesta «tenant not found» en todas las regiones.

## El staging local, y el freno que lo hizo necesario (2026-09-19)

Todo lo anterior prueba piezas. Lo que faltaba era un sitio donde correr **la
aplicación entera** sin que la estuvieran usando clientes — porque hasta esta
fecha no lo había: `server/.env` apunta a la base de producción, así que
desarrollar y producción eran literalmente el mismo sitio.

### Lo que arrancar en local disparaba contra los datos de los clientes

No es una lista teórica; es lo que `src/index.ts` programa al levantarse:

| Cuándo | Qué | Contra qué |
|---|---|---|
| al instante | el worker de la cola de webhooks | mensajes de clientes reales, contestados desde un portátil |
| 3 s | la facturación del mes | filas de cobro reales |
| 5, 7 y 9 s | tres limpiezas | **borran** filas |
| 12 s | las comisiones | |
| 20 s | la revisión de credenciales | llama a los proveedores de verdad |
| **30 s** | **`expireUnpaidOrders`** | **CANCELA pedidos de clientes** |
| 60 s | el canario | recorre el catálogo real |
| — | Telegram en polling | **borra el webhook** que tenga producción |

`src/config/tareas-de-fondo.ts` corta eso: si el proceso **no** es producción y
la base **sí** es remota, las tareas no arrancan y el servidor lo grita al
levantarse. Las rutas, los paneles y el simulador siguen funcionando, que es
para lo que se abre en local. El escape explícito es
`PERMITIR_TAREAS_CONTRA_PRODUCCION=si`.

⚠️ **En producción el freno nunca puede actuar**, y esa es la única condición
que no se puede romper al tocarlo: un freno que apague las tareas en producción
deja la facturación sin generar y los pedidos sin expirar. `tareas-de-fondo.test.js`
lo comprueba desde las dos direcciones, y un guardián verifica que el `if` sigue
envolviendo las tareas en `index.ts` — de nada sirve un freno bien probado que
el arranque no consulte.

### El staging

`supabase/config.toml` + `server/tests/staging.mjs`. Levanta **el stack de
Supabase**, no un PostgreSQL pelado: el servidor habla con la base por HTTP
(supabase-js → PostgREST), así que un Postgres a secas no sirve para correr la
aplicación — solo para el esquema, que es lo que ya hace el job del CI.

La semilla llama a `apply_business_template`, la misma función que el alta real.
Sembrarlo por otro camino probaría un mundo que no existe.

⚠️ **Qué NO cubre:** WhatsApp de verdad. Solo hay un número y apuntarlo aquí
dejaría a los clientes sin atender. Se sigue probando en producción después de
desplegar, con `verify:smoke` y el simulador. Lo que sí queda cubierto antes es
todo lo demás, que es donde está el riesgo caro: dinero, pedidos, catálogo,
sesiones y migraciones.

### La franja

`src/lib/franja-entorno.ts`. La página dice de qué entorno es: «STAGING · datos
de mentira» en índigo, o «⚠️ LOCAL · BASE REAL» en rojo. En producción no se
pinta nada y el HTML se sirve por `sendFile`, intacto y con su ETag.

⚠️ Al conectarla apareció un fallo de la familia de siempre: salía en la tienda
y **no** en los dos paneles. `express.static` sirve él mismo el `index.html` de
la carpeta (`/app`), sin pasar por `enviarHtmlDeSpa`, y el comodín `/app/*` no
casa con `/app`. La tienda se salvaba solo porque `/t/<slug>` nunca casa con un
archivo. Hay un guardián que exige que la ruta explícita de cada panel se
declare **antes** que su `express.static`.
