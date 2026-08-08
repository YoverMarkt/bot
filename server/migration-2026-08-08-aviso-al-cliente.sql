-- ════════════════════════════════════════════════════════════════════════
-- UN AVISO POR PEDIDO, Y SOLO UNO
--
-- Al aceptar un pedido se le manda un WhatsApp al cliente. El problema es que
-- `set_order_status` devuelve `updated` TAMBIÉN cuando el estado ya era ese:
--
--     if v_order.status = p_status then
--       return jsonb_build_object('result', 'updated', ...);
--
-- Es correcto para lo suyo —pedir un cambio que ya ocurrió no es un error—,
-- pero desde fuera no se distingue de un cambio real. Sin esta columna, tocar
-- «Aceptar y preparar» dos veces le manda dos mensajes al cliente. Y desde el
-- 1 de octubre de 2026 Meta cobra cada mensaje de servicio, así que el doble
-- toque se paga dos veces.
--
-- El botón desaparece del panel en cuanto el pedido avanza, pero eso no basta:
-- la API es la API, y la defensa va donde está el dato, no donde está el botón.
--
-- ⚠️ `customer_notified_at` NO se consulta antes de enviar: se RECLAMA con un
-- `update ... where customer_notified_at is null returning`, que es atómico.
-- Comprobar y luego enviar deja una carrera entre las dos operaciones — dos
-- peticiones a la vez leerían nulo las dos y mandarían dos mensajes, que es
-- justo lo que se quiere evitar. Es el mismo patrón que `last_order_number`.
-- ════════════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists customer_notified_at timestamptz;

comment on column public.orders.customer_notified_at is
  'Cuándo se le avisó al cliente de que su pedido entró en preparación. Se '
  'reclama de forma atómica: quien gana el update es quien envía. Nulo = '
  'todavía no se le ha avisado.';
