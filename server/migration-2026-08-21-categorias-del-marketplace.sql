-- ═══════════════════════════════════════════════════════════════════════════
-- LAS CATEGORÍAS DEL MARKETPLACE
--
-- Lo primero que ve quien escribe al número de Umbani: «¿qué deseas pedir?»
-- seguido de una lista corta. No son los 31 tipos de negocio —nadie elige
-- entre 31 botones, y WhatsApp solo admite 10 filas por lista—, sino grupos
-- pensados para el cliente: «Hamburguesas» junta hamburguesería y comida
-- rápida, porque para quien pide es lo mismo.
--
-- ⚠️ UN TIPO PERTENECE A UNA SOLA CATEGORÍA (`primary key (business_type)`).
-- Si pudiera estar en dos, el mismo local saldría dos veces en el menú y el
-- cliente no sabría si son dos sitios distintos.
--
-- ⚠️ Son catálogo de PLATAFORMA, no datos de un negocio: por eso no llevan
-- `business_id`, exactamente igual que `business_families`, y se protegen del
-- mismo modo (RLS sin políticas → solo `service_role`, que la salta).
--
-- ⚠️ El menú NO enseña una categoría vacía. Ofrecer «Heladerías» y que dentro
-- no haya ninguna es una calle sin salida, y el cliente ya gastó un mensaje.
-- De eso se encarga `marketplace_categories_disponibles()`.
-- ═══════════════════════════════════════════════════════════════════════════


create table if not exists public.marketplace_categories (
  id     uuid primary key default gen_random_uuid(),
  code   text not null unique,
  label  text not null,
  emoji  text,
  sort   integer not null default 0,
  active boolean not null default true,

  constraint marketplace_categories_code_check  check (code ~ '^[a-z][a-z0-9_]{2,39}$'),
  constraint marketplace_categories_label_check check (char_length(btrim(label)) between 1 and 40),
  constraint marketplace_categories_emoji_check check (emoji is null or char_length(emoji) <= 8),
  constraint marketplace_categories_sort_check  check (sort between 0 and 999)
);

alter table public.marketplace_categories enable row level security;

create table if not exists public.marketplace_category_types (
  -- La clave es el TIPO: un tipo cuelga de una categoría y solo de una.
  business_type text primary key,
  category_id   uuid not null
                references public.marketplace_categories(id) on delete cascade
);

alter table public.marketplace_category_types enable row level security;

create index if not exists idx_marketplace_category_types_categoria
  on public.marketplace_category_types (category_id);


-- ── El reparto de los 31 tipos ─────────────────────────────────────────────
--
-- Cubre los 31 exactamente una vez. Si mañana se añade un tipo al desplegable
-- y no se reparte aquí, sus locales no saldrán en ninguna categoría — lo
-- vigila `tests/categorias-marketplace.test.js`.
insert into public.marketplace_categories (code, label, emoji, sort) values
  ('pizzerias',      'Pizzerías',            '🍕', 10),
  ('hamburguesas',   'Hamburguesas',         '🍔', 20),
  ('almuerzos',      'Almuerzos',            '🍽️', 30),
  ('asados',         'Asados y parrilla',    '🔥', 40),
  ('mariscos',       'Mariscos y ceviches',  '🐟', 50),
  ('internacional',  'Comida internacional', '🌎', 60),
  ('desayunos',      'Desayunos y café',     '🍳', 70),
  ('postres',        'Heladerías y postres', '🍦', 80),
  ('jugos',          'Jugos y batidos',      '🥤', 90),
  ('panaderias',     'Panaderías',           '🥖', 100),
  ('minimarkets',    'Minimarkets',          '🛒', 110),
  ('farmacias',      'Farmacias',            '💊', 120),
  ('perfumerias',    'Perfumerías',          '🧴', 130),
  ('ferreterias',    'Ferreterías',          '🔧', 140),
  ('otros',          'Otros',                '🏪', 150)
on conflict (code) do nothing;

insert into public.marketplace_category_types (business_type, category_id)
select t.business_type, c.id
from (values
  ('pizzería','pizzerias'),
  ('hamburguesería','hamburguesas'), ('comida rápida','hamburguesas'),
  ('almuerzos','almuerzos'), ('menú ejecutivo','almuerzos'),
  ('comida típica','almuerzos'), ('restaurante','almuerzos'),
  ('asadero','asados'), ('parrillada','asados'), ('pollo asado','asados'),
  ('marisquería','mariscos'),
  ('sushi','internacional'), ('comida mexicana','internacional'),
  ('comida china','internacional'), ('comida saludable','internacional'),
  ('desayunos','desayunos'), ('cafetería','desayunos'),
  ('heladería','postres'), ('postres','postres'), ('pastelería','postres'),
  ('batidos','jugos'), ('jugos','jugos'),
  ('panadería','panaderias'),
  ('tienda','minimarkets'), ('supermercado','minimarkets'), ('carnicería','minimarkets'),
  ('farmacia','farmacias'),
  ('perfumería','perfumerias'),
  ('ferretería','ferreterias'),
  ('emprendimiento de comida','otros'), ('negocio','otros')
) as t(business_type, code)
join public.marketplace_categories c on c.code = t.code
on conflict (business_type) do nothing;


-- ── Solo las categorías que tienen algo detrás ─────────────────────────────
--
-- Un local cuenta si puede recibir un pedido AHORA: activo, no suspendido, con
-- pedidos y tienda encendidos. Los mismos requisitos que ya exige el modo mini
-- app, porque el menú termina justo ahí — mandando el enlace de su tienda.
--
-- ⚠️ `security invoker` (el defecto): quien la llama es `service_role`, que ya
-- lee las tablas. No hace falta elevar nada.
create or replace function public.marketplace_categories_disponibles()
returns table (
  code    text,
  label   text,
  emoji   text,
  sort    integer,
  locales bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select c.code, c.label, c.emoji, c.sort, count(b.id) as locales
  from public.marketplace_categories c
  join public.marketplace_category_types t on t.category_id = c.id
  join public.businesses b on b.type = t.business_type
  where c.active
    and b.active
    and b.suspended is not true
    and b.takes_orders
    and b.storefront_enabled
  group by c.code, c.label, c.emoji, c.sort
  having count(b.id) > 0
  order by c.sort, c.label;
$$;

revoke all on function public.marketplace_categories_disponibles()
  from public, anon, authenticated;
grant execute on function public.marketplace_categories_disponibles()
  to service_role;


-- ── Los locales de una categoría ───────────────────────────────────────────
create or replace function public.marketplace_negocios_de_categoria(p_code text)
returns table (
  id       uuid,
  slug     text,
  name     text,
  type     text,
  prep_min integer
)
language sql
stable
set search_path = public, pg_temp
as $$
  select b.id, b.slug, b.name, b.type,
         b.prep_time_minutes + coalesce(b.delivery_extra_minutes, 0)
  from public.businesses b
  join public.marketplace_category_types t on t.business_type = b.type
  join public.marketplace_categories c on c.id = t.category_id
  where c.code = p_code
    and c.active
    and b.active
    and b.suspended is not true
    and b.takes_orders
    and b.storefront_enabled
  order by b.name;
$$;

revoke all on function public.marketplace_negocios_de_categoria(text)
  from public, anon, authenticated;
grant execute on function public.marketplace_negocios_de_categoria(text)
  to service_role;
