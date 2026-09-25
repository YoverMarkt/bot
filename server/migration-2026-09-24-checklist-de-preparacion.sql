-- ============================================================================
-- CHECKLIST DE PREPARACIÓN: NINGÚN PEDIDO SALE INCOMPLETO
--
-- Pedido del dueño (2026-09-23): «que en el pedido se vaya marcando lo que
-- tiene, para que no salga incompleto». El caso que lo motiva: el cliente pide
-- hamburguesa, papas y gaseosa; el empleado mete las dos primeras, olvida la
-- gaseosa, sella la bolsa y el cliente recibe un pedido incompleto.
--
-- ── ⚠️ EL CANDADO VA EN LAS **DOS** SALIDAS, Y ESTO CORRIGE EL ENCARGO ──────
--
-- El prompt pedía bloquear `listo_para_recoger`. Aquí ese estado se llama
-- `listo_para_retiro` y **solo existe para quien pasa a recoger**: la propia
-- `set_order_status` rechaza `listo_para_retiro` si el pedido es `delivery`.
-- Un pedido a domicilio va `preparacion → en_camino`.
--
-- Medido en producción: **69 pedidos a domicilio contra 3 de retiro**. Poner el
-- candado solo donde decía el encargo habría protegido 3 de 72 — y habría
-- dejado sin proteger justo el caso descrito, el que sale en moto.
--
-- Así que se bloquean LAS DOS: `en_camino` y `listo_para_retiro`.
--
-- ── DOS ESTADOS POR LÍNEA, NO TRES ──────────────────────────────────────────
--
-- El encargo proponía `pendiente` / `agregado` / `confirmado` y dejaba
-- simplificar si se justificaba. Aquí `agregado` y `confirmado` son el mismo
-- instante: el empleado mete la gaseosa en la bolsa y la tilda. Dos toques
-- para lo mismo, en una cocina con prisa, es un toque que nadie dará.
--
-- Por eso el estado es una FECHA (`prepared_at`): nula = pendiente. Y como se
-- guarda cuándo y quién, la línea de tiempo sale sola.
--
-- ── ⚠️ EL RELLENO NO ES OPCIONAL ────────────────────────────────────────────
--
-- Sin él, TODO pedido ya existente quedaría con sus líneas sin marcar y el
-- candado lo dejaría encerrado: nadie podría sacar un pedido que ya estaba en
-- la cocina cuando se desplegó esto. Se marcan como preparadas todas las
-- líneas actuales, que es la verdad: esos pedidos ya salieron.
-- ============================================================================

-- ── 1. El estado de cada línea ─────────────────────────────────────────────
alter table public.order_items
  add column if not exists prepared_at timestamptz,
  add column if not exists prepared_by uuid;

-- ⚠️ Las foráneas del «quién» van COMPUESTAS con `business_id`: con una sola
-- columna, una línea del local A podría decir que la preparó un empleado del
-- local B. Lo exige `verificar-fronteras.sql`.
alter table public.order_items
  drop constraint if exists fk_order_items_preparado_por;
alter table public.order_items
  add constraint fk_order_items_preparado_por
  foreign key (prepared_by, business_id)
  references public.client_users (id, business_id) on delete set null;

comment on column public.order_items.prepared_at is
  'Cuándo se metió esta línea en la bolsa. Nula = todavía pendiente.';
comment on column public.order_items.prepared_by is
  'Quién la marcó. Nulo si se marcó antes de que existiera el registro, o si ese usuario se borró.';

-- ⚠️ El relleno: lo que ya existe no puede quedar encerrado por el candado.
update public.order_items oi
   set prepared_at = o.created_at
  from public.orders o
 where o.id = oi.order_id
   and oi.prepared_at is null;

-- Para el candado: encontrar rápido si a un pedido le falta algo.
create index if not exists idx_order_items_pendientes
  on public.order_items (order_id)
  where prepared_at is null;


-- ── 2. La línea de tiempo gana quién y qué producto ────────────────────────
alter table public.order_events
  add column if not exists created_by uuid,
  add column if not exists order_item_id uuid;

-- La clave foránea aparte: en el consolidado `order_events` se declara ANTES
-- que `order_items`, así que allí no cabe inline. Aquí se ata igual para que
-- las dos fuentes acaben idénticas.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_events'::regclass
      and conname = 'fk_order_events_linea'
  ) then
    -- ⚠️ COMPUESTA, con `business_id`. Una foránea a `order_items(id)` a secas
    -- deja abierta la frontera entre negocios: un evento del local A podría
    -- apuntar a una línea del local B. La RPC ya comprueba pertenencia, pero
    -- eso es una promesa del código; esto lo hace IMPOSIBLE en la base. Mismo
    -- patrón que `product_variants`, y lo exige `verificar-fronteras.sql`.
    alter table public.order_events
      add constraint fk_order_events_linea
      foreign key (order_item_id, business_id)
      references public.order_items (id, business_id) on delete cascade;
  end if;
