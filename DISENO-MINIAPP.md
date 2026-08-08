# Diseño de la mini app — especificación

Respaldo escrito del diagrama aprobado por el dueño el **2026-08-05**. No
sustituye a la imagen: si la tienes, míralas juntas. Esto existe para que la
referencia no se pierda entre sesiones, de máquina a máquina o dentro de un mes.

> ⚠️ **Lo que se adopta del diagrama es la ESTRUCTURA, no la paleta.** El
> diagrama está pintado en rojo porque es la maqueta de una pizzería concreta.
> El color real sale de `businesses.brand_color`, y el de la plataforma es el
> lima `#D9F950`. Un negocio con marca azul tiene que verse azul, y por eso el
> motor de la tienda nunca fija un color de marca en el CSS.

---

## Principios

1. **Móvil primero, y de verdad.** Se abre desde el navegador interno de
   WhatsApp, con datos móviles y una mano. Nada de hover, nada que dependa de
   pantalla ancha.
2. **La foto manda.** En la rejilla ocupa media tarjeta. Sin fotos, este diseño
   no funciona — no es un problema de CSS.
3. **El precio siempre visible.** En la tarjeta, en la ficha y en la barra
   inferior. El cliente no debería tener que buscarlo nunca.
4. **Un solo acento.** El color de marca se reserva para lo accionable y para
   el estado «obligatorio». Si todo destaca, no destaca nada.

---

## Las once pantallas del flujo

El diagrama recorre el viaje entero, de WhatsApp a la entrega:

1. El cliente escribe por WhatsApp
2. Abre el enlace de la mini app
3. Explora categorías y productos
4. Personaliza el producto
5. Opciones obligatorias y opcionales
6. Complementos incluidos (los del combo)
7. Adicionales independientes
8. Checkout
9. Confirmación
10. Seguimiento del pedido

---

## 1. Portada del local

De arriba abajo:

- **Portada** a sangre completa, con el **logo** del negocio superpuesto.
  Construida el 2026-08-07: `businesses.cover_url`, que el dueño sube desde
  `Ajustes → Tu tienda` con el mismo camino que el logo (Cloudinary) y el mismo
  CHECK (**solo https** — acaba en un `<img>` de una app pública, y dos reglas
  distintas para el mismo riesgo se desincronizan).
  · **Sin portada la cabecera se queda como estaba**, en bloque de tinta, en vez
    de dejar un hueco.
  · El **degradado sobre la foto no es decoración**: sin él, una portada clara
    deja el nombre blanco ilegible, y el negocio elige qué sube.
  · Si la imagen **no carga** —el dueño la borró de Cloudinary— se retira sola y
    vuelve la cabecera de tinta: el icono de imagen rota no puede ser la primera
    impresión de la tienda. Verificado con una URL inexistente.
- **Nombre** del negocio en grande, y debajo el **estado**: una píldora verde
  `Abierto` o gris `Cerrado`, con el horario del día al lado
  (`09:00 – 01:00`). El horario sale de `todaysHours` (ver más abajo).
- **Línea de servicio**: el **tiempo** está construido desde el 2026-08-06 y se
  muestra como rango (`25 – 35 min`) junto al horario, cambiando según el modo:
  quien retira no espera lo que tarda el repartidor. Sale de dos columnas que
  pone el dueño (ver «Cuánto tarda el negocio», más abajo).
  ⚠️ El **pedido mínimo** sigue sin construirse: no existe `min_order`, y
  pintarlo obligaría además a que el checkout rechazara los carritos por
  debajo, que es lógica de dinero y no de portada.
- **Dos botones de modo**, uno junto al otro: `Entrega $2.00` y `Retiro gratis`.
  El activo va con el color de marca; el otro, con borde. La decisión es **la
  misma** que la del carrito: se elige aquí o allí y las dos pantallas la
  reflejan (`ENTREGA_POR_DEFECTO`, `needsAddress` y `orderTotal` en
  `apps/store/src/lib/cart.ts`, probadas una por una).
- **Buscador** de ancho completo, con lupa a la izquierda.
- **Categorías en círculos** con su imagen, en fila horizontal desplazable:
  «Para ti», «Pizzas», «Combos», «Bebidas».
- **Barra inferior fija**. El diagrama pide cinco destinos (Inicio · Buscar ·
  Carrito · Pedido · Cuenta) y hoy hay **tres**: Inicio, Buscar y Carrito, con
  su contador. «Pedido» y «Cuenta» no se pintan porque **no tienen a dónde ir**
  —no existe pantalla de seguimiento ni de cuenta del cliente—, y una pestaña
  que no lleva a ninguna parte se siente rota. Entran aquí cuando existan.

