-- ═══════════════════════════════════════════════════════════════════════════
-- LA PIZARRA SE LIMPIA CUANDO EL LOCAL ACEPTA UN PEDIDO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Salió de una pregunta del dueño el 2026-09-03: «el contador de expirados,
-- ¿tiene un límite para bloquear automáticamente para siempre hasta que el
-- dueño lo desbloquee?».
--
-- La respuesta era que no —el bloqueo automático es temporal, 30 minutos— pero
-- al comprobarlo apareció algo peor: **`unpaid_expiries` no se pone a cero
-- NUNCA**. Ninguna función lo reinicia. Ni comprar bien, ni pagar puntual, ni
-- que el dueño pulse «Desbloquear» — eso limpia el bloqueo, el aviso y el
-- silencio, pero deja el contador donde estaba.
--
-- ── POR QUÉ ESO CASTIGA A LOS BUENOS ───────────────────────────────────────
--
-- El límite son 2. A partir del segundo expirado, CADA pedido que caduque
-- vuelve a bloquear 30 minutos. Para siempre. Alguien que dejó dos pedidos
-- tirados hace un año, compró bien cincuenta veces y al día 51 se le pasa la
-- ventana de 15 minutos, se bloquea igual — y otra vez, y otra.
--
-- En un local con clientes reales eso golpea sobre todo a los que MÁS piden:
-- son los que tienen más ocasiones de que se les pase la ventana una vez.
--
-- ── LA REGLA: SE CUENTA LA RACHA, NO EL HISTORIAL ──────────────────────────
--
-- Es la misma decisión que ya tomó su hermano, `rejected_receipts`, y está
-- escrita en el código desde entonces:
--
--   «Se cuenta la INSISTENCIA, no el historial — quien mandó una borrosa,
--    luego la buena, y dentro de un mes otra borrosa, no está probando nada.»
--
-- Dos contadores que miden lo mismo con reglas distintas acaban
-- contradiciéndose, y el día que alguien mire uno para entender el otro se
-- equivocará. Ahora los dos se limpian con la misma señal.
--
-- ── QUÉ CUENTA COMO «DEMOSTRÓ QUE ES BUENO» ────────────────────────────────
--
-- Que el LOCAL acepte su pedido: `confirmado`, `aceptado`, `preparacion`,
-- `listo_para_retiro`, `en_camino` o `completado`. No hace falta esperar a
-- `completado` —el dueño ya dio por bueno el pago al aceptar— y esperar más
-- solo retrasaría el perdón sin que nadie gane nada.
--
-- ⚠️ Se limpian LOS DOS contadores. `rejected_receipts` ya tenía su reinicio
-- por otra vía (un comprobante bueno), pero que el local acepte es una señal
-- más fuerte que esa: si el pedido entró en cocina, esa persona no estaba
-- probando nada.
--
-- ⚠️ VA EN UN DISPARADOR, no en TypeScript, por la razón de siempre: todos los
-- cambios de estado pasan por la base, y el día que entren los motorizados
-- moverán estados por vías nuevas sin que nadie recuerde llamar a una función
-- de Node desde ahí.
--
-- ⚠️ Es un disparador APARTE de `orders_release_shopping_lock` aunque escuchen
-- el mismo evento: aquel responde «¿esta persona debe algo?» y este «¿esta
-- persona demostró que es buena?». Son dos preguntas, y juntarlas en una
-- función haría que tocar una arrastrara la otra.
--
-- ⚠️ FALLA ABIERTO: el pedido ya avanzó cuando esto corre. Si limpiar la
-- pizarra fallara, lo peor que pasa es que el contador siga alto — nunca que
-- el pedido se caiga.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.orders_clear_customer_strikes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- El local lo dio por bueno. Desde `confirmado` en adelante ya hay una
  -- decisión del dueño detrás.
  v_aceptados constant text[] := array[
    'confirmado', 'aceptado', 'preparacion',
    'listo_para_retiro', 'en_camino', 'completado'
  ];
