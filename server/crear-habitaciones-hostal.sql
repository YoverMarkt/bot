-- ─────────────────────────────────────────────────────────────────────────
-- Crear habitaciones REALES para el hostal (carga en lote)
-- ─────────────────────────────────────────────────────────────────────────
-- Esto NO es data de prueba: inserta habitaciones permanentes en la base,
-- idénticas a crearlas a mano en el panel de Hospedaje, pero de una sola vez
-- para no tipear una por una. El bot las usa igual que cualquier otra.
--
-- NO borra ni modifica las habitaciones que ya existan: usa
-- ON CONFLICT (business_id, lower(name)) DO NOTHING, así que se puede correr
-- varias veces sin duplicar ni pisar nada.
--
-- ► A QUÉ NEGOCIO ENTRAN: se resuelve por el slug de abajo. Cámbialo por el de
--   TU hostal (o pídemelo y lo ajusto). Si el negocio no existe o no tiene
--   hospedaje habilitado, aborta sin escribir nada.
--
-- ► CANTIDAD: 11 tipos nuevos. Con los 4 que ya tienes (Matrimonial, Suite
--   Familiar, Suite Pareja y Suite Premium) quedan 15 tipos. Ningún nombre
--   choca con los tuyos. La lista de habitaciones del bot ya PAGINA (muestra 8
--   y un "Ver más"), así que no hay problema con el tope de WhatsApp por más
--   habitaciones que agregues.
--
-- Correr en: Supabase → SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────

do $$
declare
  v_slug text := 'hostal-vista-andina-1784175667831';  -- ◄◄ CAMBIA por tu hostal
  v_business_id uuid;
begin
  select id into v_business_id
  from public.businesses
  where slug = v_slug or lower(name) = lower('Hostal Vista Andina')
  order by created_at asc
  limit 1;

  if v_business_id is null then
    raise exception 'No se encontró el hostal (revisa el slug %).', v_slug;
  end if;

  if not exists (
    select 1 from public.businesses
    where id = v_business_id and coalesce(lodging_enabled, false) = true
  ) then
    raise exception 'El negocio % no tiene hospedaje habilitado.', v_business_id;
  end if;

  -- name, description, amenities, total_units, base_occupancy, max_guests,
  -- pricing_model, base_rate, weekend_rate, extra_adult_rate, child_rate
  insert into public.lodging_room_types (
    business_id, name, description, amenities, total_units,
    base_occupancy, max_guests, pricing_model, base_rate, weekend_rate,
    extra_adult_rate, child_rate
  )
  values
    -- ── Por habitación (precio fijo, capacidad fija: no pregunta personas) ──
    (v_business_id, 'Habitación Individual',
     'Ideal para viajeros solos. Cama individual, baño privado y wifi.',
     array['wifi','baño privado','tv','agua caliente'], 3,
     1, 1, 'per_unit', 22.00, 28.00, 0, 0),

    (v_business_id, 'Doble Twin',
     'Dos camas individuales, perfecta para amigos o colegas. Baño privado y wifi.',
     array['wifi','baño privado','tv','agua caliente','escritorio'], 3,
     2, 2, 'per_unit', 38.00, 45.00, 0, 0),

    (v_business_id, 'Doble Superior',
     'Cama matrimonial amplia con mejores acabados y vista. Baño privado.',
     array['wifi','baño privado','tv','minibar','agua caliente','vista'], 2,
     2, 2, 'per_unit', 48.00, 56.00, 0, 0),

    (v_business_id, 'Habitación Triple',
     'Tres camas cómodas para grupos pequeños. Amplia, con baño privado y wifi.',
     array['wifi','baño privado','tv','agua caliente','clóset amplio'], 2,
     3, 3, 'per_unit', 52.00, 60.00, 0, 0),

    (v_business_id, 'Cuádruple Privada',
     'Habitación privada para 4, con dos literas. Baño privado y wifi.',
     array['wifi','baño privado','tv','agua caliente','literas'], 2,
     4, 4, 'per_unit', 75.00, 88.00, 0, 0),

    -- ── Por persona (se cobra por huésped) ──
    (v_business_id, 'Cuádruple Compartida',
     'Hasta 4 huéspedes, se paga por persona. Ideal para grupos que buscan ahorrar.',
     array['wifi','baño compartido','lockers','agua caliente'], 3,
     1, 4, 'per_person', 16.00, 20.00, 0, 0),

    (v_business_id, 'Dormitorio Compartido Mixto',
     'Estilo hostel, hasta 8 camas. Se paga por persona; ambiente social.',
     array['wifi','baño compartido','lockers','área común','agua caliente'], 2,
     1, 8, 'per_person', 12.00, 15.00, 0, 0),

    (v_business_id, 'Dormitorio Femenino',
     'Dormitorio solo para mujeres, hasta 6 camas. Se paga por persona.',
     array['wifi','baño compartido','lockers','área común'], 1,
     1, 6, 'per_person', 13.00, 16.00, 0, 0),

    -- ── Base + extra (base incluye 2, se cobran adultos/niños adicionales) ──
    (v_business_id, 'Suite Junior',
     'Cama king con sala pequeña. Base 2, admite hasta 2 personas extra.',
     array['wifi','baño privado','tv','minibar','agua caliente'], 2,
     2, 4, 'base_plus_extra', 70.00, 82.00, 14.00, 7.00),

    (v_business_id, 'Cabaña Familiar',
     'Cabaña independiente hasta 6 personas, con cocina. Base 2 + adultos/niños extra.',
     array['wifi','baño privado','cocina','tv','parrilla','estacionamiento'], 2,
     2, 6, 'base_plus_extra', 95.00, 115.00, 15.00, 8.00),

    (v_business_id, 'Loft Vista Montaña',
     'Loft amplio de dos niveles con ventanal panorámico. Base 2, hasta 5 huéspedes.',
     array['wifi','baño privado','cocina','tv','balcón','vista','agua caliente'], 1,
     2, 5, 'base_plus_extra', 110.00, 130.00, 20.00, 10.00)
  on conflict (business_id, lower(name)) do nothing;

  raise notice 'Habitaciones cargadas para el negocio % (sin tocar las existentes).', v_business_id;
end $$;

-- Verificación (opcional): lista el catálogo resultante
-- select name, total_units, base_occupancy, max_guests, pricing_model,
--        base_rate, weekend_rate, extra_adult_rate, child_rate, active
-- from public.lodging_room_types
-- where business_id = (select id from public.businesses
--                      where slug = 'hostal-vista-andina-1784175667831' limit 1)
-- order by max_guests, name;
