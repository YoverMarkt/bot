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
- **Nombre** del negocio en grande, y debajo el **estado**: una píldora verde
  `Abierto` o gris `Cerrado`, con el horario del día al lado
  (`10:00 a.m. – 11:00 p.m.`).
- **Línea de servicio**: `Entrega 25–35 min · Pedido mínimo $10.00`.
- **Dos botones de modo**, uno junto al otro: `Entrega $1.50` y `Retiro gratis`.
  El activo va con el color de marca; el otro, con borde.
- **Buscador** de ancho completo, con lupa a la izquierda.
- **Categorías en círculos** con su imagen, en fila horizontal desplazable:
  «Para ti», «Pizzas», «Combos», «Bebidas».
- **Barra inferior fija** de cinco destinos: Inicio · Buscar · Carrito ·
  Pedido · Cuenta. El carrito lleva su contador en un punto.

## 2. Catálogo

- **Pestañas de categoría** horizontales y **sticky**, con **subrayado** bajo
  la activa. Se sincronizan con el scroll vertical en los dos sentidos: al
  desplazar cambia la pestaña, al tocar una pestaña salta a su sección.
- **Bandas grises** separando secciones, para que el ojo encuentre el corte sin
  leer.
- **Tarjetas de producto** con foto a un lado, y al otro: nombre, descripción
  en dos líneas como máximo, precio, y un botón `+` circular. El precio
  promocional va junto al tachado.
- Una o dos columnas según el ancho.
- **Agotado**: la tarjeta baja de opacidad y el `+` desaparece.

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
- Las opciones que **son productos** (los combos) llevan su foto.
- **Píldoras** para las opciones cortas de un grupo `single` corto (Tradicional
  · Delgada · Pan Pizza), en lugar de una lista vertical.
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
- **¿Para cuándo?**: `Lo antes posible` y las franjas horarias, en fila
  desplazable. Con el local cerrado, el primer botón dice `Programar`.
- **Información de entrega**: dirección, referencia, teléfono, instrucciones.
  En retiro, esos campos desaparecen.
- **Método de pago**: Efectivo · Transferencia · Pago al retirar. En
  transferencia se muestran los datos bancarios y el subidor de comprobante.
- Botón `Continuar` fijo abajo.

## 5. Confirmación

- **Check verde grande** centrado.
- `¡Pedido confirmado!` y una línea explicando que el negocio ya lo recibió.
- **Número de pedido** destacado en el color de marca.
- Tiempo estimado.
- Tres acciones, en este orden: `Seguir pedido` (principal), `Compartir por
  WhatsApp` (verde de WhatsApp, con su icono), `Volver al menú` (secundario).

## 6. Seguimiento

- **Línea de tiempo vertical** con un punto por estado y la hora al lado.
- Los cumplidos, en verde y con su hora. Los pendientes, en gris y con `--:--`.
- El estado actual, destacado.

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

**0 de 17 productos tienen `image_url`.** En este diseño la foto ocupa media
tarjeta y la mitad superior de la ficha. Ninguna mejora de CSS acercará la app
a la referencia hasta que se carguen: el resultado será una rejilla de
marcadores grises.

El flujo de subida funciona y está verificado (Cloudinary, `Catálogo → editar
producto`). Cargar cinco o seis fotos antes de empezar el rediseño cambia por
completo el resultado.
