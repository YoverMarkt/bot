-- ═══════════════════════════════════════════════════════════════════════════
-- EL PUNTO DEL LOCAL EN EL MAPA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `businesses.address` existe desde siempre, pero es TEXTO suelto: sirve para
-- leerlo, no para llegar. Y en Ecuador media ciudad se ubica con «frente a
-- Portocentro» — un geocoder falla con eso; un punto no.
--
-- Hasta hoy el sistema tenía el punto de UNA sola de las dos puntas del
-- reparto:
--
--   · el del CLIENTE ✅ — lo captura la mini app con `navigator.geolocation`,
--     lo captura el chat cuando comparte su ubicación de WhatsApp, y el pedido
--     lo CONGELA en `delivery_latitude`/`delivery_longitude`;
--   · el del LOCAL ❌ — no existía en ninguna parte.
--
-- Sin el segundo no se puede: decirle a quien retira a dónde ir (hoy el aviso
-- dice «pasa a retirarlo por Monster Pizza» y NO dice dónde), ni darle a un
-- repartidor su punto de recogida. Es el cimiento de las dos cosas.
--
-- ⚠️ Se copia el patrón de `customer_addresses`, no se inventa otro:
-- `numeric(10,7)` —siete decimales son ~1 cm, de sobra— y el mismo CHECK de
-- rango. Dos formas de guardar una coordenada en la misma base acabarían
-- redondeando distinto.
--
-- ⚠️ Los DOS o NINGUNO. Media coordenada no es media ubicación: apunta al
-- ecuador o al meridiano de Greenwich. Es la misma regla que ya aplica la mini
-- app al pin del cliente («con pin es tener los DOS»), y aquí se hace cumplir
-- en la base, que es donde no se puede saltar.
--
-- ⚠️ NO se toca `address`. El texto sigue siendo lo que se lee («Av. del
-- Ejército frente a Portocentro»); el punto es lo que se navega. Los dos
-- juntos, como en cualquier app de reparto: uno sin el otro deja al repartidor
-- con un pin en mitad de una manzana o con una frase que su GPS no entiende.

alter table public.businesses
  add column if not exists latitude  numeric(10,7),
  add column if not exists longitude numeric(10,7);

comment on column public.businesses.latitude is
  'Latitud del local. Con `longitude`, el punto de RECOGIDA de un pedido: lo '
  'usa quien retira y lo usará la app del repartidor.';
comment on column public.businesses.longitude is
  'Longitud del local. Va siempre junto a `latitude` (las dos o ninguna).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass
      and conname = 'businesses_ubicacion_check'
  ) then
    alter table public.businesses add constraint businesses_ubicacion_check check (
      (latitude is null or latitude between -90 and 90)
      and (longitude is null or longitude between -180 and 180)
      -- Las dos o ninguna: media coordenada apunta al ecuador, no a medias.
      and ((latitude is null) = (longitude is null))
    );
  end if;
end $$;