## 2. Catálogo

- **Pestañas de categoría** horizontales y **sticky**, con **subrayado** bajo
  la activa. Se sincronizan con el scroll vertical en los dos sentidos: al
  desplazar cambia la pestaña, al tocar una pestaña salta a su sección.
- **Bandas grises** separando secciones, para que el ojo encuentre el corte sin
  leer.
- **Tarjetas de producto en rejilla de DOS COLUMNAS**, con la **foto arriba a
  sangre** (proporción 4:3) y debajo nombre, descripción en dos líneas como
  máximo y precio. El botón `+` circular va **sobre la foto**, abajo a la
  derecha. El precio promocional va junto al tachado.
- **Agotado**: la tarjeta baja de opacidad, lleva su etiqueta sobre la foto y
  el `+` desaparece.

> ⚠️ **Esto se aparta del diagrama a propósito** (decidido 2026-08-06). La
> pantalla 3 del diagrama dibuja una lista de UNA columna con la foto pequeña a
> un lado, y este documento la describía así hasta esa fecha. El dueño eligió
> la rejilla de dos columnas con la foto arriba, que es el formato que más
> depende de la fotografía — y por tanto el que más gana cuando existan las
> fotos y el que peor se ve mientras no existan. Si algún día se revierte, lo
> que manda es la imagen.

El `+` **no agrega a ciegas**: si el producto tiene grupos obligatorios o
variantes, abre su ficha para completarlos. Es la misma regla que ya seguían
los adicionales, y la que la base va a exigir igual al crear el pedido.

## 3. Ficha del producto

- **Foto grande** arriba, a sangre.
- Nombre, precio, descripción.
- **Los grupos de opciones**, uno por sección, con su título en mayúsculas
  pequeñas y a la derecha su estado:
  - `Obligatorio` en el color de marca mientras falta; `✓ Listo` en tono suave
    al cumplirse.
  - `Opcional` o `Hasta N` cuando no obliga.
  - Contador de avance: `3 de 7 seleccionados`.
- **Tres formas de elegir**, distinguibles por la forma sin leer:
  - `single` → círculo (radio). Tamaño, masa, término.
  - `multiple` → cuadrado (casilla) con tope.
  - `quantity` → contador `− n +` por opción.

  ⚠️ **Lo decide `singleChoice()` (`lib/cart.ts`), no `selectionType` a secas.**
  Un grupo guardado como `multiple` con máximo 1 es funcionalmente una elección
  única, y pintarlo con casillas confunde: el cliente marca una, no puede
  marcar otra y no entiende por qué. Pasó con los 19 sabores de pizza. La FORMA
  del control y el COMPORTAMIENTO al tocarlo salen de la misma respuesta, o
  aparece un radio que se puede desmarcar.

- ⚠️ **Un grupo no puede salir dos veces.** Los `extras` vienen de
  `menu_modifiers` (la tabla vieja, que el bot sigue usando) y los grupos de
  opciones del motor nuevo. Al construir el motor se copiaron los
  modificadores sin retirar los originales, así que un negocio con las dos
  cosas mandaba lo mismo por los dos campos y la ficha lo pintaba repetido.
  `buildStorefrontCatalog` descarta el extra cuyo grupo ya sirve el motor,
  comparando el nombre normalizado. Un negocio que solo tenga la tabla vieja no
  pierde nada.
- Las opciones que **son productos** (los combos) llevan su foto.
- **Píldoras** para las opciones cortas de un grupo `single` corto (Tradicional
  · Delgada · Pan Pizza), en lugar de una lista vertical. Lo decide
  `pillLayout()` (`lib/cart.ts`), y sus topes no son estéticos: **elección
  única** (varias marcadas en fila no se distinguen), **hasta 4 opciones** (con
  19 sabores la fila es ilegible), **nombres de 14 caracteres o menos**, **sin
  foto ni descripción** (en un combo la foto es lo que ayuda a elegir) y **nada
  incluido** — la píldora no tiene sitio para la palabra `Incluida`, y sin ella
  la bebida del combo parece algo que quizá te cobran. Lo último salió al
  probarlo, no al escribirlo.
- **Contador de avance** (`3 de 7 seleccionados`) solo en grupos que admiten más
  de una: con tope de 1 el radio ya lo dice.
- **Precio actual** encima del botón, solo en productos con grupos de opciones
  —donde el número cambia mientras eliges—. En uno simple repetiría el botón.
