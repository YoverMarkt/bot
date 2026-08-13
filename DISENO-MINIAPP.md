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
10. ~~Seguimiento del pedido~~ — **RETIRADO el 2026-08-12.** El viaje ya no
    termina en una pantalla de esta app: termina donde empezó, en el chat. Ver
    el apartado 6.

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
- ~~**Categorías en círculos**~~ **RETIRADAS el 2026-08-11.** Pintaban
  exactamente la misma lista (`grupos`) que las pestañas pegajosas de justo
  debajo: dos veces lo mismo, una encima de la otra. El sitio se lo gana el
  **aviso de pago pendiente**, que es lo primero que se ve bajo el buscador.
  ⚠️ Ese aviso reemplazó al secuestro: antes, reabrir la app con un pedido sin
  pagar entraba DIRECTO a la pantalla de pago. Ahora se abre la tienda con el
  aviso a la vista y se entra tocándolo — quien abrió la app para mirar la
  carta puede mirarla, y el recordatorio no se pierde.
- **Barra inferior fija**: Inicio · Buscar · Carrito · **Cuenta**.
  La cuarta decía «Pedido» y abría el ÚLTIMO pedido directamente. Servía
  mientras solo hubiera uno del que preocuparse; quien ha pedido cinco veces
  tiene un historial, no «un pedido». Desde el 2026-08-11 abre
  `screens/Account.tsx`: sus pedidos y sus direcciones, con sitio para lo que
  venga.
  ⚠️ **La lista de pedidos es de solo lectura desde el 2026-08-12**: tocar uno
  abría su seguimiento, y esa pantalla ya no existe. Lo que se conserva es el
  **estado en texto** junto a cada pedido (`COMO_VA`), y eso no es decorativo:
  es el único sitio de la app donde el cliente puede comprobar por dónde va lo
  suyo si el aviso de WhatsApp no llegara. Una fila que no lleva a ninguna
  parte deja de ser un botón — fingir que sí es peor que no ofrecerlo.

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

**Son DOS pasos desde el 2026-08-11, no una hoja larga.** Mezclados, el cliente
tenía que pasar por encima de la dirección y del método de pago solo para
comprobar qué llevaba, y el botón de confirmar quedaba a un scroll de los
productos. Revisar y decidir son dos momentos distintos:

- **`Tu carrito`** — solo los productos, con lo elegido de cada uno, contador y
  precio. Abajo el desglose y `Continuar · $X`.
- **`Finalizar pedido`** — entrega o retiro, dirección, instrucciones, método de
  pago y nombre. Abajo `Confirmar pedido · $X`.

La flecha de la cabecera vuelve al carrito; no cierra la hoja. Cerrar y volver
a abrir empieza siempre por el carrito: reabrir en el checkout dejaría al
cliente sin ver lo que está a punto de pagar.

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
- **La libreta de direcciones** (simplificada el 2026-08-11):
  · Cada dirección guardada se puede **eliminar**. Se marca inactiva, no se
    borra: `orders.address_id` apunta ahí y con él se sabe a qué casa pide más
    un cliente. El destino de cada pedido va congelado aparte desde el
    2026-08-10, así que retirarla no deja ningún reparto sin dirección — antes
    de congelarla, sí lo habría hecho.
  · **La etiqueta la ponen las cápsulas** (Casa · Departamento · Oficina ·
    Hotel · Otro), no un campo de texto. Había los dos, y preguntaban lo mismo
    a dos dedos de distancia: el cliente escribía «Casa» arriba y volvía a
    tocar «Casa» abajo. Peor, podía escribir «Fffffff» y quedarse con una
    libreta donde no distingue una dirección de otra. Eligiendo no hay forma
    de fallar, y `building_type` y `label` dejan de poder contradecirse.
  · **Un solo campo de instrucciones**, el del PEDIDO. Existía además uno
    permanente por dirección, justo debajo de las cápsulas, y el cliente no
    sabía cuál llenar. ⚠️ Consecuencia aceptada: «el timbre no sirve» se
    reescribe en cada pedido. `customer_addresses.courier_notes` sigue en la
    base y el panel la pinta si tiene algo; simplemente ya no se pide.
