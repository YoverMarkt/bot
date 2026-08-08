-- ════════════════════════════════════════════════════════════════════════
-- TRES AVISOS POR PEDIDO, UNO POR HITO — Y NINGUNO REPETIDO
--
-- El pedido pasa a avisar tres veces: cuando entra en preparación, cuando
-- sale (o queda listo para retirar) y cuando se entrega. Antes era uno solo, y
-- por eso bastaba con `customer_notified_at is null` para saber si ya se había
-- avisado: solo había un aviso posible.
--
-- Con tres, esa pregunta cambia: ya no es «¿se avisó?», es «¿se avisó DE
-- ESTO?». Sin `customer_notified_status`, el primer aviso dejaría la fecha
-- puesta y los otros dos no saldrían nunca — un fallo silencioso, del tipo que
-- no rompe nada y simplemente deja de hacer algo.
--
-- ⚠️ Se sigue RECLAMANDO dentro del propio `update`, que es atómico:
--
--     update ... set customer_notified_status = 'en_camino'
--      where customer_notified_status is distinct from 'en_camino'
--     returning ...
--
-- Comprobar y luego enviar deja una carrera entre las dos operaciones. Y basta
-- comparar con el ÚLTIMO estado avisado porque el pedido nunca retrocede: la
-- propia `set_order_status` lo prohíbe, así que `preparacion → en_camino →
-- completado` son siempre tres valores distintos en fila.
--
-- `customer_notified_at` se queda: pasa a ser CUÁNDO fue el último aviso, que
-- es lo que sirve para mirar un pedido y saber si el cliente está al día.
-- ════════════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists customer_notified_status text;

comment on column public.orders.customer_notified_status is
  'El último estado del que se avisó al cliente. Se reclama de forma atómica: '
  'quien gana el update es quien envía. Nulo = todavía no se le ha avisado de '
  'nada.';

-- Los pedidos que ya recibieron el aviso de preparación antes de esta columna
-- llevan fecha y no llevan estado. Sin esto volverían a recibirlo: la
-- comparación con nulo daría «distinto» para cualquier hito.
--
-- Se rellena con 'preparacion' porque ese era el ÚNICO aviso que existía
-- cuando se escribió esa fecha.
update public.orders
   set customer_notified_status = 'preparacion'
 where customer_notified_at is not null
   and customer_notified_status is null;