- Al llegar al máximo, las opciones no elegidas bajan de opacidad y no
  responden; las ya elegidas se pueden desmarcar.
- **Complementos incluidos**: se ven como cualquier grupo, con la palabra
  `Incluida` donde iría el precio, y `+$1.50` solo en las mejoras.
- **«Agrega algo más»**: los adicionales, agrupados por la sección que puso el
  dueño, con foto, precio y botón `+`. Entran al carrito como línea propia.
- **Nota para el negocio**: un campo de texto libre al final.
- **Barra inferior fija**: contador de cantidad a la izquierda y botón ancho a
  la derecha, con el texto que corresponda:
  - `Agregar 1 al carrito · $16.83` cuando se puede,
  - o **qué falta**: `Elige el tamaño`. Nunca un genérico como «completa las
    opciones».

## 4. Carrito y checkout

- Líneas con foto pequeña, nombre, lo elegido en texto tenue, contador y
  precio.
- **Desglose**: subtotal, envío, total. El envío solo aparece en entrega.
- ~~**¿Para cuándo?**~~ **RETIRADO el 2026-08-07.** No está en el diagrama y el
  dueño pidió quitarlo. Se fue entero: la sección, `scheduleSlots`,
  `isValidSlot` y sus pruebas. ⚠️ Con ello se fue también lo que hacía de paso:
  **con el local cerrado ya no se puede pedir**. Antes era lo único que lo
  permitía —a las once de la noche es cuando alguien decide qué va a comer
  mañana—, y el dueño aceptó esa consecuencia sabiéndola. `prep_time_minutes`
  sigue existiendo, pero ahora solo se MUESTRA: ya no decide ninguna hora.
- **Información de entrega**: dirección, referencia, teléfono, instrucciones.
  En retiro, esos campos desaparecen.
- **Método de pago**: Efectivo · Transferencia · Pago al retirar. En
  transferencia se muestran los datos bancarios y el subidor de comprobante.
- Botón `Continuar` fijo abajo.

## 5. Confirmación

- **Check verde grande** centrado.
- `¡Pedido confirmado!` y una línea explicando que el negocio ya lo recibió.
- **Número de pedido** destacado en el color de marca. Sale de
  `orders.order_number` (ver «El número de pedido», más abajo).
- **Tiempo estimado**, con el mismo cálculo que la portada: preparación más
  reparto solo si se lo llevan.
- Acciones: `Escribir por WhatsApp` y `Volver al menú`.
  ⚠️ **`Seguir pedido` no está** y es a propósito: la pantalla de seguimiento
  todavía no existe, y un botón que no lleva a ninguna parte se siente roto.
  Entra cuando exista.

## 6. Seguimiento

- **Línea de tiempo vertical** con un punto por estado y la hora al lado.
- Los cumplidos, en verde y con su hora. Los pendientes, en gris y con `--:--`.
- El estado actual, destacado.

---

## El horario de la portada

`todaysHours` (en `server/src/services/schedule.ts`) devuelve el horario
**vigente** en `HH:MM`, y viaja en `GET /api/store/:slug` y
`GET /api/store/:slug/catalog` junto al `status`. Nulo = ese día no se abre, y
la portada calla en vez de inventar.

⚠️ No es «el tramo de hoy». A las 00:30 de un jueves, con el miércoles de 09:00
a 01:00, quien sigue abierto es el turno del **miércoles**: enseñar el del
jueves diría «abre a las 09:00» junto a una píldora verde de `Abierto`, y las
dos cosas no pueden ser ciertas a la vez. Es el mismo cruce de medianoche que
ya resolvía `isOutsideHours`, y las dos funciones tienen que contar la misma
historia — hay una prueba que lo exige. El horario real de Monster Pizza es
justamente `09:00 – 01:00`, así que este caso no es teórico.

---

## El número de pedido

`orders.order_number`, **correlativo por negocio desde 1**. Es lo que el cliente
dicta por teléfono y lo que el dueño canta en la cocina; un UUID no sirve para
ninguna de las dos cosas.

Lo asigna un **trigger** (`orders_assign_number`), no cada función que crea
pedidos: hoy hay dos caminos —bot/mostrador y mini app— y el Marketplace será un
tercero. Numerar dentro de cada función obliga a acordarse cada vez que aparezca
una vía nueva, y el día que se olvide, el pedido nace sin número sin que nada
falle.