- **Información de entrega**: dirección, referencia, teléfono, instrucciones.
  En retiro, esos campos desaparecen.
  · Las **instrucciones** (`orders.delivery_notes`) son de ESTE pedido —«llame
    al llegar»—, no del sitio: la referencia de la dirección es fija y se queda.
    Se ven en el panel del dueño junto a la dirección, que es donde las busca
    quien reparte; sin eso el campo no serviría de nada.
- **Método de pago**: Efectivo · Transferencia · Pago al retirar. En
  transferencia se muestran los datos bancarios en la pantalla siguiente.
  · **El comprobante tiene UNA vía desde el 2026-08-12: WhatsApp.** Tuvo dos
    entre el 2026-08-08 y esa fecha —subirlo en la app o mandarlo por el chat—
    y se retiró la de la app. El motivo por el que existían las dos es el mismo
    por el que sobrevive la del chat: mucha gente transfiere desde la app de su
    banco —a veces desde la cuenta de un familiar— y la captura le queda en la
    galería del teléfono, a un toque de la conversación donde recibió el
    enlace. Pedirle además que vuelva a la tienda y la suba otra vez es trabajo
    de más para llegar al mismo sitio. El detalle del método lo dice ahora
    literalmente: «Te mostramos la cuenta y nos envías el comprobante por
    WhatsApp».
  · ~~**No se fuerza la cámara**~~ — se fue con el subidor. Se anota porque el
    motivo sigue valiendo el día que algo vuelva a pedir una imagen: el
    comprobante es una CAPTURA DE PANTALLA del banco, que vive en la galería, y
    forzar la cámara obligaría a fotografiar la pantalla de otro teléfono.
  ⚠️ **`pago_al_retirar` solo se ofrece en retiro**: no es cómo paga, es CUÁNDO
  —al pasar por el local—, y prometérselo a quien pidió a domicilio es ofrecer
  algo que no se puede cumplir. La app lo esconde, el checkout lo deriva a
  efectivo si se cambia de modo, y la ruta lo vuelve a rechazar.
  ⚠️ El valor vive en TRES sitios: el CHECK de `orders` (el `alter table` de
  abajo, no el del `create table`), la lista de la ruta y **la validación
  interna de `create_storefront_order`**, que se dispara ANTES que el CHECK.
  Añadirlo en dos y olvidar el tercero no falla al compilar ni en los tests con
  simulacros — falla cuando un cliente intenta pedir. Pasó.
- Botón `Continuar` fijo abajo.

## 5. Pedido recibido

**Vuelve el 2026-08-11, diciendo la verdad.** Se había retirado el 2026-08-08
porque decía «¡Pedido confirmado!» en el instante de crearlo, cuando el estado
real era `pendiente` y el negocio no lo había mirado: le prometía al cliente un
compromiso que nadie había dado. Y era estática.

Las dos objeciones se resuelven sin renunciar a la pantalla:

- **Dice «recibido», no «confirmado»**, que es verdad siempre: el pedido está
  en la base y en la bandeja del dueño. Curiosamente el propio diagrama de
  referencia ya lo decía en su subtítulo: «Tu pedido ha sido **recibido**
  correctamente».
- **Con transferencia el texto cambia**: ese pedido nace en `esperando_pago` y
  lo que le toca al cliente es pagar, no esperar.
- **Sigue siendo estática, y ahora eso está bien**: no promete nada que pueda
  cambiar.

**Es la ÚLTIMA pantalla del pedido desde el 2026-08-12**, y por eso su trabajo
cambió. Antes era una escala hacia el seguimiento; ahora es la despedida, y
tiene que dejar dicho todo lo que el cliente necesita saber:

- Check en el color de marca, `¡Gracias, <nombre>!`, número de pedido, tiempo
  estimado (el mismo cálculo que la portada) y resumen con importes.
- **Los datos para transferir** (`components/PagoPendiente.tsx`): banco y
  cuenta con botón de copiar. **Sin subidor** — ver el apartado 4. Si el
  negocio no tiene datos bancarios cargados, el bloque entero desaparece en vez
  de dejar un título con un hueco: ese negocio coordina el pago por el chat,
  que es la salida de todas formas.
