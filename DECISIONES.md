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
- [Capacidad de citas (retirada)](#capacidad-de-citas-retirada)
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
- [Lo que gana la plataforma](#lo-que-gana-la-plataforma)

---

## Etiquetas del bot

**Etiquetas del bot** en formato `##NOMBRE##` o `##NOMBRE:datos##`; `server/src/services/bot-entry.ts` agrupa mensajes y resuelve WhatsApp mediante `(provider, identifier_type, canonical_identifier)` o Telegram por slug. Nunca compara sufijos de teléfono. `server/src/services/bot-conversation.ts` coordina el flujo, `server/src/services/bot-tags.ts` detecta y limpia sin acceder a la base, `server/src/services/bot-actions.ts` ejecuta acciones y `server/src/services/bot-media.ts` envía media del catálogo. Todos reciben exclusivamente el `business.id` resuelto por el adaptador de canal. Las vigentes incluyen `##BOOK:nombre|YYYY-MM-DD|HH:MM|servicio##`, `##PEDIDO:producto x cantidad; ...##`, `##STAY_QUOTE:ENTRADA|SALIDA|HABITACIONES|ADULTOS|NIÑOS##`, `##STAY_REQUEST:TIPO_HABITACION|NOMBRE##` y `##HANDOFF##`. Las acciones BOOK, PEDIDO, STAY_QUOTE, STAY_REQUEST y HANDOFF son mutuamente excluyentes; una respuesta conflictiva falla cerrado. `##VENTA##`/`##PEDIDO##` simples se conservan solo como respaldo legacy y `##BOOKING##` se limpia por compatibilidad.

---

## Modo menú estilo banco

**Modo MENÚ estilo banco — RETIRADO el 2026-08-16** (existió del 2026-07-19 al
2026-08-16). El CÓDIGO conducía TODA la conversación con opciones generadas de
los datos reales y la IA no participaba en ningún mensaje: máquina de estados
por conversación, carrito con total en centavos del catálogo, y lo que no
coincidía repetía las opciones (fallo cerrado, jamás inventaba).

Era la respuesta a «pedir por chat sin que el modelo invente nada», y la mini
app resuelve lo mismo mejor: mismo cero-IA en el pedido, pero con fotos,
carrito y el motor de opciones entero. Salió en la fase 3 de dejar Umbani solo
con domicilios.

⚠️ **Los negocios que estaban en `menu` pasaron a `miniapp`, no a `ai`.** Es la
traducción honesta: habían elegido que el pedido no lo condujera un modelo, y
`miniapp` conserva esa promesa mientras que `ai` la rompería justo en lo que
descartaron. Quedan dos modos.

⚠️ Sobrevive `services/saludo.ts` (`esSoloUnSaludo`), que vivía en `bot-menu.ts`
pero no era del menú: decide cuándo el modo mini app manda el enlace.

---

## Reportes del dueño

**Reportes del dueño (`server/src/services/reports.ts`):** NO son etiquetas ni function-calling. Son una **capa de intención server-side** que corre en `bot-conversation.ts` ANTES del flujo de atención: si quien escribe es el `owner_phone` del negocio y el texto pide un reporte, se responde el reporte (texto plano WhatsApp) y se corta; si no es el dueño o no es un reporte, devuelve `handled:false` y sigue el flujo normal. Sus cálculos, dashboard y alertas están tipados y todos reciben el `business_id` ya resuelto. Las ventas se registran a mano desde el panel del cliente (tablas `sales` + `sale_items`).

---

## Capacidad de citas (retirada)

**RETIRADA el 2026-08-16, fase 2 de dejar Umbani solo con domicilios.** La agenda simple usaba `create_booking_if_available` para conservar capacidad única bajo una restricción de exclusión `gist`: dos clientes no podían quedarse con el mismo hueco ni escribiendo a la vez. El cobro se coordinaba fuera de la plataforma y atender la cita registraba la venta.

⚠️ **Lo que NO se fue con ella: `business_schedule`.** Vivía en el mismo módulo —mismo repositorio, mismas rutas— y por eso parecía parte de la agenda, pero decide otra cosa: si la tienda acepta pedidos y si el bot atiende o contesta que está cerrado. Borrarla habría dejado a un negocio de domicilios sin horario. El horario se mudó a `routes/schedule.routes.ts` y `db/repositories/schedule.ts` antes de borrar el resto; `slot_duration` se quedó en la tabla, muerta, porque reescribir los horarios de todos los negocios para soltarla no aporta nada.

El permiso `citas` daba acceso a Citas **y** a Horarios. Sin citas solo queda Horarios, así que se renombró a `horarios` — y la migración lo reescribe en `client_users.permissions`, porque el valor está guardado en cada fila y sin eso los empleados habrían perdido el acceso en silencio.

El prompt sigue inyectando la fecha de hoy para que el modelo nunca haga aritmética de fechas.

**Hospedaje: RETIRADO el 2026-08-16.** Fue un dominio separado, con inventario agregado por tipo de habitación y noche, cotizaciones oficiales y holds bajo lock por negocio contra la sobreventa. Salió entero en la fase 1 de dejar Umbani solo con domicilios: no compartía una sola tabla con el pedido, que es justo lo que lo hacía separable. Su código vive en el historial del PR de esa fase.

---

## Salud del canal

**Salud del canal (`server/src/services/channel-health.ts`):** responde la única pregunta que importa cuando el bot calla — *¿están entrando mensajes?*. Nació de un incidente real (26–31 jul 2026): un trigger reventaba al insertar en la cola, el webhook respondía 503, YCloud dejó de entregar y el bot estuvo **cinco días mudo** mientras `/api/health` seguía en verde porque el proceso vivía. Trabaja en dos tiempos: `recordWebhookFailure` deja constancia **en el acto** de cada entrega rechazada (con su código y motivo, nunca credenciales ni el mensaje), y `diagnoseChannels` clasifica cada negocio activo en `ok` · `silencio` · `nunca_recibio` · `sin_canal` comparando su último entrante contra `DEFAULT_SILENCE_HOURS` (12 h). Los suspendidos o inactivos se omiten: su silencio es esperado y alertar por ellos volvería el aviso ruido de fondo. Se consume en `GET /api/admin/channel-health` (solo superadmin) y se pinta en el Dashboard del admin. ⚠️ `/api/health` **informa** del canal pero su `ok` sigue reflejando solo si el proceso puede trabajar: Railway usa esa ruta como healthcheck y un canal en silencio devolviendo 503 reiniciaría el contenedor en bucle, convirtiendo un aviso en una caída.

---

## Evals del bot

**Evals del bot (`server/evals/`, `npm run evals -w @botpanel/server`):** ~20 conversaciones doradas corridas contra la IA **de verdad**, con el prompt real. Es la única capa que ve bugs de comportamiento: el CI puede estar entero en verde mientras la IA inventa un precio o promete algo que no existe. Cubre pizzería y tienda, y verifica que no cite precios inexistentes ni regale descuentos, que emita la etiqueta correcta (`##PEDIDO##`), que no invente productos ni disponibilidad, que jamás genere enlaces de pago, y que resista la inyección de prompt ("ignora tus instrucciones") o que le pidan datos de otro negocio. Los casos aceptan `historial` para llegar al pedido en varios turnos, como hablan los clientes reales. ⚠️ **Gasta dinero** (llamada real por caso, céntimos por corrida) y por eso **NO corre en el CI**: se lanza a mano antes de una demo o al cambiar el prompt o el modelo. Para añadir casos basta copiar uno en `evals/casos.mjs` y cambiar `mensaje` y `espera` — el runner los recoge solo. `EVAL_AI_PROVIDER` fija el proveedor.

---

## Vigilante de precios

**Vigilante de precios (`server/src/services/price-guard.ts`):** hace cumplir la regla inviolable #8 en la salida — todo monto que escriba la IA se confronta con el catálogo real del negocio. Acepta precios del catálogo (`price` y `price_sale`), múltiplos enteros de ellos (2 × $95 = $190) y cifras que el propio servidor calculó en ese turno; lo demás se considera inventado. Solo mira cifras con **moneda explícita** (`$95`, `95 dólares`, `USD 95`): sin ese filtro, «3 noches», «10:00» o un número de teléfono se leerían como precios y el vigilante sería inservible de puro ruidoso. Si el negocio no tiene precios cargados no acusa a nadie. ⚠️ **Arranca en modo `observar` a propósito** (`PRICE_GUARD_MODE`, por defecto observar): registra el hallazgo como categoría `ia` en el registro de errores **sin cortar la conversación**, porque un falso positivo dejaría a un cliente real sin respuesta. Solo cuando los datos confirmen que no hay falsos positivos se pasa a `PRICE_GUARD_MODE=bloquear`, y entonces descarta el mensaje y deriva. Convive con `bot-tags.impersonatesOfficialSummary`, que cubre el caso hermano de imitar un resumen oficial completo.

---

## Vigilancia de credenciales

**Vigilancia de credenciales (`server/src/services/credential-monitor.ts` + `integrations/provider-status.ts`):** cada 6 h revisa SOLA, negocio por negocio, que el canal siga en pie: API Key aceptada por el proveedor, número presente en la cuenta y `CONNECTED`, **webhook activo apuntando a `BASE_URL` y suscrito a los mensajes entrantes**, y saldo por encima de `SALDO_MINIMO_USD`. El panel ya permitía verificar credenciales a mano (`/api/admin/clients/:id/verify`), y precisamente por eso en julio de 2026 nadie se enteró de nada durante cinco días: la comprobación existía, pero nadie la ejecutó. Cada problema se registra en el log de errores como categoría `canal`, así que aparece en el panel sin que nadie tenga que preguntar. Los negocios suspendidos o inactivos se omiten (sus credenciales pueden estar caducadas a propósito). `ProviderClient` es inyectable para poder probar cada escenario sin tocar los proveedores reales. ⚠️ `getAllBusinessesWithSecrets()` existe SOLO para esto y **no debe exponerse en ninguna ruta**: lo que va al panel pasa antes por `sanitizeBusinessForAdmin`.

---

## Registro de errores

**Registro de errores (`server/src/services/error-log.ts` + `migration-registro-errores.sql`):** deja rastro consultable de los fallos que antes solo vivían en los logs de Railway. Cubre cuatro categorías — `canal` (webhooks, cola), `ia` (proveedor sin saldo, key inválida, timeout), `envio` (mensajes que no salieron) y `servidor` (excepciones 5xx). **Dos reglas que no se negocian:** (1) *nunca rompe a quien lo llama* — todo va envuelto y los fallos del propio logger se tragan, porque un logger que tumba el servidor es peor que no tener logger; (2) *nunca guarda datos personales ni credenciales* — el log está pensado para descargarse en CSV y compartirse, así que `sanitizeErrorText` borra teléfonos, correos, JWT y claves antes de persistir. **Agrupa por huella** (`errorFingerprint`, calculada en Node y **no** con `digest()` en SQL, que es justo lo que tumbó el canal cinco días): mil repeticiones son una fila con `occurrences: 1000`, lo que evita inflar la tabla y responde mejor a "cuánto lleva fallando esto". Se lee en `GET /api/admin/errors` y `GET /api/admin/errors/export` (solo superadmin) y se purga a los 30 días. La tabla `platform_errors` admite `business_id` nulo para errores de plataforma, y el código tolera que la migración aún no se haya corrido: sin ella la vigilancia del canal sigue respondiendo.

---

## Mini app de la tienda

**Mini app de la tienda (`apps/store`, servida en `/t/:slug`) — decisión 2026-08-01:** la app que el cliente final abre desde el enlace que le manda el bot. **UNA sola app, pero el flujo lo elige la CAPACIDAD del negocio, nunca su `type`** (`storefrontCapabilities` en `server/src/services/storefront.ts`): `takes_orders` pinta el flujo tipo delivery (categorías → producto con variantes y extras → carrito → pedido). Un negocio sin esa capacidad devuelve `no_disponible` en vez de abrir una app vacía. ⚠️ Hasta el 2026-08-16 hubo un segundo flujo, tipo Booking, para `lodging_enabled`; se retiró con el módulo de hospedaje. **El CATÁLOGO es público desde el 2026-08-05**: ver la carta y los precios no pide enlace (`readStorefrontSession`), porque un enlace de comida se reenvía, se pega en una historia y se busca — y quien llegue tiene que poder mirar antes de dar su número, como en cualquier tienda. **Pedir sí lo exige**, y ahí está toda la diferencia: `req.storefront` se puebla SOLO con una sesión completa y válida para ESE negocio, nunca a medias, así que ninguna ruta puede acabar creando un pedido sin cliente; un token inválido, revocado o de otro negocio deja mirar la carta y no identifica a nadie. El 401 de la petición de pedido es lo que lleva a `Gate.tsx` o a confirmar el teléfono. **Sin JWT: la credencial para pedir es el enlace**, validado por `requireStorefrontSession` — el token se borra de la barra de direcciones al leerlo (una captura compartida no regala la sesión) y queda atado al dispositivo, así que un enlace reenviado cae en `Gate.tsx`, que explica que cada enlace es personal y ofrece el WhatsApp del negocio. **Ningún importe viaja desde el teléfono**: la app manda ids y cantidades y el total lo calcula `create_storefront_order` (regla inviolable #8); los precios que pinta `apps/store/src/lib/cart.ts` son solo para que el cliente vea algo mientras elige. **Solo se abre desde el móvil** (`apps/store/src/lib/device.ts`, decidido 2026-08-01): en una computadora se muestra «Abre este enlace desde tu celular» y no se pide nada con sesión. Es **fricción, no seguridad** —quien sabe abrir la consola sabe cambiar el modo móvil— y conviene no confundirlo: la consola no revela nada porque el frontend no guarda secretos y los precios los recalcula el servidor. La detección mira el identificador del navegador **y** las señales físicas de la pantalla, porque un iPad en modo escritorio dice ser un Mac; ante la duda deja pasar, ya que bloquear un teléfono real pierde una venta en silencio mientras que dejar mirar a un curioso no cuesta nada. El bloqueo va **antes** de cualquier petición con sesión, y ese orden importa: la portada es pública y no reserva el enlace, así que un clic desde WhatsApp Web lo deja intacto para cuando la persona lo abra en su teléfono (verificado contra el servidor real). Deliberadamente **sin router ni cliente de datos** (~82 kB gzip, con un presupuesto de 86 vigilado por `apps/store/tests/presupuesto-tamano.mjs` en cada PR): se abre con datos móviles, y cada kilobyte se paga en clientes que cierran antes de que cargue. Rutas en `server/src/routes/storefront.routes.ts`. **El enlace lo manda el bot** (`server/src/services/storefront-link.ts`): lo arma el CÓDIGO y un token recién creado, nunca la IA —un modelo que «recuerde» una URL manda a la gente a una pantalla de error—. Como el token solo se guarda hasheado, un enlace enviado **no se puede reconstruir ni reenviar**: cada petición crea uno nuevo, y por eso hay un freno de 10 minutos por contacto (`RESEND_COOLDOWN_MS`) para que un «hola» repetido no llene la tabla ni parezca un bot roto. Los anteriores NO se revocan, para no romperle el pedido a quien lo tenga abierto. **Es corto a propósito: `/s/<token>`** (~68 caracteres en producción, frente a los ~130 del formato anterior). El slug NO viaja —el token ya identifica al negocio— y el token bajó de 256 a 128 bits (43 → 22 caracteres, la misma entropía que un UUID v4). No es cosmética: un enlace largo en un chat se lee como spam y el cliente no lo toca. La ruta `GET /s/:code` resuelve y redirige a `/t/<slug>?s=<token>`; **no devuelve datos nunca, solo redirige**, y por eso vive sin sesión — con un token inventado no se averigua nada (redirige a `/t/_`) y quien llega con el suyo ya lo tenía. Un dominio propio lo dejaría en ~40 caracteres. ⚠️ **Que el enlace abra dentro de WhatsApp o en el navegador del teléfono NO se controla desde aquí**: lo decide el ajuste del cliente. Lo único que se queda de verdad dentro son los WhatsApp Flows, descartados por exigir cuenta Meta verificada. Va como mensaje propio DESPUÉS de la respuesta del asistente. Si falla algo —sin `BASE_URL`, base caída— devuelve null y el bot atiende por chat como siempre. **Desde el 2026-08-12 viaja como BOTÓN nativo, no como URL cruda** (`interactive.type: 'cta_url'` de WhatsApp, vía YCloud): una URL pegada en el chat ocupa tres líneas, se parte en pantallas estrechas y se lee como publicidad — el mismo motivo por el que el enlace ya se había acortado a `/s/<token>`. El texto plano NO se retiró y ahí está lo importante: es el respaldo cuando el canal no admite botones (Telegram, Meta directo, el simulador) o cuando YCloud rechaza el envío, y es lo que se guarda en el historial para que el dueño vea en su panel a dónde apuntaba lo que se mandó. `sendLinkButton` devuelve `false` en vez de lanzar, precisamente para que un botón fallido no deje sin enlace a un cliente que en modo mini app no tiene otra forma de pedir. ⚠️ La etiqueta del botón se mide en **BYTES, no en caracteres** (tope 20): «🛍️ Ver la carta» son 15 caracteres y 23 bytes, y WhatsApp lo rechazaría — por eso va sin emoji y recortada por bytes. ⚠️ Es un mensaje de formato libre, así que vive bajo la MISMA ventana de 24 h que el texto de siempre: no es una limitación nueva, el enlace sale siempre respondiendo a un mensaje del cliente. **Y desde el 2026-08-12 el enlace SALE SIEMPRE en modo mini app**: el reclamo de 24 h (`claim_storefront_link_send`) dejó de decidir si hay enlace y pasa a decidir cómo se dice — «Mira la carta» la primera vez, «Aquí tienes tu enlace otra vez» después. Antes, dentro de esas 24 h se contestaba `MINIAPP_RECORDATORIO` («usa el enlace que te envié») **sin enlace**, y quien había borrado el chat, cambiado de teléfono o archivado la conversación se quedaba sin forma de pedir. No era teórico: en la conversación real de Monster Pizza hay un cliente pegando la URL de la tienda en el chat dos veces para intentar entrar, y las dos veces recibió ese muro. El freno no ahorraba nada donde duele —se contesta un mensaje igual en los dos casos, así que el coste en WhatsApp es idéntico—; lo único que ahorraba era una fila de `storefront_sessions`, en una tabla que llevaba **nueve** filas acumuladas. El recordatorio de texto sobrevive solo para el negocio sin tienda utilizable, que es el único caso donde de verdad no hay a dónde mandar a nadie. La llamada al reclamo se conserva porque hace algo más de paso: crea la fila de `business_customers` si no existe. **El comprobante de transferencia se manda por el CHAT desde el 2026-08-12** y la subida desde la app se retiró (eran dos caminos para lo mismo, y el de la app era el que casi nadie tomaba: la captura del banco queda en la galería, a un toque de la conversación). La foto que llega por WhatsApp se adjunta sola al pedido con la MISMA RPC (`services/payment-proof-inbox.ts`), así que el dueño no nota diferencia; la ruta `POST /orders/:id/proof` sigue viva y protegida, sin llamador desde la app. Con ello se retiró también la pantalla de seguimiento: el pedido se sigue por los tres avisos de WhatsApp y por el estado en texto de la pestaña Cuenta. **Lo construido el 2026-08-05** sigue rigiendo para el almacenamiento, que es privado: ver [Mini app de la tienda → comprobantes](#mini-app-de-la-tienda) y la regla de `payment_proof_public_id` en CLAUDE.md — se sube a Cloudinary como `authenticated` y solo se ve con una firma temporal de 10 minutos, nunca desde una URL permanente.

**Rediseño de la tienda (2026-08-06):** el flujo de comida pasó a la línea del diagrama aprobado — portada del local con estado y horario, buscador, categorías en círculos, pestañas sticky, bandas grises entre secciones, rejilla de dos columnas con la foto arriba y barra inferior fija. La estructura entera está en **[DISENO-MINIAPP.md](DISENO-MINIAPP.md)**, incluido qué se apartó del diagrama y por qué. Tres cosas que no son de estilo y conviene saber antes de tocarlo: **(1)** la pestaña activa la decide el SCROLL mediante un `IntersectionObserver` con una línea de lectura bajo las pestañas, y durante un salto programático el subrayado se congela —sin eso, tocar una pestaña lo hace parpadear por todas las secciones del camino—. **(2)** Elegir entrega o retiro **dejó de vivir dentro del carrito**: ahora se decide también en la portada, así que el estado subió a `FoodStore` y las tres reglas que colgaban de él viven en `apps/store/src/lib/cart.ts` (`ENTREGA_POR_DEFECTO`, `needsAddress`, `orderTotal`) con una prueba cada una. Escondido en el componente no se podía comprobar, y elegir «Retiro» arriba volvía a «Entrega» al abrir el carrito. **(3)** El caso **sin foto es el normal**, no la excepción: hoy ningún producto tiene imagen, y el marcador con la inicial sobre el color del negocio existe para que dieciséis huecos grises no parezcan la app rota. ⚠️ La portada del diagrama sigue **incompleta a propósito**: `cover_url` y `min_order` no existen en la base.

**Cuánto tarda el negocio (2026-08-06):** `businesses.prep_time_minutes` y `businesses.delivery_extra_minutes`, con el valor inicial recomendado por el tipo (`prepTimeForBusinessType`) y editables por el dueño en `Ajustes → Tu tienda`. Antes era **30 minutos fijos para todos**, escrito a mano en la ruta de la tienda: una heladería que sirve en cinco y un asadero que tarda cuarenta ofrecían las mismas franjas, así que a uno le escondíamos media hora de ventas y el otro prometía lo que no podía cumplir. **No es un texto de portada: `prep_time_minutes` decide desde qué hora se puede PROGRAMAR un pedido**, y por eso vivía en DOS sitios —la lista de franjas y su validación— que ahora salen de una sola función (`prepOptions`); separarlos no rompe de golpe, deja que la validación acepte horas que la lista no ofrecía. El de entrega **no** entra en las franjas: la franja es la hora en que el pedido está listo, no en que llega. El dueño configura UN número y la app pinta un rango de +10 min (`rangoDeEspera`), como las apps de delivery — un número exacto se lee como promesa al minuto. ⚠️ Hasta el 2026-08-16 los negocios de citas no usaban nada de esto: su tiempo iba por la agenda, que ya no existe. Detalle completo en [DISENO-MINIAPP.md](DISENO-MINIAPP.md#cuánto-tarda-el-negocio).

**Quien escribe por molestar (2026-08-13):** el enlace sale siempre desde el 2026-08-12, así que cada mensaje recibe respuesta y desde octubre cada respuesta se paga. Dos frenos con naturalezas distintas. El **techo** (`claim_miniapp_reply`) es automático y **temporal**: 5ª respuesta en una hora → el mismo mensaje añade el teléfono del local, 10ª → silencio de 24 h. Es temporal porque un contador no puede condenar a nadie: quien escribió doce veces un martes puede ser un cliente agobiado, y el histórico real de Monster Pizza tenía una hora con **13 mensajes** de uso legítimo — con un techo de 3 o 5 se cortaría a clientes de verdad. ⚠️ **El silencio no se levanta al cambiar de hora**, y ese es el detalle que hace que el número del techo importe poco: con una ventana rodante, quien molesta con paciencia pagaría el techo entero cada hora (240 mensajes al día en vez de 10). El **bloqueo** (`business_customers.blocked_at`) lo pone el dueño desde `Conversaciones`, no caduca y es **total** — bot mudo en todos los modos y 403 al crear pedido, porque un bloqueo que solo calla al bot deja al bloqueado pidiendo con su enlace guardado. ⚠️ Al bloqueado **nunca** se le avisa: quien busca reacción no puede recibirla, y el aviso cuesta el mismo mensaje que se ahorra. En ambos casos el mensaje **se guarda** y la conversación se marca no leída: callar no es dejar de ver. Ante un fallo de base se **atiende** —quedarse mudo por un problema propio pierde un cliente real—, y el comprobante se contesta aunque esté silenciado, porque quien acaba de pagar no es quien molesta. El contador vive en PostgreSQL y no en memoria: es el mismo error que ya se corrigió con el envío del enlace, y aquí sería peor —el que molesta solo tendría que esperar a un despliegue.

---

## El horario del dueño manda sobre todos los modos

**El horario del dueño manda sobre TODOS los modos (corregido 2026-08-01):** la comprobación de `isOutsideHours` va **antes** de repartir por `chat_mode`. Hubo dos excepciones que convertían el horario en decoración y la segunda no se veía: un modo salía por su propia rama antes de mirar el reloj, así que atendía domingos y de madrugada aunque su horario dijera lo contrario. Cubierto por tests que fallan si el orden se invierte. ⚠️ Ojo con el caso legítimo: si **ningún** día está activo, `isOutsideHours` devuelve `false` a propósito —un negocio que nunca configuró horario no puede quedarse mudo—; cerrar el domingo es marcar ese día inactivo con los demás activos.

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

**El agujero que cerró (2026-08-02):** TODOS los reportes del dueño —ventas, dashboard, directorio de clientes, productos más vendidos, clientes perdidos— leen la tabla `sales`, y `sales` solo se llenaba con el botón «Registrar venta» del panel. Un pedido de la tienda o del bot se entregaba y **no aparecía en ningún número**. El negocio vendía y sus reportes decían que no.

**El estándar que se establece:** cada bandeja donde el negocio atiende **desemboca en `sales`**. Así los reportes tienen una sola fuente de verdad y no hay que volver a tocarlos cuando se añada un flujo nuevo. Tras retirar hospedaje y citas quedan dos caminos —pedido entregado y pedido de mostrador—, pero la regla es la misma.

Cómo está hecho, y por qué así:

- **Cuenta al marcarlo ENTREGADO**, no al aceptarlo: es cuando el dinero está de verdad en el negocio, y un pedido rechazado o cancelado nunca ensucia el reporte.
- **La conversión vive DENTRO de `set_order_status`, no en un disparador.** En este proyecto un trigger mal colocado ya tumbó el alta de clientes durante meses (2026-08-02); aquí el camino es explícito y se lee de una vez. Al ir en la misma transacción, nunca queda un pedido entregado sin su venta.
- **`sales.order_id` con índice único parcial.** No es higiene: es lo que impide que marcar «entregado» dos veces —o reintentar tras un fallo de red— duplique el dinero del reporte. La función además comprueba si ya existe antes de insertar.
- **El total de la venta incluye el envío** (es el dinero que entró), pero los `sale_items` son solo productos: así «lo más vendido» no se ensucia con una línea de envío que nadie pidió. El nombre del ítem congela su variante — «Pizza (Mediana)» es lo que el dueño reconoce tres meses después.
- **La migración recupera el pasado:** al aplicarse, cualquier pedido ya entregado sin venta la genera. Con la base en cero no hace nada; en una base con historial, devuelve al reporte lo que nunca contó.

Verificado contra un PostgreSQL real: aceptar/preparar/despachar NO crean venta, entregar sí, entregar dos veces no duplica, un pedido rechazado no aparece, y otro negocio no puede convertir en venta un pedido ajeno.

**El pedido de mostrador** (lo que se vende en persona) entra por el MISMO camino: nace `completado` con `source = 'manual'` y `create_order_with_items` le crea la venta dentro de la propia función. Si fueran dos llamadas desde Node, un fallo entre ellas dejaría un pedido cobrado sin venta. ⚠️ `orders.contact_phone` es NOT NULL pero en un mostrador casi nunca hay teléfono: se guarda el literal `'mostrador'` y la venta lo convierte a nulo con `nullif`. Sin eso, el directorio de clientes acabaría con un cliente fantasma de cientos de compras que arruinaría «frecuentes» y «clientes perdidos».

**Una CITA atendida también era una venta** (2026-08-02 → 2026-08-16). Llevó el
estándar a servicios: la cita apuntaba al servicio del catálogo con clave
foránea COMPUESTA, congelaba su precio, se podía fijar el importe en la misma
llamada que el estado —porque la mayoría las agendaba el bot, que no negocia
precios— y una cita sin precio se atendía igual sin generar venta.

Se retiró con la agenda en la fase 2 de dejar Umbani solo con domicilios. Lo
que dejó y sigue vigente es el criterio: la conversión se ENVUELVE y cuenta en
el momento en que el negocio se compromete, no al terminar el servicio.


## Los tres modos de atención

**La incoherencia que cerró (2026-08-02):** `chat_mode` solo tenía `'menu'` y `'ai'`, y el enlace de la mini app **se mandaba en los dos**. Un negocio recién creado recibía el menú de botones **y** el enlace a la vez: dos formas de hacer lo mismo compitiendo en el mismo chat. Lo detectó el dueño del SaaS creando negocios nuevos, no un test.

Desde ahora cada negocio atiende de **una** forma, y el enlace **pertenece a un modo concreto**:

| Modo | Quién conduce | Dónde se pide | ¿Enlace? |
|---|---|---|---|
| `ai` | La IA, conversando | Por chat (`##PEDIDO##`) | **No** |
| `menu` | El código, con botones | Por el menú | **No** |
| `miniapp` | La IA resuelve dudas | En la mini app | **Sí**, al saludar |

- **En modo IA puro tampoco:** ese negocio eligió atender y vender por chat. Mandarle el enlace sería meterle una app que no pidió.
- **El enlace es lo que DEFINE el modo mini app.** Va como mensaje propio *después* del saludo del asistente —al revés se lee como publicidad antes de responderle a la persona— y **solo ante un saludo**: quien ya pregunta algo concreto quiere su respuesta, no un enlace.

**El modo se propone según el tipo al dar de alta y se puede cambiar siempre.** Con tienda (restaurante, tienda, hotel) → `miniapp`; barbería o consultorio → `menu`, que es más barato y predecible que la IA para elegir de una lista corta; catálogos enormes y consultoría → `ai`. ⚠️ Como el resto de recomendaciones por tipo, **solo PROPONE al crear**: el `chat_mode` persistido manda siempre y jamás se sobrescribe a un negocio existente. Una pizzería que quiera «solo chat» se queda en `ai` o en `menu` aunque tenga tienda.

La migración pasa a `miniapp` los negocios que ya tenían tienda encendida: son exactamente los que estaban recibiendo menú y enlace a la vez.

---

## El cuarto camino: hospedaje (RETIRADO)

**Existió del 2026-08-02 al 2026-08-16.** El ingreso por hospedaje se calculaba
aparte, en `reports.computeLodgingIncome`, y dejaba al dueño de un hostal con
dos números que no se juntaban. Se unificó como los demás: la estadía
confirmada registraba su venta en `sales`, así que los reportes tenían una sola
fuente de verdad.

Se retiró entero con el módulo de hospedaje, en la fase 1 de dejar Umbani solo
con domicilios. Quedan **tres** caminos, y el estándar sigue siendo el mismo:

```
Pedido entregado    → venta
Pedido de mostrador → venta
Cita atendida       → venta
```

Lo que aquel trabajo dejó y **sigue vigente** es el criterio: la conversión se
ENVUELVE, no se reescribe (`crear_venta_desde_pedido` y `crear_venta_desde_cita`
siguen así), y cuenta en el momento en que el negocio se compromete, no al
terminar el servicio.

### Un agujero que destapó

Al añadir la v2, el guardián de cobertura de RPCs **no la exigía probada**: su extractor buscaba `[a-z_]` y el nombre lleva un dígito. **Cualquier función con número en el nombre se le escapaba.** Corregido a `[a-z0-9_]`, y con eso el guardián reclamó de inmediato que la v2 se ejecutara contra PostgreSQL real, que es justo su trabajo.


---

## Lo que gana la plataforma

**El motor de margen (2026-08-16).** Hasta esta fecha el SaaS tenía **una sola fuente de ingreso: la cuota mensual**. Un pedido no dejaba nada y no existía ni una columna que dijera cuánto de lo que pagó el cliente era de la plataforma. El motor calcula, congela, acumula y factura — y se instaló **apagado**: sin reglas cargadas el margen es 0 y nadie paga un centavo de más.

**Por qué es una tabla y no un porcentaje.** Un restaurante y un supermercado no se pueden cobrar igual, y es la razón entera del módulo:

| | Ticket | Margen del comercio | Un 8 % le costaría |
|---|---|---|---|
| Restaurante | $15 | Amplio | $1.20 — nadie se inmuta |
| Supermercado | $80 | 2–5 % | $6.40 — **más de lo que gana** |

De ahí los tres frenos, y cada uno protege a alguien distinto:

- **`max_amount` (techo)** protege al comercio de volumen: «4 %, máximo $3» deja una canasta de $150 en $3 y no en $6.
- **`min_amount` (piso)** protege a **la plataforma**. No es simetría: cada pedido cuesta mensajes de WhatsApp —Meta los cobra desde el 1 de octubre de 2026— y llamadas de IA. Un pedido de $2 al 8 % deja $0.16 y puede costar más que eso en mensajes, así que **sin piso los pedidos pequeños se atienden a pérdida**. Es la rentabilidad real por pedido, no el ingreso bruto.
- **`tiered`** cubre lo que no alcanzan los otros dos.

**Dónde se sella, y por qué ahí.** El margen lo escribe el disparador `orders_stamp_pricing`, **no** una versión nueva de `create_storefront_order`. Es el mismo criterio que ya siguió `orders_reject_blocked`: recrear la función del dinero por un añadido pequeño no compensa el riesgo de copiar la versión equivocada desde `schema.sql`, donde conviven varias definiciones. Un disparador cubre además los TRES caminos —tienda, bot y mostrador— y cualquiera que se invente después, sin que nadie tenga que acordarse de llamarlo.

**Falla ABIERTO.** Sin regla aplicable el margen es 0 y el pedido sigue su camino. Equivocarse por defecto cuesta una comisión; equivocarse al revés cuesta el servicio entero de ese día, así que un problema de configuración de precios no puede dejar a una pizzería sin poder vender.

**El pedido congela su regla.** Guarda `pricing_rule_id` y `pricing_rule_version`, así que subir el porcentaje mañana no reescribe el margen de los pedidos de hoy — igual que cambiar un precio no reescribe lo ya cobrado. Reemplazar una regla crea una VERSIÓN nueva y archiva la anterior en vez de editarla en sitio, por lo mismo. Y las archivadas no se borran: un pedido apunta a la suya sin clave foránea, así que borrarla dejaría «¿por qué a este le cobramos $3?» sin respuesta.

**El acumulado se suma sobre `sales`, no sobre `orders`.** Un pedido aceptado o en preparación todavía no es dinero: la venta nace cuando se ENTREGA, que es el estándar que ya seguían todos los reportes del dueño. De ahí salen dos cosas gratis, sin construir nada: un pedido cancelado nunca llega a `sales` y no genera comisión, y una venta anulada deja de contar.

### Tres casos límite que se encontraron auditando

Ninguno había fallado, porque producción seguía sin comisiones — que es exactamente cuándo salen baratos:

1. **El mes terminaba en Londres.** `sold_at` es `timestamptz` y las fechas del cierre llegaban como `date`, comparadas en la zona de la sesión (UTC en Supabase). Una venta del 31 de agosto a las 20:00 en Ecuador son las 01:00 UTC del 1 de septiembre: se facturaba en el mes siguiente. **No es un caso raro — son las cinco últimas horas de CADA día**, la franja de más ventas de un restaurante, así que cada cierre movía la última noche entera. El mismo error vivía en Node: las tres rutas calculaban «el mes actual» en UTC.
2. **Se cobraba comisión sobre los descuentos.** El margen salía de `subtotal`, el precio ANTES del descuento. Hoy `orders.discount` es siempre 0, pero la columna existe y `create_order_with_items` la acepta: el día que se usara, el error aparecería en silencio y en todos los negocios a la vez.
3. **`on_top` prometía algo que no hacía.** El disparador restaba igual, así que era `absorbed` con otro nombre. Aplicarlo de verdad exige que el catálogo, el carrito y el resumen pinten el precio con margen, o el cliente descubriría el precio real al confirmar. El CHECK lo cierra hasta entonces — **falla CERRADO, igual que `scope` con `category`: no se puede guardar una regla que el motor no vaya a honrar**. El cálculo se queda escrito y probado en `platform-pricing.ts` para no improvisarlo el día que las tres pantallas estén listas.

### Pensado para ciudades grandes desde el principio

Con un local cualquier cosa funciona; con los miles de una ciudad grande, tres cosas dejan de ser opinables:

- **El cierre es UNA operación por conjuntos, no un bucle.** Un `for negocio in ... loop` haría una consulta por local: con 5.000 son 5.000 idas y vueltas y un cierre que tarda minutos y se cae a la mitad. Es un solo `insert ... on conflict`, todo o nada — que además cierra la carrera de leer-y-luego-escribir con dos instancias del servidor.
- **Los índices se verifican con `EXPLAIN`, no se suponen.** `idx_sales_biz_date` empieza por `business_id` y no sirve para «todas las ventas de agosto»: se leería la tabla entera. `idx_sales_cierre` va por `sold_at` y solo sobre las completadas, que son las únicas que se cobran.
- **Idempotente por naturaleza.** El cierre no suma: RECALCULA desde `sales` y escribe el valor absoluto. Correrlo tres veces deja el mismo número, y es lo que permite que exista una tarea diaria sin miedo a cobrar el doble tras un reintento.

⚠️ **Un mes ya `paid` no se reescribe jamás.** Si una venta se anula después de liquidar, se descuenta del mes SIGUIENTE. Un número que el comercio ya vio y pagó no puede cambiar bajo sus pies. Y `billing.amount` sigue siendo la CUOTA: la comisión va en `commission_amount` porque sumarlas dejaría al comercio sin distinguir qué paga por el servicio y qué por sus ventas.
