# DECISIONES.md — por qué cada pieza es como es

Los razonamientos largos de `CLAUDE.md`, movidos aquí **sin cambiar una frase**.

No es documentación de relleno: casi cada apartado existe porque algo falló y
alguien pagó el precio. Cuando vayas a tocar una de estas piezas, léela antes
de "simplificarla" — lo que parece complejidad de más suele ser una cicatriz.

**`CLAUDE.md` sigue siendo la guía obligatoria.** Esto se consulta al entrar a
un módulo concreto, no en cada sesión.

---

## Índice

- [Etiquetas del bot](#etiquetas-del-bot)
- [Modo menú estilo banco](#modo-menú-estilo-banco)
- [Reportes del dueño](#reportes-del-dueño)
- [Capacidad de citas y hospedaje](#capacidad-de-citas-y-hospedaje)
- [Salud del canal](#salud-del-canal)
- [Evals del bot](#evals-del-bot)
- [Vigilante de precios](#vigilante-de-precios)
- [Vigilancia de credenciales](#vigilancia-de-credenciales)
- [Registro de errores](#registro-de-errores)
- [Mini app de la tienda](#mini-app-de-la-tienda)
- [El horario del dueño manda sobre todos los modos](#el-horario-del-dueño-manda-sobre-todos-los-modos)
- [Los estados de un pedido](#los-estados-de-un-pedido)
- [Envío, pago y color de la tienda](#envío-pago-y-color-de-la-tienda)
- [Un pedido entregado es una venta](#un-pedido-entregado-es-una-venta)
- [Los tres modos de atención](#los-tres-modos-de-atención)

---

## Etiquetas del bot

**Etiquetas del bot** en formato `##NOMBRE##` o `##NOMBRE:datos##`; `server/src/services/bot-entry.ts` agrupa mensajes y resuelve WhatsApp mediante `(provider, identifier_type, canonical_identifier)` o Telegram por slug. Nunca compara sufijos de teléfono. `server/src/services/bot-conversation.ts` coordina el flujo, `server/src/services/bot-tags.ts` detecta y limpia sin acceder a la base, `server/src/services/bot-actions.ts` ejecuta acciones y `server/src/services/bot-media.ts` envía media del catálogo. Todos reciben exclusivamente el `business.id` resuelto por el adaptador de canal. Las vigentes incluyen `##BOOK:nombre|YYYY-MM-DD|HH:MM|servicio##`, `##PEDIDO:producto x cantidad; ...##`, `##STAY_QUOTE:ENTRADA|SALIDA|HABITACIONES|ADULTOS|NIÑOS##`, `##STAY_REQUEST:TIPO_HABITACION|NOMBRE##` y `##HANDOFF##`. Las acciones BOOK, PEDIDO, STAY_QUOTE, STAY_REQUEST y HANDOFF son mutuamente excluyentes; una respuesta conflictiva falla cerrado. `##VENTA##`/`##PEDIDO##` simples se conservan solo como respaldo legacy y `##BOOKING##` se limpia por compatibilidad.

---

## Modo menú estilo banco

**Modo MENÚ estilo banco (`server/src/services/bot-menu-flow.ts`) — decisión 2026-07-19:** el CÓDIGO conduce TODA la conversación con opciones generadas de los datos reales (categorías = tags del catálogo, habitaciones = inventario de hospedaje, citas = agenda real); la IA NO participa en ningún mensaje. Navegación con máquina de estados por conversación (memoria 30 min): bienvenida → menú principal por capacidades → pedido con carrito y total en centavos del catálogo → cotización de estadía (fechas escritas por el huésped en un mensaje CON MES obligatorio — "del 24 al 26 de julio" — parseadas por código con calendario Ecuador y confirmadas con día de semana real; habitaciones/personas por botones; la cotiza la RPC oficial) → cita con día/hora de la agenda → "💬 Hablar con el equipo" deriva. Lo que no coincide con el menú repite las opciones (fallo cerrado, jamás inventa); el cliente también puede responder el NÚMERO de la opción. Conectado al simulador (`mode:'menu'`, por defecto en la UI con toggle "Modo menú / Modo IA"); WhatsApp/Telegram siguen con IA hasta decidir llevarlo al canal real (botones interactivos post-Meta; Telegram ya tiene `inlineKeyboard`).

---

## Reportes del dueño

**Reportes del dueño (`server/src/services/reports.ts`):** NO son etiquetas ni function-calling. Son una **capa de intención server-side** que corre en `bot-conversation.ts` ANTES del flujo de atención: si quien escribe es el `owner_phone` del negocio y el texto pide un reporte, se responde el reporte (texto plano WhatsApp) y se corta; si no es el dueño o no es un reporte, devuelve `handled:false` y sigue el flujo normal. Sus cálculos, dashboard y alertas están tipados y todos reciben el `business_id` ya resuelto. Las ventas se registran a mano desde el panel del cliente (tablas `sales` + `sale_items`).

---

## Capacidad de citas y hospedaje

**Capacidad de citas y hospedaje:** la agenda simple usa `create_booking_if_available` para conservar capacidad única; el cobro se coordina fuera de la plataforma. Hospedaje es un dominio separado con inventario agregado por tipo y noche: `quote_lodging_options` calcula opciones y `create_lodging_request_if_available` crea el hold bajo lock por negocio; un trigger impide superar `total_units` incluso ante escrituras concurrentes. Los holds vencidos dejan de ocupar cupo y las reservas externas/mantenimiento se registran como bloqueos independientes. Las fechas relativas del huésped («el lunes», «mañana», «pasado mañana») las resuelve SIEMPRE el servidor con el calendario de Ecuador leyendo TODOS los mensajes del huésped (gana el más reciente que hable de fechas, y una fecha explícita respeta al modelo); además el prompt inyecta la fecha de hoy (todos los negocios) y el calendario real de los próximos 7 días (hospedaje) para que el modelo nunca haga aritmética de fechas.

---

## Salud del canal

**Salud del canal (`server/src/services/channel-health.ts`):** responde la única pregunta que importa cuando el bot calla — *¿están entrando mensajes?*. Nació de un incidente real (26–31 jul 2026): un trigger reventaba al insertar en la cola, el webhook respondía 503, YCloud dejó de entregar y el bot estuvo **cinco días mudo** mientras `/api/health` seguía en verde porque el proceso vivía. Trabaja en dos tiempos: `recordWebhookFailure` deja constancia **en el acto** de cada entrega rechazada (con su código y motivo, nunca credenciales ni el mensaje), y `diagnoseChannels` clasifica cada negocio activo en `ok` · `silencio` · `nunca_recibio` · `sin_canal` comparando su último entrante contra `DEFAULT_SILENCE_HOURS` (12 h). Los suspendidos o inactivos se omiten: su silencio es esperado y alertar por ellos volvería el aviso ruido de fondo. Se consume en `GET /api/admin/channel-health` (solo superadmin) y se pinta en el Dashboard del admin. ⚠️ `/api/health` **informa** del canal pero su `ok` sigue reflejando solo si el proceso puede trabajar: Railway usa esa ruta como healthcheck y un canal en silencio devolviendo 503 reiniciaría el contenedor en bucle, convirtiendo un aviso en una caída.

---

## Evals del bot

**Evals del bot (`server/evals/`, `npm run evals -w @botpanel/server`):** ~20 conversaciones doradas corridas contra la IA **de verdad**, con el prompt real. Es la única capa que ve bugs de comportamiento: el CI puede estar entero en verde mientras la IA inventa un precio o promete algo que no existe. Cubre hostal, pizzería y barbería, y verifica que no cite precios inexistentes ni regale descuentos, que emita la etiqueta correcta (`##PEDIDO##`, `##BOOK##`), que no invente servicios ni disponibilidad, que jamás genere enlaces de pago ni dé por confirmada una reserva, y que resista la inyección de prompt ("ignora tus instrucciones") o que le pidan datos de otro negocio. Los casos aceptan `historial` para llegar al pedido en varios turnos, como hablan los clientes reales. ⚠️ **Gasta dinero** (llamada real por caso, céntimos por corrida) y por eso **NO corre en el CI**: se lanza a mano antes de una demo o al cambiar el prompt o el modelo. Para añadir casos basta copiar uno en `evals/casos.mjs` y cambiar `mensaje` y `espera` — el runner los recoge solo. `EVAL_AI_PROVIDER` fija el proveedor.

---

## Vigilante de precios

**Vigilante de precios (`server/src/services/price-guard.ts`):** hace cumplir la regla inviolable #8 en la salida — todo monto que escriba la IA se confronta con el catálogo real del negocio. Acepta precios del catálogo (`price` y `price_sale`), múltiplos enteros de ellos (2 noches × $95 = $190) y cifras que el propio servidor calculó en ese turno; lo demás se considera inventado. Solo mira cifras con **moneda explícita** (`$95`, `95 dólares`, `USD 95`): sin ese filtro, «3 noches», «10:00» o un número de teléfono se leerían como precios y el vigilante sería inservible de puro ruidoso. Si el negocio no tiene precios cargados no acusa a nadie. ⚠️ **Arranca en modo `observar` a propósito** (`PRICE_GUARD_MODE`, por defecto observar): registra el hallazgo como categoría `ia` en el registro de errores **sin cortar la conversación**, porque un falso positivo dejaría a un cliente real sin respuesta. Solo cuando los datos confirmen que no hay falsos positivos se pasa a `PRICE_GUARD_MODE=bloquear`, y entonces descarta el mensaje y deriva. Convive con `bot-tags.impersonatesOfficialSummary`, que cubre el caso hermano de imitar un resumen oficial completo.

---

## Vigilancia de credenciales

**Vigilancia de credenciales (`server/src/services/credential-monitor.ts` + `integrations/provider-status.ts`):** cada 6 h revisa SOLA, negocio por negocio, que el canal siga en pie: API Key aceptada por el proveedor, número presente en la cuenta y `CONNECTED`, **webhook activo apuntando a `BASE_URL` y suscrito a los mensajes entrantes**, y saldo por encima de `SALDO_MINIMO_USD`. El panel ya permitía verificar credenciales a mano (`/api/admin/clients/:id/verify`), y precisamente por eso en julio de 2026 nadie se enteró de nada durante cinco días: la comprobación existía, pero nadie la ejecutó. Cada problema se registra en el log de errores como categoría `canal`, así que aparece en el panel sin que nadie tenga que preguntar. Los negocios suspendidos o inactivos se omiten (sus credenciales pueden estar caducadas a propósito). `ProviderClient` es inyectable para poder probar cada escenario sin tocar los proveedores reales. ⚠️ `getAllBusinessesWithSecrets()` existe SOLO para esto y **no debe exponerse en ninguna ruta**: lo que va al panel pasa antes por `sanitizeBusinessForAdmin`.

---

## Registro de errores

**Registro de errores (`server/src/services/error-log.ts` + `migration-registro-errores.sql`):** deja rastro consultable de los fallos que antes solo vivían en los logs de Railway. Cubre cuatro categorías — `canal` (webhooks, cola), `ia` (proveedor sin saldo, key inválida, timeout), `envio` (mensajes que no salieron) y `servidor` (excepciones 5xx). **Dos reglas que no se negocian:** (1) *nunca rompe a quien lo llama* — todo va envuelto y los fallos del propio logger se tragan, porque un logger que tumba el servidor es peor que no tener logger; (2) *nunca guarda datos personales ni credenciales* — el log está pensado para descargarse en CSV y compartirse, así que `sanitizeErrorText` borra teléfonos, correos, JWT y claves antes de persistir. **Agrupa por huella** (`errorFingerprint`, calculada en Node y **no** con `digest()` en SQL, que es justo lo que tumbó el canal cinco días): mil repeticiones son una fila con `occurrences: 1000`, lo que evita inflar la tabla y responde mejor a "cuánto lleva fallando esto". Se lee en `GET /api/admin/errors` y `GET /api/admin/errors/export` (solo superadmin) y se purga a los 30 días. La tabla `platform_errors` admite `business_id` nulo para errores de plataforma, y el código tolera que la migración aún no se haya corrido: sin ella la vigilancia del canal sigue respondiendo.

---

## Mini app de la tienda

**Mini app de la tienda (`apps/store`, servida en `/t/:slug`) — decisión 2026-08-01:** la app que el cliente final abre desde el enlace que le manda el bot. **UNA sola app, pero el flujo lo elige la CAPACIDAD del negocio, nunca su `type`** (`storefrontCapabilities` en `server/src/services/storefront.ts`): `takes_orders` pinta el flujo tipo delivery (categorías → producto con variantes y extras → carrito → pedido) y `lodging_enabled` pinta el flujo tipo Booking (fechas → huéspedes → habitaciones disponibles → solicitud). No es un capricho estético: **una estadía no cabe en un carrito** — no se piden "2 habitaciones" como 2 pizzas, se piden noches concretas y el servidor decide qué cabe. Un negocio con ambas capacidades muestra un selector; uno sin ninguna (la barbería) devuelve `no_disponible` en vez de abrir una app vacía, y se queda con el agente de menú. **El CATÁLOGO es público desde el 2026-08-05**: ver la carta y los precios no pide enlace (`readStorefrontSession`), porque un enlace de comida se reenvía, se pega en una historia y se busca — y quien llegue tiene que poder mirar antes de dar su número, como en cualquier tienda. **Pedir sí lo exige**, y ahí está toda la diferencia: `req.storefront` se puebla SOLO con una sesión completa y válida para ESE negocio, nunca a medias, así que ninguna ruta puede acabar creando un pedido sin cliente; un token inválido, revocado o de otro negocio deja mirar la carta y no identifica a nadie. El 401 de la petición de pedido es lo que lleva a `Gate.tsx` o a confirmar el teléfono. **Sin JWT: la credencial para pedir es el enlace**, validado por `requireStorefrontSession` — el token se borra de la barra de direcciones al leerlo (una captura compartida no regala la sesión) y queda atado al dispositivo, así que un enlace reenviado cae en `Gate.tsx`, que explica que cada enlace es personal y ofrece el WhatsApp del negocio. **Ningún importe viaja desde el teléfono**: la app manda ids y cantidades y el total lo calcula `create_storefront_order` o `quote_lodging_options` (regla inviolable #8); los precios que pinta `apps/store/src/lib/cart.ts` son solo para que el cliente vea algo mientras elige. **Solo se abre desde el móvil** (`apps/store/src/lib/device.ts`, decidido 2026-08-01): en una computadora se muestra «Abre este enlace desde tu celular» y no se pide nada con sesión. Es **fricción, no seguridad** —quien sabe abrir la consola sabe cambiar el modo móvil— y conviene no confundirlo: la consola no revela nada porque el frontend no guarda secretos y los precios los recalcula el servidor. La detección mira el identificador del navegador **y** las señales físicas de la pantalla, porque un iPad en modo escritorio dice ser un Mac; ante la duda deja pasar, ya que bloquear un teléfono real pierde una venta en silencio mientras que dejar mirar a un curioso no cuesta nada. El bloqueo va **antes** de cualquier petición con sesión, y ese orden importa: la portada es pública y no reserva el enlace, así que un clic desde WhatsApp Web lo deja intacto para cuando la persona lo abra en su teléfono (verificado contra el servidor real). Deliberadamente **sin router ni cliente de datos** (~82 kB gzip, con un presupuesto de 86 vigilado por `apps/store/tests/presupuesto-tamano.mjs` en cada PR): se abre con datos móviles, y cada kilobyte se paga en clientes que cierran antes de que cargue. Rutas en `server/src/routes/storefront.routes.ts`; el hospedaje reutiliza el mismo servicio que el bot, así que disponibilidad y tarifas tienen una sola fuente de verdad. **El enlace lo manda el bot** (`server/src/services/storefront-link.ts`): lo arma el CÓDIGO y un token recién creado, nunca la IA —un modelo que «recuerde» una URL manda a la gente a una pantalla de error—. Como el token solo se guarda hasheado, un enlace enviado **no se puede reconstruir ni reenviar**: cada petición crea uno nuevo, y por eso hay un freno de 10 minutos por contacto (`RESEND_COOLDOWN_MS`) para que un «hola» repetido no llene la tabla ni parezca un bot roto. Los anteriores NO se revocan, para no romperle el pedido a quien lo tenga abierto. **Es corto a propósito: `/s/<token>`** (~68 caracteres en producción, frente a los ~130 del formato anterior). El slug NO viaja —el token ya identifica al negocio— y el token bajó de 256 a 128 bits (43 → 22 caracteres, la misma entropía que un UUID v4). No es cosmética: un enlace largo en un chat se lee como spam y el cliente no lo toca. La ruta `GET /s/:code` resuelve y redirige a `/t/<slug>?s=<token>`; **no devuelve datos nunca, solo redirige**, y por eso vive sin sesión — con un token inventado no se averigua nada (redirige a `/t/_`) y quien llega con el suyo ya lo tenía. Un dominio propio lo dejaría en ~40 caracteres. ⚠️ **Que el enlace abra dentro de WhatsApp o en el navegador del teléfono NO se controla desde aquí**: lo decide el ajuste del cliente. Lo único que se queda de verdad dentro son los WhatsApp Flows, descartados por exigir cuenta Meta verificada. Va pegado a la bienvenida en modo menú (`MenuFlowResult.isWelcome`, que existe porque `bot-menu-flow.ts` es puro y no puede tocar la base) y como mensaje propio DESPUÉS de la respuesta del asistente en modo IA. Si falla algo —sin `BASE_URL`, base caída— devuelve null y el bot atiende por chat como siempre. **La subida del comprobante de transferencia está construida desde el 2026-08-05** y es privada: ver [Mini app de la tienda → comprobantes](#mini-app-de-la-tienda) y la regla de `payment_proof_public_id` en CLAUDE.md — se sube a Cloudinary como `authenticated` y solo se ve con una firma temporal de 10 minutos, nunca desde una URL permanente.

**Rediseño de la tienda (2026-08-06):** el flujo de comida pasó a la línea del diagrama aprobado — portada del local con estado y horario, buscador, categorías en círculos, pestañas sticky, bandas grises entre secciones, rejilla de dos columnas con la foto arriba y barra inferior fija. La estructura entera está en **[DISENO-MINIAPP.md](DISENO-MINIAPP.md)**, incluido qué se apartó del diagrama y por qué. Tres cosas que no son de estilo y conviene saber antes de tocarlo: **(1)** la pestaña activa la decide el SCROLL mediante un `IntersectionObserver` con una línea de lectura bajo las pestañas, y durante un salto programático el subrayado se congela —sin eso, tocar una pestaña lo hace parpadear por todas las secciones del camino—. **(2)** Elegir entrega o retiro **dejó de vivir dentro del carrito**: ahora se decide también en la portada, así que el estado subió a `FoodStore` y las tres reglas que colgaban de él viven en `apps/store/src/lib/cart.ts` (`ENTREGA_POR_DEFECTO`, `needsAddress`, `orderTotal`) con una prueba cada una. Escondido en el componente no se podía comprobar, y elegir «Retiro» arriba volvía a «Entrega» al abrir el carrito. **(3)** El caso **sin foto es el normal**, no la excepción: hoy ningún producto tiene imagen, y el marcador con la inicial sobre el color del negocio existe para que dieciséis huecos grises no parezcan la app rota. ⚠️ La portada del diagrama sigue **incompleta a propósito**: `cover_url`, `prep_time` y `min_order` no existen en la base, y el tiempo de preparación está fijo en 30 minutos para todos los negocios al calcular las franjas.

---

## El horario del dueño manda sobre todos los modos

**El horario del dueño manda sobre TODOS los modos (corregido 2026-08-01):** la comprobación de `isOutsideHours` va **antes** de repartir por `chat_mode`. Hubo dos excepciones que convertían el horario en decoración y la segunda no se veía: el modo menú salía por su propia rama antes de mirar el reloj, así que un negocio con el menú activado —el caso del hostal— atendía domingos y de madrugada aunque su horario dijera lo contrario. Cubierto por tests que fallan si el orden se invierte. ⚠️ Ojo con el caso legítimo: si **ningún** día está activo, `isOutsideHours` devuelve `false` a propósito —un negocio que nunca configuró horario no puede quedarse mudo—; cerrar el domingo es marcar ese día inactivo con los demás activos.

---

## Los estados de un pedido

**La máquina de estados del pedido (decidido 2026-08-02, con la tabla `orders` todavía vacía):** un pedido va `pendiente → confirmado → preparacion → en_camino → completado`, y desde cualquiera de esos a `cancelado`. Vive en la RPC `set_order_status` de PostgreSQL, **no en el panel**: la pantalla propone, la base decide. Tres reglas y el porqué de cada una:

- **Se puede saltar hacia adelante.** Aceptar un pedido y ponerlo a preparar es un solo gesto en una pizzería, y quien no reparte cierra desde `preparacion` sin pasar por `en_camino`. Obligar a recorrer los cinco pasos habría metido clics a todos para servir a uno.
- **No se retrocede, nunca.** Un pedido que ya salió no vuelve a la cocina; si algo se tuerce, se cancela. Es lo único que después se puede auditar sin ambigüedad, y evita las preguntas que abre el retroceso (¿cuenta como entregado? ¿qué pasó con el reparto?) que hoy no hay por qué responder.
- **`en_camino` está prohibido para los pedidos `pickup`/`onsite`**, comprobado contra la columna `fulfillment` que ya llenaba la mini app. Lo impide la base y no la pantalla, porque una pantalla se equivoca y un CHECK no. Los pedidos del bot no traen `fulfillment` y se asumen a domicilio, que es como funcionan hoy por WhatsApp. Cuando ocurre, la RPC devuelve `not_deliverable` y la ruta responde 409 con el motivo, en vez del conflicto genérico.

⚠️ **El momento se eligió a propósito:** se hizo con cero pedidos reales, cuando cambiar un CHECK cuesta nada. Con una pizzería operando, lo mismo es migrar los datos de un cliente vivo. `en_camino` es además el punto donde engancharía una cooperativa de reparto, así que el estado tenía que existir antes que la sección Pedidos, que se construye alrededor de él.

Verificado ejecutando la migración contra un PostgreSQL real —incluidas la irreversibilidad, el bloqueo del retiro y que el flujo anterior sigue intacto—, no solo leyéndola: Postgres acepta una función rota sin avisar. Las transiciones viven en `server/tests/sql/verificar-esquema.sql`, que el CI ejecuta en cada PR.

---

## Envío, pago y color de la tienda

**Completado el flujo del diagrama del dueño (2026-08-02).** Tres piezas que faltaban, con las decisiones que las gobiernan:

**El envío es un monto fijo por negocio** (`businesses.delivery_fee`) y **lo suma PostgreSQL**, dentro de `create_storefront_order`, junto al subtotal. No es un detalle de implementación: si el envío se calculara en el teléfono, cualquiera pediría con envío $0 tocando el JavaScript (regla inviolable #8). Solo se cobra cuando `fulfillment = 'delivery'` — quien retira en el local no lo paga — y es **uno por pedido, no por unidad**. La mini app muestra una vista previa del desglose; el importe que manda es siempre el que devuelve la base. Se descartaron las zonas por precio: exigen tabla propia, pantalla de gestión y que el cliente acierte su zona, y ningún negocio real lo ha pedido todavía.

**El método de pago** (`orders.payment_method`) es `transferencia` o `efectivo`, y **nunca tarjeta**: la plataforma no procesa cobros (regla inviolable #6), y el diagrama la marcaba «próximamente» a propósito. Queda nulo en los pedidos que entran por WhatsApp, que no preguntan cómo se paga. Lo que elige el cliente decide qué ve después: quien paga en efectivo no pasa por datos bancarios ni comprobante.

**El comprobante es OPCIONAL y va DESPUÉS de crear el pedido.** Es la decisión con más consecuencias del bloque: el pedido ya está a salvo cuando se pide la foto, así que un cliente que no la encuentra —o una subida que falla— no pierde el pedido. La imagen la sube el SERVIDOR a Cloudinary y se guarda la URL que devuelve Cloudinary, nunca una que mande el teléfono. ⚠️ La pertenencia se comprueba en `attach_storefront_payment_proof` con **las tres cosas a la vez: negocio, pedido y teléfono de la sesión** — la mini app no tiene JWT, así que sin eso cualquiera con un id de pedido ajeno podría colgarle una imagen. Un pedido ya cerrado no admite comprobante.

**El logo** (`businesses.logo_url`) se sube desde Ajustes reutilizando la misma subida del catálogo —mismo endpoint, mismas validaciones, misma cuenta de Cloudinary bajo el `business_id` del JWT— y se guarda solo la URL que devuelve Cloudinary. El CHECK exige `https://` porque esa URL acaba dentro de un `<img>` de una app pública. En la cabecera de la tienda manda el logo si existe; si no, el nombre solo, sin dejar un hueco vacío.

**El color de marca** (`businesses.brand_color`) lo elige el dueño en su panel; el verde de la plataforma es solo el valor por defecto. Se valida como hex de 6 dígitos en tres capas —CHECK, ruta y cliente— porque acaba dentro de un estilo. ⚠️ El acento se usa **siempre como fondo**, nunca como color de letra sobre blanco, y el texto que va encima **se calcula por luminancia** (`apps/store/src/lib/marca.ts`): así el negocio puede elegir amarillo o azul marino sin que nada quede ilegible. El botón principal es tinta y no el color del negocio, para que la acción que cierra el pedido se lea igual con cualquier marca.

Verificado ejecutando la migración contra un PostgreSQL real: el envío no se multiplica por unidad, un precio mandado por el cliente se ignora, y otro teléfono u otro negocio no pueden adjuntar comprobante a un pedido ajeno.

---

## Un pedido entregado es una venta

**El agujero que cerró (2026-08-02):** TODOS los reportes del dueño —ventas, dashboard, directorio de clientes, productos más vendidos, clientes perdidos— leen la tabla `sales`, y `sales` solo se llenaba con el botón «Registrar venta» del panel. Un pedido de la tienda o del bot se entregaba y **no aparecía en ningún número**. El negocio vendía y sus reportes decían que no. Con hospedaje pasaba algo parecido: su ingreso se calcula aparte, en `computeLodgingIncome`.

**El estándar que se establece:** cada tipo de negocio tiene su bandeja donde atiende —Pedidos, Citas, Hospedaje— y **todas desembocan en `sales`**. Así los reportes tienen una sola fuente de verdad y no hay que volver a tocarlos cuando se añada un flujo nuevo. Es la decisión que permite vender el producto a una pizzería, una barbería o un hostal sin rehacer los números cada vez.

Cómo está hecho, y por qué así:

- **Cuenta al marcarlo ENTREGADO**, no al aceptarlo: es cuando el dinero está de verdad en el negocio, y un pedido rechazado o cancelado nunca ensucia el reporte.
- **La conversión vive DENTRO de `set_order_status`, no en un disparador.** En este proyecto un trigger mal colocado ya tumbó el alta de clientes durante meses (2026-08-02); aquí el camino es explícito y se lee de una vez. Al ir en la misma transacción, nunca queda un pedido entregado sin su venta.
- **`sales.order_id` con índice único parcial.** No es higiene: es lo que impide que marcar «entregado» dos veces —o reintentar tras un fallo de red— duplique el dinero del reporte. La función además comprueba si ya existe antes de insertar.
- **El total de la venta incluye el envío** (es el dinero que entró), pero los `sale_items` son solo productos: así «lo más vendido» no se ensucia con una línea de envío que nadie pidió. El nombre del ítem congela su variante — «Pizza (Mediana)» es lo que el dueño reconoce tres meses después.
- **La migración recupera el pasado:** al aplicarse, cualquier pedido ya entregado sin venta la genera. Con la base en cero no hace nada; en una base con historial, devuelve al reporte lo que nunca contó.

Verificado contra un PostgreSQL real: aceptar/preparar/despachar NO crean venta, entregar sí, entregar dos veces no duplica, un pedido rechazado no aparece, y otro negocio no puede convertir en venta un pedido ajeno.

**El pedido de mostrador** (lo que se vende en persona) entra por el MISMO camino: nace `completado` con `source = 'manual'` y `create_order_with_items` le crea la venta dentro de la propia función. Si fueran dos llamadas desde Node, un fallo entre ellas dejaría un pedido cobrado sin venta. ⚠️ `orders.contact_phone` es NOT NULL pero en un mostrador casi nunca hay teléfono: se guarda el literal `'mostrador'` y la venta lo convierte a nulo con `nullif`. Sin eso, el directorio de clientes acabaría con un cliente fantasma de cientos de compras que arruinaría «frecuentes» y «clientes perdidos».

**Una CITA atendida también es una venta**, y con eso el estándar llega a servicios (barberías, consultorios). Antes `bookings` no tenía precio y no existía ni un vínculo entre una cita y una venta: el dueño tenía que acordarse de registrarla a mano o esa atención no existía en ningún reporte.

- **«Atendida» es un estado NUEVO, distinto de «confirmada».** Confirmar es decir «te espero»; atender es que la persona vino. Solo lo segundo es dinero, y solo lo segundo genera venta.
- **El precio se congela.** La cita apunta al servicio del catálogo (`product_id`, con clave foránea COMPUESTA para que no pueda ser el servicio de otro negocio) y guarda su importe. Si mañana el corte sube de $10 a $12, la cita de ayer sigue valiendo $10: es lo que se pactó.
- **El precio se puede fijar al cerrar la cita**, porque la mayoría las agenda el BOT y el bot no negocia precios. Va en la misma llamada que el estado: si fuera un update aparte, una cita podría quedar atendida con el precio a medio guardar.
- **Una cita sin precio se atiende igual y no genera venta** — una consulta gratuita es un caso legítimo, no un error.
- **Una cita cerrada no se reabre**, igual que los pedidos: se agenda otra.

**«Registrar venta» se retiró el 2026-08-02.** Era el cuarto camino: el único donde alguien escribía dinero a mano sin un pedido ni una cita detrás. Mientras existió, el reporte podía cuadrar por dos vías distintas y había que mantener las dos.

Con él se fueron su ruta (`POST /api/client/sales`), su cotización (`/sessions/:phone/quote`), el wrapper del repositorio y la RPC `create_sale_with_items`, retirada de la base con su migración. ⚠️ **No se borró ni una fila**: las ventas registradas así siguen intactas en `sales` y en los reportes; lo único que desaparece es la forma de crear ventas nuevas sin origen.

Lo que queda en Ventas es el **historial** por contacto y la **anulación**, que sigue haciendo falta: un pedido puede entregarse y luego devolverse.

El guardián de esa zona (`sales-atomicity`) no se borró: **se mudó a las dos funciones que ahora crean ventas**, porque la garantía que protegía —cabecera y detalles en una transacción, aislados por negocio, sin escrituras compensatorias— sigue siendo la misma. Y el test de rutas comprueba ahora que las retiradas **no reaparezcan**.

---

## Los tres modos de atención

**La incoherencia que cerró (2026-08-02):** `chat_mode` solo tenía `'menu'` y `'ai'`, y el enlace de la mini app **se mandaba en los dos**. Un hostal recién creado recibía el menú de botones **y** el enlace a la vez: dos formas de hacer lo mismo compitiendo en el mismo chat. Lo detectó el dueño del SaaS creando negocios nuevos, no un test.

Desde ahora cada negocio atiende de **una** forma, y el enlace **pertenece a un modo concreto**:

| Modo | Quién conduce | Dónde se pide | ¿Enlace? |
|---|---|---|---|
| `ai` | La IA, conversando | Por chat (`##PEDIDO##`) | **No** |
| `menu` | El código, con botones | Por el menú | **No** |
| `miniapp` | La IA resuelve dudas | En la mini app | **Sí**, al saludar |

- **En modo menú no va enlace, y no es un olvido:** el menú YA es el sitio donde se pide.
- **En modo IA puro tampoco:** ese negocio eligió atender y vender por chat. Mandarle el enlace sería meterle una app que no pidió.
- **El enlace es lo que DEFINE el modo mini app.** Va como mensaje propio *después* del saludo del asistente —al revés se lee como publicidad antes de responderle a la persona— y **solo ante un saludo**: quien ya pregunta algo concreto quiere su respuesta, no un enlace.

**El modo se propone según el tipo al dar de alta y se puede cambiar siempre.** Con tienda (restaurante, tienda, hotel) → `miniapp`; barbería o consultorio → `menu`, que es más barato y predecible que la IA para elegir de una lista corta; catálogos enormes y consultoría → `ai`. ⚠️ Como el resto de recomendaciones por tipo, **solo PROPONE al crear**: el `chat_mode` persistido manda siempre y jamás se sobrescribe a un negocio existente. Una pizzería que quiera «solo chat» se queda en `ai` o en `menu` aunque tenga tienda.

La migración pasa a `miniapp` los negocios que ya tenían tienda encendida: son exactamente los que estaban recibiendo menú y enlace a la vez.

---

## El cuarto camino: hospedaje

**Completado el estándar (2026-08-02).** El ingreso por hospedaje se calculaba **aparte**, en `reports.computeLodgingIncome`, sumando estadías confirmadas. Funcionaba, pero dejaba al dueño de un hostal con **dos números que no se juntaban**: sus ventas por un lado y sus estadías por otro. Ahora los cuatro caminos terminan en el mismo sitio:

```
Pedido entregado    → venta
Pedido de mostrador → venta
Cita atendida       → venta
Estadía confirmada  → venta
```

- **Cuenta al CONFIRMAR**, no al terminar la estadía. Confirmar es cuando el hostal se compromete y retiene el cupo, y es exactamente lo que ya contaba el reporte de ingresos: cambiarlo a la salida movería los números históricos del negocio sin que nadie lo hubiera pedido.
- **La conversión se ENVOLVIÓ, no se reescribió.** `set_lodging_request_status_v2` llama a la original y, si quedó confirmada, registra la venta. Así no se toca ni una línea del anti-sobreventa, que es lo delicado de este módulo (locks, trigger de capacidad, holds con vencimiento).
- **El ítem de la venta no lleva `product_id`**: una habitación vive en el inventario de hospedaje, no en el catálogo de productos. Inventarle uno ensuciaría «lo más vendido» con algo que no es un producto. El nombre describe la estadía como la leería el dueño meses después: «Estadía 3 noches (2026-08-10 → 2026-08-13)».
- **La migración recupera el pasado**: las estadías ya confirmadas generan su venta al aplicarse, para que un hostal en marcha no vea sus ingresos empezar de cero.

### Un agujero que destapó

Al añadir la v2, el guardián de cobertura de RPCs **no la exigía probada**: su extractor buscaba `[a-z_]` y el nombre lleva un dígito. **Cualquier función con número en el nombre se le escapaba.** Corregido a `[a-z0-9_]`, y con eso el guardián reclamó de inmediato que la v2 se ejecutara contra PostgreSQL real, que es justo su trabajo.