- **El texto grande**, y el tamaño es la decisión: con transferencia es la
  instrucción que desbloquea el pedido («Mándanos el comprobante por
  WhatsApp»), y sin ella es la promesa de que nadie tiene que volver a abrir
  esto para enterarse de nada («Te mantenemos al tanto por WhatsApp», con los
  hitos que le tocan según entrega o retiro). En letra pequeña bajo un botón se
  lee cuando ya no hace falta.
- **Dos salidas**: `Volver a WhatsApp` en tinta —con el texto del comprobante
  ya escrito si transfiere, y el chat limpio si no— y `Volver al menú`.
  El principal es tinta y no el color del negocio, como todo botón principal de
  esta app: el acento señala, no acciona.

⚠️ **El enlace se arma en `lib/whatsapp.ts`, no a mano.** Dejó de ser un atajo
cómodo para ser el camino, y un enlace mal formado ya no incomoda: impide
pagar. Tiene pruebas porque el código anterior tenía un fallo real —pegaba el
`#` aunque no hubiera número y lo intentaba limpiar con un `.replace(' #  ',
' ')` que busca dos espacios que nunca están ahí—, así que el cliente escribía
«…de mi pedido # 🙂».

⚠️ **Y quien vuelve debiendo dinero aterriza AQUÍ.** Lo normal es cerrar la app
para ir al banco; al volver, la tienda consulta el último pedido guardado y, si
sigue en `esperando_pago` sin pago confirmado, entra por esta pantalla — con
reloj ámbar y **«Falta tu comprobante»** en vez del check verde y las gracias,
que sobre un pedido sin pagar suenan a que ya está todo hecho. `Volver al menú`
sigue disponible: un pedido a medias no puede secuestrar la tienda. Se sale de
ese estado por los dos caminos de siempre: la foto que llega por el chat lo
mueve a `pago_en_revision`, o el dueño marca «Solo confirmar el pago».

### Lo que decía la referencia (conservado como historia)

## 5-bis. Confirmación

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

## 6. ~~Seguimiento~~ — RETIRADO el 2026-08-12

**`screens/OrderTracking.tsx` se borró entero.** Tenía línea de tiempo con la
hora de cada hito, el detalle de lo pedido y la despedida al entregarse.

El motivo no es que estuviera mal hecha: es que contaba **por segunda vez** lo
que el cliente ya recibe por WhatsApp. Los tres avisos de
`services/order-notify.ts` llegan al sitio donde esa persona ya está mirando —
la conversación por la que pidió—, y ninguna app sobrevive pidiéndole a alguien
que vuelva a abrirla para enterarse de algo que le llega solo.

**Lo que se fue con ella, y dónde vive ahora:**

| Se iba a perder | Dónde está |
|---|---|
| La despedida de Umbani al entregarse | En el aviso de `completado`, con el MISMO texto (`GRACIAS_POR_PREFERIRNOS` y `PRONTO_EN_UMBANI`) |
| Saber por dónde va el pedido | Los tres avisos, y el estado en texto en la lista de Cuenta |
| «¿Qué fue lo que pedí?» | El detalle completo va en el aviso de `preparacion`, que es cuando sirve para corregirlo |

**Lo que se perdió de verdad, y se aceptó:** la hora exacta de cada paso, y la
posibilidad de comprobar el estado sin depender del canal. Si el aviso no sale
—sin saldo en YCloud, o fuera de la ventana de 24 h— al cliente le queda la
lista de Cuenta, que dice el estado pero no la hora. El envío fallido se
registra, que es lo que impide que el dueño crea que avisó sin haber avisado.

⚠️ **Lo que NO se retiró**: `GET /api/store/:slug/orders/:id` sigue en pie y
con dos llamadores —la comprobación del pago pendiente al abrir la tienda y el
resumen de esa pantalla—, así que el agrupado de opciones del servidor
(`services/order-detail.ts`) y su prueba del select siguen vivos.

Lo de abajo se conserva porque **no era de la pantalla**, era del pedido, y
sigue mandando: cómo se marca un pago que llegó por fuera, y quién puede ver un
pedido.

