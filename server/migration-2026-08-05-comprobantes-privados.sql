-- ============================================================================
-- EL COMPROBANTE DEJA DE SER PÚBLICO
--
-- Hasta ahora el comprobante de una transferencia se subía a Cloudinary como
-- cualquier foto del catálogo: `secure_url` pública y permanente. Quien
-- adivinara —o recibiera reenviada— esa URL veía el movimiento bancario de un
-- cliente real, con su nombre y su número de cuenta. No es un descuido
-- estético: es una fuga de datos personales.
--
-- Ahora se sube como `authenticated` y solo se ve con una URL FIRMADA que
-- caduca en diez minutos. La firma la genera el servidor, y solo para quien
-- tiene derecho a mirar: el dueño del negocio o el cliente dueño del pedido.
--
-- Para firmar hace falta el `public_id`, que hasta ahora no se guardaba —solo
-- la URL—. Esa es toda la migración.
--
-- ── Qué pasa con los que ya están subidos ───────────────────────────────────
-- Nada. Siguen teniendo su URL pública en `payment_proof_url` y se siguen
-- viendo: retirarlos es una decisión aparte, y romper el acceso a un pedido en
-- curso sería peor. Los NUEVOS ya nacen privados.
--
-- Idempotente. Aditiva. Sin pérdida de datos.
-- ============================================================================

alter table public.orders
  add column if not exists payment_proof_public_id text;

-- ── La función guarda el identificador y manda el pedido a revisión ─────────
-- Antes el comprobante se quedaba colgado con el pedido en «pendiente» y nada
-- avisaba al dueño de que había un pago esperando a que alguien lo mirara.
drop function if exists public.attach_storefront_payment_proof(uuid, uuid, text, text);

create or replace function public.attach_storefront_payment_proof(
  p_business_id uuid,
  p_order_id uuid,
  p_contact_phone text,
  p_url text,
  p_public_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  if nullif(btrim(coalesce(p_url, '')), '') is null or p_url !~ '^https://' then
    raise exception using errcode = '22023', message = 'El comprobante debe ser una URL https';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and business_id = p_business_id
    and contact_phone = btrim(p_contact_phone)
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Un pedido ya cerrado no admite comprobante: o se pagó, o se anuló.
  if v_order.status in ('completado', 'cancelado', 'expirado') then
    return jsonb_build_object('result', 'invalid_state', 'status', v_order.status);
  end if;

  -- Se guarda el identificador ADEMÁS de la URL: sin él no se puede firmar el
  -- acceso temporal, y el comprobante volvería a ser público para siempre.
  --
  -- Y el pedido pasa a REVISIÓN. Antes se quedaba en «pendiente» con una
  -- imagen colgada y nada que avisara al dueño de que había un pago esperando
  -- a que alguien lo mirara. Solo se mueve desde los estados en los que aún se
  -- está esperando el pago: si el dueño ya lo confirmó a mano, mandar otro
  -- comprobante no puede echarlo atrás.
  update public.orders
  set payment_proof_url = p_url,
      payment_proof_public_id = p_public_id,
      status = case
        when v_order.status in ('pendiente', 'esperando_pago') then 'pago_en_revision'
        else v_order.status
      end,
      updated_at = now()
  where id = p_order_id and business_id = p_business_id;

  if v_order.status in ('pendiente', 'esperando_pago') then
    insert into public.order_events (business_id, order_id, from_status, to_status, note)
    values (p_business_id, p_order_id, v_order.status, 'pago_en_revision',
            'El cliente subió su comprobante');
  end if;

  return jsonb_build_object('result', 'updated');
end;
$$;

revoke all on function public.attach_storefront_payment_proof(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.attach_storefront_payment_proof(uuid, uuid, text, text, text)
  to service_role;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
do $comprobacion$
declare
  v_biz uuid;
  v_pedido uuid;
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('comprobante-a', 'A', 'pizzería', 'ycloud', '+593900555901', '+593900555901', true)
  returning id into v_biz;

  insert into orders (business_id, contact_phone, status, total)
  values (v_biz, '+593900000002', 'pendiente', 10)
  returning id into v_pedido;

  -- La columna acepta el identificador y convive con la URL de siempre: los
  -- comprobantes viejos no pierden su enlace.
  update orders
  set payment_proof_url = 'https://res.cloudinary.com/demo/x.jpg',
      payment_proof_public_id = 'botpanel/x/comprobantes/abc123'
  where id = v_pedido;

  if not exists (
    select 1 from orders
    where id = v_pedido
      and payment_proof_public_id = 'botpanel/x/comprobantes/abc123'
      and payment_proof_url is not null
  ) then
    raise exception 'El comprobante no guardó su identificador';
  end if;

  delete from businesses where id = v_biz;
  raise notice 'COMPROBANTES: el identificador para firmar queda guardado';
end;
$comprobacion$;
