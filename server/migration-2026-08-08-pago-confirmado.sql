-- ════════════════════════════════════════════════════════════════════════
-- EL PAGO QUE LLEGÓ POR FUERA DE LA APP
--
-- En Ecuador la mayoría transfiere desde la app de su banco y manda la captura
-- POR WHATSAPP, no por la mini app. A veces ni siquiera es su cuenta: paga un
-- amigo. Ese pago es tan bueno como el que se sube aquí, pero hasta ahora no
-- había dónde anotarlo:
--
--   · el cliente veía «Esperando pago» con los datos bancarios en pantalla,
--     sin saber si su plata llegó;
--   · el dueño veía «Sin comprobante todavía» teniendo la captura en el chat.
--
-- `payment_confirmed_at` es el hecho que faltaba: cuándo una persona del
-- negocio dio el pago por bueno. NO es un estado nuevo —los doce se quedan
-- como están, que tocarlos cuesta caro— porque no describe dónde está el
-- pedido, sino algo que le pasó. Un pedido puede estar cobrado y todavía sin
-- empezar, que es justo el caso de las once de la noche.
--
-- Se marca por dos caminos, y la RUTA lo hace en los dos: al aceptar el pedido
-- y al tocar «Marcar pago recibido». No se toca `create_storefront_order` ni
-- `set_order_status`: son las funciones del dinero, y recrearlas por una fecha
-- es exactamente el riesgo que no compensa (ver la nota del 2026-08-05 sobre
-- copiar la versión equivocada desde schema.sql).
-- ════════════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists payment_confirmed_at timestamptz;

comment on column public.orders.payment_confirmed_at is
  'Cuándo el negocio dio el pago por bueno. Nulo = todavía no. Sirve para el '
  'pago que llegó por WhatsApp, que nunca pasa por payment_proof_url.';

-- Sin índice a propósito: siempre se lee junto al pedido que ya se localizó
-- por (business_id, id), nunca se busca «los pedidos con pago confirmado».
-- Un índice aquí encarecería cada cambio de estado sin servir a ninguna
-- consulta real.