end $$;

alter table public.order_events
  drop constraint if exists fk_order_events_hecho_por;
alter table public.order_events
  add constraint fk_order_events_hecho_por
  foreign key (created_by, business_id)
  references public.client_users (id, business_id) on delete set null;

comment on column public.order_events.order_item_id is
  'Si el evento es de una LÍNEA (marcarla preparada) y no del pedido entero. ⚠️ El seguimiento del CLIENTE filtra estos: la cocina no se le enseña.';


-- ── 3. Marcar una línea, sin poder marcarla dos veces ──────────────────────
--
-- ⚠️ Idempotente a propósito: en una cocina se toca dos veces por nervio, y un
-- doble toque no puede dejar dos eventos ni cambiar quién la marcó. Si ya
-- estaba preparada se devuelve el estado tal cual y no se escribe nada.
--
-- ⚠️ El `business_id` va en el WHERE, no solo en el argumento: sin él, un
-- panel podría marcar la línea de un pedido de otro local pasando su id.
create or replace function public.marcar_linea_preparada(
  p_business_id uuid,
  p_order_id    uuid,
  p_item_id     uuid,
  p_user_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item   public.order_items%rowtype;
  v_estado text;
  v_faltan integer;
begin
  select status into v_estado
  from public.orders
  where id = p_order_id and business_id = p_business_id;
  if not found then
    raise exception using errcode = '42501', message = 'El pedido no pertenece a este negocio';
  end if;

  -- Un pedido cerrado no se re-prepara: rompería la trazabilidad de lo que de
  -- verdad pasó. Se avisa en vez de escribir.
  if v_estado in ('completado', 'cancelado', 'rechazado', 'expirado') then
    return jsonb_build_object('result', 'cerrado', 'status', v_estado);
  end if;

  select * into v_item
  from public.order_items
  where id = p_item_id and order_id = p_order_id and business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Esa línea no es de este pedido';
  end if;

  if v_item.prepared_at is null then
    update public.order_items
       set prepared_at = now(),
           prepared_by = p_user_id
     where id = p_item_id;

    insert into public.order_events (
      business_id, order_id, from_status, to_status, note, created_by, order_item_id
    ) values (
      p_business_id, p_order_id, v_estado, 'producto_agregado',
      left(v_item.product_name || ' x' || v_item.quantity, 300),
      p_user_id, p_item_id
    );
  end if;

  select count(*) into v_faltan
  from public.order_items
  where order_id = p_order_id and prepared_at is null;

  -- Cuando cae la última, se apunta que el pedido está completo: es el hito
  -- que el dueño busca en la línea de tiempo.
  if v_faltan = 0 and v_item.prepared_at is null then
    insert into public.order_events (
      business_id, order_id, from_status, to_status, created_by
    ) values (p_business_id, p_order_id, v_estado, 'pedido_completo', p_user_id);
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'faltan', v_faltan,
    'total', (select count(*) from public.order_items where order_id = p_order_id)
  );
end;
$$;