### Lo que enseñaba la línea de tiempo (conservado como historia)

**Los estados internos son DOCE, y al cliente se le enseñaban cinco.** No le
sirve saber que su pedido está en `aceptado` y no en `confirmado`: le sirve
saber si su comida está hecha y si viene en camino. Los que solo importan al
dueño se plegaban sobre el hito que representan. **Ese mismo plegado sigue
vivo** en `COMO_VA` (`screens/Account.tsx`) y en `HITOS_QUE_SE_AVISAN`
(`services/order-notify.ts`).

⚠️ **`en_camino` y `listo_para_retiro` son el MISMO paso** contado de dos
maneras: a quien le llevan el pedido le importa que salió; a quien lo recoge,
que ya puede pasar. Sigue vigente en los avisos.

⚠️ **«Recibido» no salía de `order_events`.** El pedido NACE en `pendiente` y
solo se anotan los CAMBIOS de estado, así que ese hito no tenía evento: su hora
era la de creación. Vale la pena recordarlo el día que alguien quiera pintar
una línea de tiempo en el panel del dueño.

### El pago que llegó por WhatsApp

`orders.payment_confirmed_at` (2026-08-08). **No es un estado**: no dice dónde
está el pedido, dice algo que le pasó. Un pedido puede estar cobrado y todavía
sin empezar — que es justo el caso de las once de la noche.

Existe porque la mayoría transfiere desde su banco y manda la captura por
WhatsApp, a veces desde la cuenta de un familiar. Ese pago vale igual, pero no
había dónde anotarlo: **el cliente seguía viendo el número de cuenta como si no
hubiera pagado, y el dueño «sin comprobante todavía» teniendo la foto en el
chat.** Con la marca puesta, la mini app esconde los datos bancarios y enseña
**Pago confirmado**.

Se marca por dos caminos, y **los dos los hace la RUTA**, nunca las funciones
del dinero — recrear `create_storefront_order` o `set_order_status` por una
fecha no compensa el riesgo de copiar la versión equivocada desde `schema.sql`:

| Camino | Cuándo |
|---|---|
| Aceptar el pedido (`→ preparacion`) | Lo normal: quien manda algo a la cocina ya dio el pago por bueno |
| «Marcar pago recibido» | El dueño vio la transferencia pero todavía no va a preparar |

⚠️ **Las condiciones viven en el `where` de la consulta, no en un `if`**: el
negocio, que sea transferencia, que el estado no sea final, y que no esté ya
marcado. Es una sola operación atómica y no hay forma de colarse por otro
camino. Lo último importa más de lo que parece: sin ello, dos toques moverían
la hora y el cliente vería saltar el momento en que le confirmaron.

⚠️ **El botón de aceptar sin comprobante NO se bloquea**, y se decidió así
sabiendo lo que se dejaba fuera. Un dueño con el dinero ya en su cuenta y la
captura en el chat no puede quedarse mirando un botón gris. Lo que sí cambia es
que el botón **no miente**: dice «Recibí el pago, preparar», va en línea en vez
de sólido, y la confirmación avisa de que nadie ha comprobado nada.

---

## Los avisos al cliente

El cliente recibe un mensaje por su canal en los momentos en que mira el
teléfono (`services/order-notify.ts`):

| Hito | Qué dice |
|---|---|
| `preparacion` | Confirmado, **qué pidió** y el total |
| `en_camino` | Ya salió para su dirección |
| `listo_para_retiro` | Ya puede pasar a recogerlo |
| `completado` | Entregado, **gracias por preferirnos** y Umbani |

**El detalle de lo pedido va SOLO en el primero.** Repetirlo alargaría los tres
mensajes para decir lo mismo, y su valor está en ese momento: es cuando el
cliente comprueba que le entendieron bien y todavía se puede corregir.

⚠️ **`en_camino` y `listo_para_retiro` son el mismo paso contado de dos
maneras**, igual que en la línea de tiempo. Decirle «va en camino» a quien
tiene que ir a buscarlo lo deja esperando en casa.

