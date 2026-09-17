-- ═══════════════════════════════════════════════════════════════════════════
-- LAS PLANTILLAS DE OPCIONES FUNCIONAN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El panel del dueño deja crear una «plantilla reutilizable» —los 19 sabores de
-- una pizzería, definidos una vez— y enganchar un grupo a ella. Y ahí se
-- acababa: ni la tienda (`services/storefront.ts`) ni la RPC del pedido
-- (`create_storefront_order`) leían `option_template_items`. El grupo
-- enganchado se quedaba sin opciones propias, la tienda lo descartaba por
-- vacío y el cliente NO VEÍA NADA, sin un solo aviso. Construida y
-- desconectada: décima vez del patrón de camino-real.
--
-- En producción nadie la había usado todavía (0 plantillas, 0 grupos), así que
-- no había nada roto — había una trampa esperando al primero que la pisara.
-- Se descubrió al ir a armar los sabores de los combos de Monster Pizza.
--
-- ⚠️ SE ARREGLA COPIANDO, NO ENSEÑANDO A LA RPC A LEER PLANTILLAS, y la razón
-- es concreta. La RPC identifica cada elección por el id de la opción y
-- RECHAZA un id repetido («viene repetida»). Un mismo sabor de la plantilla
-- vive en varios pasos a la vez —«Sabor 1.ª pizza» y «Sabor 2.ª pizza»—, así
-- que «2 pizzas hawaianas» mandaría el mismo id dos veces y el pedido se
-- rechazaría. Leer plantillas en la RPC obligaba a cambiar el payload, la
-- validación, la deduplicación y el guardado: el CAMINO DEL DINERO en cuatro
-- sitios.
--
-- Copiando, cada grupo tiene SUS opciones con SUS ids. La tienda, la
-- cotización y la RPC siguen leyendo `options` exactamente como antes, sin
-- cambiar una línea. Lo que mantiene la base es que las copias no se separen
-- nunca de la plantilla.
--
-- ⚠️ ENGANCHAR NO BORRA LAS OPCIONES MANUALES del grupo. Borrar datos del
-- dueño en silencio por tocar un desplegable sería peor que enseñarle las dos
-- cosas juntas; el panel marca cuáles vienen de la plantilla.
--
-- Lo que NO toca: `create_storefront_order`, `quoteCart`, la tienda, los
-- precios, ni los pedidos ya hechos.


-- ── 1. El destino de la foránea compuesta ──────────────────────────────────
--
-- ⚠️ ANTES que la foránea: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_option_template_items_id_business
  on public.option_template_items (id, business_id);


-- ── 2. Cada copia sabe de qué ítem viene ───────────────────────────────────
alter table public.options
  add column if not exists option_template_item_id uuid;

comment on column public.options.option_template_item_id is
  'Si no es nulo, esta opción es una COPIA de un ítem de plantilla y la '
  'mantiene la base: no se edita a mano, se edita la plantilla.';

-- ⚠️ COMPUESTA sobre (id, business_id). Una de una sola columna comprueba «ese
-- ítem existe», no «ese ítem es de este negocio» — y el guardián de fronteras
-- (`verificar-fronteras.sql`) para el CI si la encuentra.
--
-- `on delete cascade`: borrar un sabor de la plantilla borra sus copias. Con la
-- columna nula (opción manual) la foránea no aplica y la opción no se toca.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.options'::regclass
      and conname = 'fk_options_item_de_plantilla_del_negocio'
  ) then
    alter table public.options
      add constraint fk_options_item_de_plantilla_del_negocio
      foreign key (option_template_item_id, business_id)
      references public.option_template_items (id, business_id)
      on delete cascade;
  end if;
end $$;

-- Una sola copia de cada ítem por grupo: sin esto, dos sincronizaciones
-- seguidas podrían duplicar un sabor.
create unique index if not exists uq_options_copia_por_grupo
  on public.options (option_group_id, option_template_item_id)
  where option_template_item_id is not null;