revoke all on function public.marcar_linea_preparada(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.marcar_linea_preparada(uuid, uuid, uuid, uuid)
  to service_role;


-- ── 4. EL CANDADO, dentro de la ÚNICA puerta que cambia el estado ──────────
--
-- ⚠️ Se recrea `set_order_status` entera porque el candado va DENTRO: es la
-- única función que mueve un pedido de estado, y ponerlo en el panel dejaría
-- la puerta abierta desde el navegador. El resto del cuerpo es idéntico —las
-- transiciones, el reparto, la venta al entregar— palabra por palabra.
--
-- ⚠️ Devuelve `result: 'incompleto'` con la lista de lo que falta, en vez de
-- lanzar: el panel tiene que poder decirle al empleado QUÉ le falta, no solo
-- que no puede.

create or replace function public.set_order_status(
  p_business_id uuid,
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_anterior text;
  -- Lo que falta por meter en la bolsa, ya con nombre y cantidad.
  v_faltan text;
begin
  if p_status not in (
    'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
    'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
    'cancelado', 'rechazado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'order', null);
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
  end if;
  v_anterior := v_order.status;

  -- Un pedido que el cliente retira en el local (o consume en sitio) no puede
  -- salir a reparto. Los pedidos del bot no traen `fulfillment`: se asumen a
  -- domicilio, que es como funcionan hoy por WhatsApp.
  if p_status = 'en_camino'
     and coalesce(v_order.fulfillment, 'delivery') <> 'delivery' then
    return jsonb_build_object('result', 'not_deliverable', 'order', to_jsonb(v_order));
  end if;

  -- Y al revés: un pedido a domicilio no se queda «listo para retirar».
  if p_status = 'listo_para_retiro'
     and coalesce(v_order.fulfillment, 'delivery') = 'delivery' then
    return jsonb_build_object('result', 'not_pickable', 'order', to_jsonb(v_order));
  end if;

  -- ── EL CANDADO: NINGÚN PEDIDO SALE INCOMPLETO ──────────────────────────
  --
  -- ⚠️ EN LAS DOS SALIDAS, y esto corrige el encargo. El prompt pedía bloquear
  -- solo `listo_para_recoger`; aquí ese estado es `listo_para_retiro` y SOLO
  -- vale para quien pasa a recoger. Un pedido a domicilio sale por `en_camino`.
  --
  -- Medido en producción: 69 pedidos a domicilio contra 3 de retiro. Bloquear
  -- solo el retiro habría protegido 3 de 72, y habría dejado fuera justo el
  -- caso que motivó todo: la bolsa que se va en la moto sin la gaseosa.
  --
  -- ⚠️ Vive AQUÍ y no en el panel porque esta es la única puerta que cambia el
  -- estado de un pedido: así no se salta recargando ni desde el navegador.
  if p_status in ('en_camino', 'listo_para_retiro') then
    select string_agg(product_name || ' x' || quantity, ', ' order by created_at)
    into v_faltan
    from public.order_items
    where order_id = p_order_id and prepared_at is null;

    if v_faltan is not null then
      return jsonb_build_object(
        'result', 'incompleto',
        'faltan', v_faltan,
        'order', to_jsonb(v_order)
      );
    end if;
  end if;

  -- El pedido avanza; nunca retrocede. `completado`, `cancelado`, `rechazado`
  -- y `expirado` son finales: de ahí no sale a ningún sitio, así que
  -- «cancelado → preparacion» o «completado → preparacion» quedan fuera por no
  -- estar listados, no por una regla aparte.
  if not (
    (v_order.status = 'pendiente'
      and p_status in ('esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
                       'preparacion', 'cancelado', 'rechazado', 'expirado'))
    -- Esperando el pago: si el cliente transfirió por fuera y avisó por
    -- WhatsApp, el dueño puede arrancar sin esperar a que suba nada.
    or (v_order.status = 'esperando_pago'
      and p_status in ('pago_en_revision', 'confirmado', 'aceptado', 'preparacion',
                       'rechazado', 'cancelado', 'expirado'))
    -- El comprobante está subido y el dueño lo mira.
    --
    -- ⚠️ `preparacion` se abrió el 2026-08-08. Antes estaba prohibido a
    -- propósito —«nunca directo a la cocina»— porque aceptar y empezar eran
    -- dos decisiones. Con el botón «Aceptar y preparar» son UNA: el dueño que
    -- da el pago por bueno es el mismo que manda hacerlo, y obligarle a dos
    -- toques solo añadía un estado que el cliente no entiende. Rechazar sigue
    -- siendo la otra salida.
    or (v_order.status = 'pago_en_revision'
      and p_status in ('confirmado', 'aceptado', 'preparacion', 'rechazado',
                       'cancelado', 'expirado'))
    or (v_order.status = 'confirmado'
      and p_status in ('aceptado', 'preparacion', 'listo_para_retiro', 'en_camino',
                       'completado', 'cancelado', 'expirado'))
    or (v_order.status = 'aceptado'
      and p_status in ('preparacion', 'listo_para_retiro', 'en_camino', 'completado',
                       'cancelado'))
    or (v_order.status = 'preparacion'
      and p_status in ('listo_para_retiro', 'en_camino', 'completado', 'cancelado'))
    or (v_order.status = 'listo_para_retiro'
      and p_status in ('completado', 'cancelado'))
    or (v_order.status = 'en_camino'
      and p_status in ('completado', 'cancelado'))
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'order', to_jsonb(v_order));
  end if;

  update public.orders
  set status = p_status, updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

  -- El historial. Sin esto, «¿cuándo se confirmó?» solo se puede responder
  -- mirando `updated_at`, que se pisa con cada cambio.
  insert into public.order_events (business_id, order_id, from_status, to_status)
  values (p_business_id, p_order_id, v_anterior, p_status);

  -- Entregado = vendido. Si algo fallara aquí cae la transacción entera: nunca
  -- queda un pedido entregado sin su venta.
  if p_status = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, p_order_id);
  end if;

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;