⚠️ **Cada hito es un mensaje que se paga.** Desde el **1 de octubre de 2026**
Meta cobra cada mensaje de servicio —los de texto libre dentro de la ventana de
24 h, gratis desde finales de 2024—. Se empezó con **uno solo** por ese costo;
el dueño decidió los tres el 2026-08-08 sabiendo lo que valen. **Añadir un
hito más multiplica el gasto de todos los negocios del SaaS**, así que
`HITOS_QUE_SE_AVISAN` tiene su propia prueba: no puede crecer sin que alguien
lo decida. Los estados intermedios (`aceptado`, `confirmado`,
`esperando_pago`…) no se avisan porque no le dicen al cliente nada que no sepa.

⚠️ **La ventana de 24 h NO desaparece en octubre**; lo que cambia es que deja
de ser gratis. Fuera de ella sigue haciendo falta una **plantilla aprobada por
Meta**, y la integración de YCloud hoy solo sabe mandar texto. En la práctica
casi todo cae dentro: el cliente le escribe al bot, recibe el enlace, pide, y
el dueño acepta en minutos. Lo que queda fuera es el pedido aceptado al día
siguiente — y por eso **un envío fallido se registra** en vez de perderse: si
el dueño cree que su cliente fue avisado y no lo fue, es peor que no haber
avisado nunca.

El aviso sale **sin esperar a que termine** y **nunca lanza**. Corre cuando el
estado ya cambió: la comanda está en la cocina. Hacerle mirar al dueño una
pantalla quieta hasta que conteste un canal externo es cambiar su tiempo por el
de un aviso, y convertir el fallo en un 500 le diría que el pedido no arrancó
cuando sí arrancó.

⚠️ **El aviso se RECLAMA, no se consulta, y se reclama POR HITO**
(`orders.customer_notified_status`). `set_order_status` devuelve `updated`
**también cuando el estado ya era ese** —pedir un cambio que ya ocurrió no es
un error—, así que desde fuera un segundo toque en un botón es indistinguible
del primero: sin el reclamo, el cliente recibiría dos mensajes y desde octubre
se pagarían dos. El `where` va **dentro del propio `update`**, que es atómico;
comprobar primero y enviar después deja una carrera en la que dos peticiones
simultáneas leen lo mismo. Mismo patrón que `last_order_number`, y verificado
lanzando dos reclamos a la vez contra la base real: gana uno.

⚠️ Con un solo aviso bastaba `customer_notified_at is null`. **Con varios, la
pregunta cambia**: ya no es «¿se avisó?», es «¿se avisó DE ESTO?». Sin la
columna del estado, el primer aviso dejaría la fecha puesta y los demás no
saldrían nunca — un fallo silencioso, que no rompe nada y deja de hacer algo.
Basta comparar con el ÚLTIMO estado avisado porque el pedido nunca retrocede.

⚠️ El `or(...is.null, ...neq)` **cubre el nulo a mano**: `neq` en PostgreSQL
descarta las filas nulas, así que un pedido del que no se ha avisado nada no
pasaría el filtro y jamás recibiría su primer mensaje.

Que el botón desaparezca del panel en cuanto el pedido avanza **no basta**: la
API es la API, y la defensa va donde está el dato, no donde está el botón.

---

## El nombre se escribe una sola vez

`business_customers.display_name`, guardado **al crear el pedido**, que es
cuando el nombre existe de verdad.

⚠️ La mini app llevaba la precarga construida desde el principio y no
precargaba nada: **25 pedidos del mismo cliente con `display_name` en nulo**.
`ensureCustomer` lo intenta con un `upsert` marcado `ignoreDuplicates`, y la
fila ya suele existir —la crea el bot al mandar el enlace, sin nombre—, así que
no escribía. Y aunque no existiera, en ese momento el nombre todavía es nulo:
se escribe después, en el checkout.

⚠️ En el checkout, `null` (sin tocar) y `''` (borrado) **no son lo mismo**.
Antes era `value={nombre || me?.name}` sobre un estado vacío: el campo se veía
relleno pero el estado no lo estaba, así que al borrarlo reaparecía el nombre
guardado y no había forma de cambiárselo. Y guardarlo en el estado inicial
tampoco vale — el carrito se monta con la tienda, **antes** de que `me`
responda.