⚠️ **El contador vive en `businesses.last_order_number` y se mueve con
`update … returning`, que es atómico.** `max(order_number)+1` tiene una carrera:
dos pedidos a la vez leen el mismo máximo y se llevan el mismo número. El índice
único `(business_id, order_number)` es el cinturón.

**Contra duplicados manda `idempotency_key`, no el número.** El número es para
las personas; la llave técnica que impide dos comandas por un doble toque sigue
siendo la clave por carrito, y un pedido repetido devuelve **el mismo número**.
Es lo que necesita el Marketplace: identificar el pedido sin depender del nombre
del cliente ni de la hora.

---

## Cuánto tarda el negocio

Dos columnas de `businesses`, porque son dos cosas y mezclarlas miente en una:

| Columna | Qué es | Dónde pesa |
|---|---|---|
| `prep_time_minutes` | Cuánto tarda en estar **listo** | Decide las **franjas programables** y lo que ve quien retira |
| `delivery_extra_minutes` | Cuánto suma **llevarlo** | Solo se muestra; no entra en las franjas |

**El tipo recomienda al crear, el dueño manda después.** Un negocio nace con
los minutos de su tipo (`prepTimeForBusinessType` en
`services/business-templates.ts`: heladería 10, pizzería 25, asadero 40) y a
partir de ahí solo lo cambia su dueño desde `Ajustes → Tu tienda`. Es la misma
regla de las plantillas de catálogo y de las capacidades: **jamás pisa a un
negocio existente**.

**El dueño configura UN número y la app pinta un rango.** `rangoDeEspera`
(`apps/store/src/lib/format.ts`) añade una ventana de 10 minutos: el dueño
piensa «mi pizza tarda 25», que es como se piensa una cocina, y preguntarle dos
números sería el doble de fricción para el mismo dato. Un número exacto se lee
como promesa al minuto y el primer pedido que llegue en 27 la incumple.

⚠️ **No es decoración: `prep_time_minutes` decide desde qué hora se puede
programar.** Estaba fijo en 30 minutos para todos los negocios, en DOS sitios
de `storefront.routes.ts` —la lista de franjas y su validación—. Separarlos no
rompe de golpe: la lista ofrecería las horas buenas y la validación aceptaría
además las que el negocio no puede cumplir. Por eso hoy los dos salen de
`prepOptions()`, una sola función.

**Las barberías no usan nada de esto.** Los negocios de citas ya tenían su
tiempo, y por otro camino: `products.duration_minutes` (cuánto dura ese
servicio), `business_schedule.slot_duration` (cada cuánto se ofrece cita) y
`bookings.duration_minutes` (cuánto duró). No se tocó.

---

## Detalles técnicos que el diseño exige

- `100dvh`, `safe-area-inset-top` y `safe-area-inset-bottom`. La barra inferior
  no puede quedar bajo el gesto del iPhone.
- **Nunca scroll horizontal en el body.** Las filas desplazables (categorías,
  franjas) llevan su propio `overflow-x`.
- Imágenes con `loading="lazy"` y tamaño reservado, para que la lista no salte
  al cargar.
- **Skeletons** mientras carga, no un spinner centrado.
- Estados vacíos con texto útil: qué pasa y qué hacer.
- Botones de al menos 44×44 px reales.
- El teclado no puede tapar el campo activo ni el botón de confirmar.

---

## Lo que NO se copia

Del diagrama se toma la estructura y la jerarquía. **No** se copian marca,
colores corporativos, textos literales, iconos, fotografías ni identidad visual
de Uber Eats, PedidosYa, Rappi ni de ninguna cadena. La plataforma tiene
identidad propia.

---

## El tapón

**0 de 17 productos tienen `image_url`, las 5 categorías tampoco, y el negocio
no tiene logo** (verificado contra la base el 2026-08-06). En este diseño la
foto ocupa la mitad superior de cada tarjeta, el círculo de cada categoría y la
cabecera de la ficha. Ninguna mejora de CSS acercará la app a la referencia
hasta que se carguen.

El rediseño se construyó igual, por decisión del dueño, tratando la ausencia de
foto como el estado **normal** y no como un error: el marcador (`@utility
marcador` en `index.css` + `Foto` en `components/ui.tsx`) pinta la inicial
grande sobre un tinte del color del negocio, reservando el mismo tamaño que
ocupará la imagen para que la lista no salte al cargar. Se ve intencional en
vez de roto, pero **no se parece a la referencia** — y no puede.

El flujo de subida funciona y está verificado (Cloudinary, `Catálogo → editar
producto`). Cargar cinco o seis fotos es lo único que falta para que este
diseño sea el del diagrama.