-- ── 3. Sincronizar un grupo con su plantilla ───────────────────────────────
--
-- Una sola función para los tres momentos —enganchar, editar la plantilla,
-- desenganchar—, y es idempotente: correrla dos veces deja lo mismo que una.
create or replace function public.sincronizar_plantilla_en_grupo(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plantilla uuid;
  v_negocio   uuid;
begin
  select option_template_id, business_id
    into v_plantilla, v_negocio
    from public.option_groups
   where id = p_group_id;

  if not found then
    return;
  end if;

  -- Sin plantilla: fuera las copias. Las opciones MANUALES se quedan.
  if v_plantilla is null then
    delete from public.options
     where option_group_id = p_group_id
       and option_template_item_id is not null;
    return;
  end if;

  -- Copias de ítems que ya no son de ESTA plantilla (se cambió de plantilla).
  delete from public.options as o
   where o.option_group_id = p_group_id
     and o.option_template_item_id is not null
     and not exists (
       select 1 from public.option_template_items i
        where i.id = o.option_template_item_id
          and i.option_template_id = v_plantilla
     );

  -- Las que ya existen se ponen al día. Todo lo que ve el cliente viaja.
  update public.options as o
     set name                  = i.name,
         description           = i.description,
         image_url             = i.image_url,
         image_public_id       = i.image_public_id,
         price_adjustment      = i.price_adjustment,
         references_product_id = i.references_product_id,
         default_selected      = i.default_selected,
         stock                 = i.stock,
         sort                  = i.sort,
         active                = i.active,
         updated_at            = now()
    from public.option_template_items as i
   where o.option_group_id = p_group_id
     and o.option_template_item_id = i.id
     and i.option_template_id = v_plantilla;

  -- Y las que faltan se crean.
  insert into public.options (
    business_id, option_group_id, option_template_item_id, name, description,
    image_url, image_public_id, price_adjustment, references_product_id,
    default_selected, stock, sort, active
  )
  select v_negocio, p_group_id, i.id, i.name, i.description,
         i.image_url, i.image_public_id, i.price_adjustment, i.references_product_id,
         i.default_selected, i.stock, i.sort, i.active
    from public.option_template_items as i
   where i.option_template_id = v_plantilla
     and i.business_id = v_negocio
     and not exists (
       select 1 from public.options o
        where o.option_group_id = p_group_id
          and o.option_template_item_id = i.id
     );
end;
$$;

revoke all on function public.sincronizar_plantilla_en_grupo(uuid)
  from public, anon, authenticated;


-- ── 4. Enganchar o desenganchar un grupo ───────────────────────────────────
create or replace function public.option_groups_sincronizar_plantilla()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sincronizar_plantilla_en_grupo(new.id);
  return null;
end;
$$;

revoke all on function public.option_groups_sincronizar_plantilla()
  from public, anon, authenticated;

-- ⚠️ `after insert` además de `update`: un grupo que NACE ya enganchado (la
-- plantilla del alta de una pizzería, por ejemplo) tiene que salir con sus
-- sabores, no vacío.
drop trigger if exists option_groups_sincronizar_plantilla on public.option_groups;
create trigger option_groups_sincronizar_plantilla
  after insert or update of option_template_id on public.option_groups
  for each row execute function public.option_groups_sincronizar_plantilla();


-- ── 5. Editar la plantilla llega a todos los grupos que la usan ────────────
create or replace function public.option_template_items_propagar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sincronizar_plantilla_en_grupo(g.id)
     from public.option_groups g
    where g.option_template_id = coalesce(new.option_template_id, old.option_template_id)
       -- Un ítem que cambia de plantilla tiene que desaparecer de la vieja.
       or (tg_op = 'UPDATE' and g.option_template_id = old.option_template_id);
  return null;
end;
$$;

revoke all on function public.option_template_items_propagar()
  from public, anon, authenticated;

drop trigger if exists option_template_items_propagar on public.option_template_items;
create trigger option_template_items_propagar
  after insert or update or delete on public.option_template_items
  for each row execute function public.option_template_items_propagar();