---

### «Tu pedido»: qué compró

Las líneas del pedido con su cantidad, lo elegido en la ficha, la nota y su
importe. Nacieron en el seguimiento el 2026-08-09 y **sobreviven a su retirada**
en la pantalla de pedido recibido: quien vuelve debiendo el comprobante tiene
que ver qué está pagando, y quien acaba de pedir, qué acaba de encargar.

Los nombres son los **congelados al pedir**, no los del catálogo de hoy: si el
negocio renombra un producto o le cambia el precio, el pedido tiene que seguir
diciendo lo que el cliente compró.

⚠️ El select **nombra los seis campos** en vez de pedir `order_items(*)`. Con
el asterisco saldrían también `product_id`, `unit_price` y los ids internos:
nada de eso se pinta, y el precio unitario de un producto con opciones no
coincide con lo que el cliente eligió —enseñarlo confunde—. Lo vigila una
prueba, porque es una decisión sobre la CONSULTA y con datos de ejemplo
pasaría igual el día que alguien la abra de más.

⚠️ Y va en una constante `as const`, **no partido con `+`**: concatenar lo
convierte en un `string` cualquiera, supabase-js deja de inferir la forma de la
respuesta y la función no compila. La primera salida fue un cast — justo lo que
se había quitado de esa capa.

Un pedido del bot no trae líneas (nace desde el chat, sin catálogo): la sección
entera desaparece en vez de dejar un recuadro vacío con su título.

### El pedido entregado se despide — ahora SOLO por WhatsApp

Con `completado`, la pantalla de seguimiento se reemplazaba entera por una
despedida: check verde, **«Gracias por preferirnos»**, **«Pronto también
estaremos en la app de Umbani»** y el botón de volver al menú.

Con el seguimiento retirado el 2026-08-12, esa despedida vive **solo en el
aviso de WhatsApp** (`GRACIAS_POR_PREFERIRNOS` y `PRONTO_EN_UMBANI` en
`services/order-notify.ts`). No se perdió ni una palabra: eran el mismo texto a
propósito, precisamente porque el cliente llegaba por los dos caminos y no
podía leer dos despedidas distintas del mismo negocio.

Y llega mejor así. El razonamiento de entonces ya lo decía sin sacar la
conclusión: «el cliente no ha vuelto a abrir esto para consultar un estado, ha
vuelto porque le llegó el aviso». Si el aviso es lo que le trae, la despedida
puede estar en el aviso.

⚠️ **Sigue habiendo un solo sitio donde se cambia.** Antes eran dos que había
que mantener iguales; hoy es uno. Si algún día vuelve a haber dos, vuelven las
dos versiones.

---

**Quién puede ver un pedido** (sigue vigente: la ruta no se retiró, solo la
pantalla que la pintaba): exige la sesión del enlace, y el filtro es negocio +
**teléfono de la sesión** + id del pedido. Nunca el número correlativo: ese es
#1, #2, #3… y se adivina de corrido. Un pedido ajeno devuelve el MISMO 404 que
uno inexistente — si distinguiera los dos casos, se podría averiguar qué
pedidos tiene el vecino.

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

## La dirección de la tienda

`/t/<slug>`, y el slug es el nombre del negocio: `monster-pizza`. Viaja en un
WhatsApp y la lee una persona — `monster-pizza-1785656324571` parecía un
identificador de sistema y ocupaba el doble.

El sufijo numérico solo aparece cuando **de verdad** hay dos negocios con el
mismo nombre (`-2`, `-3`…). Antes se pegaba un `Date.now()` SIEMPRE, por si
acaso.

⚠️ **Las tildes se convierten, no se borran.** La versión anterior filtraba el
nombre en crudo con `[^a-z0-9-]`, así que la letra acentuada desaparecía
entera: «Heladería» daba `heladera` y «Cafetería Ñandú» daba `cafetera-and`.

⚠️ **Cambiar el slug de un negocio que ya opera rompe los enlaces `/t/…` que ya
circulan.** Los `/s/<token>` que manda el bot NO se rompen: resuelven por token
y redirigen al slug actual.

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
