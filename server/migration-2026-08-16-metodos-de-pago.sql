-- ═══════════════════════════════════════════════════════════════════════════
-- LOS MÉTODOS DE PAGO, DE VERDAD CONFIGURABLES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy `businesses.payment_methods` era **texto libre que solo alimentaba
-- el prompt del bot** —en Monster Pizza decía literalmente «Transferencia,
-- efectivo»— y la tienda tenía los tres métodos ESCRITOS A MANO en el código.
-- Es decir: el dueño creía que elegía cómo le pagan y no elegía nada.
--
-- La prueba está en los datos: 3 de los 43 pedidos reales se pagaron en
-- efectivo aunque nadie lo hubiera activado, porque no había nada que activar.
--
-- ── POR QUÉ UN CATÁLOGO Y NO UN ENUM ──────────────────────────────────────
--
-- Un `CHECK` con la lista dentro obliga a una migración cada vez que aparece
-- un método nuevo. Con catálogo, añadir uno es **una fila**: aparece en el
-- panel del superadmin y cada dueño decide si lo acepta. Cero código.
--
-- ── QUÉ NACE APAGADO, Y POR QUÉ NO ES PEREZA ──────────────────────────────
--
-- `tarjeta`, `billetera` y `pasarela` entran en el catálogo con
-- `available = false`. Existen en la arquitectura —lo pedía el §18 del prompt
-- maestro— pero **la plataforma NO procesa cobros** (regla inviolable #6), así
-- que encenderlos sería prometerle a un dueño algo que no ocurre.
--
-- Falla CERRADO, igual que `pricing_rules.markup_mode` con `on_top` y que
-- `scope` con 'category': **no se puede activar lo que el sistema no honra**.
-- El día que exista una pasarela real se cambia un booleano.
--
-- ── QUIÉN DECIDE QUÉ ──────────────────────────────────────────────────────
--
-- El SUPERADMIN manda sobre el catálogo: qué métodos existen en la plataforma.
-- El DUEÑO decide los suyos desde su panel, igual que ya decide su envío, su
-- logo y su tiempo de preparación. Si acepta efectivo o no es su negocio.
--
-- ⚠️ `businesses.payment_methods` (el texto libre) NO se borra: sigue
-- alimentando el prompt del bot, que es lo único para lo que servía. Borrarlo
-- dejaría al bot sin saber qué contestar cuando le preguntan cómo se paga.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.


-- ── 1. El catálogo de la plataforma ────────────────────────────────────────
--
-- Sin `business_id` a propósito: es de la plataforma, no de un negocio, igual
-- que `server_settings`. RLS activa y sin políticas — entra el servidor con la
-- service role key y nadie más.
create table if not exists public.payment_methods (
  code           text primary key,
  label          text not null,
  help_text      text,

  -- Lo que de verdad cambia el flujo, y por eso son columnas y no un `if` en
  -- el código: `is_prepaid` decide si el pedido nace esperando pago, y
  -- `requires_proof` si se le pide comprobante.
  is_prepaid     boolean not null default false,
  requires_proof boolean not null default false,

  -- ¿La plataforma puede procesarlo HOY? Lo que está en false no se puede
  -- activar en ningún negocio: falla cerrado.
  available      boolean not null default false,

  sort           integer not null default 0,
  created_at     timestamptz not null default now(),

  constraint payment_methods_code_check
    check (code ~ '^[a-z_]{3,30}$'),
  constraint payment_methods_label_check
    check (char_length(btrim(label)) between 1 and 60),
  constraint payment_methods_sort_check
    check (sort >= 0 and sort <= 999)
);

alter table public.payment_methods enable row level security;

-- Los seis del §18. Los tres primeros son los que la plataforma sabe manejar
-- hoy; los otros tres existen para que activarlos mañana sea un booleano.
insert into public.payment_methods (code, label, help_text, is_prepaid, requires_proof, available, sort)
values
  ('transferencia',   'Transferencia bancaria',
   'Transfiere y manda la captura por el chat del local.', true,  true,  true,  10),
  ('efectivo',        'Efectivo al recibir',
   'Paga en efectivo cuando te lo entreguen.',             false, false, true,  20),
  ('pago_al_retirar', 'Pago al retirar',
   'Pagas cuando pases a recoger tu pedido.',              false, false, true,  30),
  ('tarjeta',         'Tarjeta',                null, true,  false, false, 40),
  ('billetera',       'Billetera digital',      null, true,  false, false, 50),
  ('pasarela',        'Pasarela de pagos',      null, true,  false, false, 60)
on conflict (code) do nothing;


-- ── 2. Los que acepta cada negocio ─────────────────────────────────────────
create table if not exists public.business_payment_methods (
  business_id uuid not null references public.businesses(id) on delete cascade,
  method_code text not null references public.payment_methods(code) on delete restrict,
  enabled     boolean not null default true,
  sort        integer not null default 0,
  updated_at  timestamptz not null default now(),

  primary key (business_id, method_code),
  constraint business_payment_methods_sort_check check (sort >= 0 and sort <= 999)
);

alter table public.business_payment_methods enable row level security;

create index if not exists idx_business_payment_methods_activos
  on public.business_payment_methods (business_id)
  where enabled;

-- No se puede activar un método que la plataforma no sabe procesar. La
-- comprobación va en la BASE y no solo en la ruta porque es la única que no
-- se puede saltar: cierra también el camino del panel del superadmin.
create or replace function public.business_payment_method_disponible()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.enabled and not exists (
    select 1 from public.payment_methods
    where code = new.method_code and available
  ) then
    raise exception using
      errcode = '22023',
      message = 'Ese método de pago todavía no está disponible en la plataforma.';
  end if;
  return new;
end;
$$;

drop trigger if exists business_payment_methods_disponible on public.business_payment_methods;
create trigger business_payment_methods_disponible
  before insert or update on public.business_payment_methods
  for each row execute function public.business_payment_method_disponible();


-- ── 3. Los negocios que ya existen conservan lo que tenían ─────────────────
--
-- Hoy la tienda ofrece transferencia y efectivo a todo el mundo, así que eso
-- es exactamente lo que se les asigna: la migración NO cambia el
-- comportamiento de ningún negocio en marcha. Lo que cambia es que a partir de
-- ahora se puede tocar.
--
-- `pago_al_retirar` también, porque la app ya lo ofrecía en modo retiro.
insert into public.business_payment_methods (business_id, method_code, enabled, sort)
select b.id, m.code, true, m.sort
from public.businesses b
cross join public.payment_methods m
where m.code in ('transferencia', 'efectivo', 'pago_al_retirar')
on conflict (business_id, method_code) do nothing;


-- ── 4. El cinturón: un pedido no puede pagar con lo que el local no acepta ─
--
-- ⚠️ NO se recrea `create_storefront_order`. Su lista interna se queda como
-- guardia AMPLIA de plataforma —rechaza cualquier cosa que no sea uno de los
-- métodos conocidos— y este disparador hace cumplir lo de CADA negocio, dentro
-- de la misma transacción que la inserción.
--
-- Eso cierra además la carrera que la ruta no puede cerrar: entre que la app
-- pinta los métodos y el cliente confirma, el dueño puede haber apagado uno.
--
-- ⚠️ Acotado a `source = 'storefront'`, igual que `orders_reject_blocked`: un
-- pedido de MOSTRADOR lo teclea el dueño con la persona delante, y si decide
-- cobrarle en efectivo un día que tiene el efectivo apagado en su tienda, es
-- asunto suyo.
--
-- Sin método (los pedidos del bot no preguntan cómo se paga) no se comprueba
-- nada: no hay nada que contradecir.
create or replace function public.orders_check_payment_method()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.source, '') = 'storefront'
     and new.payment_method is not null
     and not exists (
       select 1
       from public.business_payment_methods bpm
       join public.payment_methods pm on pm.code = bpm.method_code
       where bpm.business_id = new.business_id
         and bpm.method_code = new.payment_method
         and bpm.enabled
         and pm.available
     ) then
    raise exception using
      errcode = '22023',
      message = 'Ese local no acepta ese método de pago.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_check_payment_method on public.orders;
create trigger orders_check_payment_method
  before insert on public.orders
  for each row execute function public.orders_check_payment_method();


-- ── 5. Lo que la tienda necesita saber ─────────────────────────────────────
--
-- Devuelve solo lo que ese negocio acepta Y la plataforma sabe procesar. La
-- app pinta lo que reciba: deja de tener los métodos escritos a mano.
create or replace function public.storefront_payment_methods(p_business_id uuid)
returns table (
  code           text,
  label          text,
  help_text      text,
  is_prepaid     boolean,
  requires_proof boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pm.code, pm.label, pm.help_text, pm.is_prepaid, pm.requires_proof
  from public.business_payment_methods bpm
  join public.payment_methods pm on pm.code = bpm.method_code
  where bpm.business_id = p_business_id
    and bpm.enabled
    and pm.available
  order by bpm.sort, pm.sort, pm.code;
$$;

revoke all on function public.storefront_payment_methods(uuid) from public, anon, authenticated;
grant execute on function public.storefront_payment_methods(uuid) to service_role;