begin
  if new.customer_id is null then
    return new;
  end if;

  -- Solo al ENTRAR en el grupo: pasar de `preparacion` a `en_camino` no es una
  -- segunda demostración, es el mismo pedido avanzando.
  if not (new.status = any(v_aceptados)) or old.status = any(v_aceptados) then
    return new;
  end if;

  begin
    update public.business_customers
       set unpaid_expiries   = 0,
           rejected_receipts = 0,
           updated_at        = now()
     where business_id = new.business_id
       and customer_id = new.customer_id
       -- Sin esto se escribiría una fila en cada pedido de cada cliente bueno,
       -- que son casi todos.
       and (unpaid_expiries > 0 or rejected_receipts > 0);
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists orders_clear_customer_strikes on public.orders;
create trigger orders_clear_customer_strikes
  after update of status on public.orders
  for each row execute function public.orders_clear_customer_strikes();

comment on function public.orders_clear_customer_strikes() is
  'Cuando el local ACEPTA un pedido, la pizarra de esa persona en ese local se '
  'borra: se cuenta la racha, no el historial. Misma regla que ya seguía '
  'rejected_receipts, ahora también para unpaid_expiries.';

-- ── Comprobación inmediata ─────────────────────────────────────────────────
do $comprobacion$
declare
  v_local   uuid;
  v_otro    uuid;
  v_cliente uuid;
  v_pedido  uuid;
  v_faltas  integer;
  v_fotos   integer;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values
    ('pizarra-uno-tmp', 'Pizza', 'pizzeria', 'ycloud', '+593900555301', '+593900555301', true, 'miniapp'),
    ('pizarra-dos-tmp', 'Otra', 'pizzeria', 'ycloud', '+593900555302', '+593900555302', true, 'miniapp');
  select id into v_local from businesses where slug = 'pizarra-uno-tmp';
  select id into v_otro  from businesses where slug = 'pizarra-dos-tmp';

  insert into public.customers (phone) values ('593900555400') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id, unpaid_expiries, rejected_receipts)
  values (v_local, v_cliente, 4, 3);
  insert into public.business_customers (business_id, customer_id, unpaid_expiries, rejected_receipts)
  values (v_otro, v_cliente, 2, 1);

  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_local, v_cliente, '593900555400', 'storefront', 'pago_en_revision', 9, 9)
  returning id into v_pedido;

  -- ── 1. Mientras el local no lo acepte, la pizarra NO se toca ────────────
  update public.orders set status = 'cancelado' where id = v_pedido;
  select unpaid_expiries into v_faltas
    from public.business_customers where business_id = v_local and customer_id = v_cliente;
  if v_faltas <> 4 then
    raise exception 'cancelar un pedido limpió la pizarra: %', v_faltas;
  end if;

  -- ── 2. Aceptarlo SÍ la limpia ───────────────────────────────────────────
  update public.orders set status = 'preparacion' where id = v_pedido;
  select unpaid_expiries, rejected_receipts into v_faltas, v_fotos
    from public.business_customers where business_id = v_local and customer_id = v_cliente;
  if v_faltas <> 0 or v_fotos <> 0 then
    raise exception 'el local aceptó y la pizarra no se limpió: impagos=% fotos=%', v_faltas, v_fotos;
  end if;

  -- ── 3. Y SOLO en ese local ──────────────────────────────────────────────
  -- La confianza se gana con quien se compra: haber sido buen cliente en una
  -- pizzería no dice nada de cómo se porta uno en otra.
  select unpaid_expiries into v_faltas
    from public.business_customers where business_id = v_otro and customer_id = v_cliente;
  if v_faltas <> 2 then
    raise exception 'se limpió la pizarra de OTRO local: %', v_faltas;
  end if;

  -- ── 4. Avanzar dentro del grupo no vuelve a escribir ────────────────────
  -- `preparacion` → `en_camino` es el mismo pedido avanzando, no una segunda
  -- demostración.
  update public.business_customers set unpaid_expiries = 1
   where business_id = v_local and customer_id = v_cliente;
  update public.orders set status = 'en_camino' where id = v_pedido;
  select unpaid_expiries into v_faltas
    from public.business_customers where business_id = v_local and customer_id = v_cliente;
  if v_faltas <> 1 then
    raise exception 'avanzar dentro del grupo volvió a limpiar: %', v_faltas;
  end if;

  delete from businesses where id in (v_local, v_otro);
  delete from public.customers where id = v_cliente;
  raise notice 'PIZARRA: se limpia cuando el local acepta, solo ahí, y una sola vez por pedido';
end;
$comprobacion$;
