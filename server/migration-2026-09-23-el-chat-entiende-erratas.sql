-- ============================================================================
-- EL CHAT ENTIENDE «pizzza» SIN PEDIRLE AL CLIENTE QUE ESCRIBA MEJOR
--
-- Pedido del dueño (2026-09-23), después de probar su propia app: «"pizzza",
-- "seviche"… ¿podemos mandar un mensaje educando al cliente, "por favor
-- escriba bien"? Porque una cosa es escribir "sdadskads" y otra decir "pissa"
-- en vez de "pizza"».
--
-- ── POR QUÉ NO SE LE PIDE QUE ESCRIBA MEJOR ─────────────────────────────────
--
-- Las apps grandes NUNCA le piden al cliente que corrija. Escribes «pizzza» en
-- Google o en Rappi y te enseñan pizzas. Pedirle que lo escriba bien le pasa a
-- él el trabajo, le hace sentir tonto —justo lo que se acaba de quitar con los
-- plurales— y cuesta un mensaje saliente de ida y vuelta, que se paga.
--
-- Así que se entiende la errata y se actúa. Esta función es la que lo permite.
--
-- ── EL UMBRAL NO SE ELIGIÓ A OJO ────────────────────────────────────────────
--
-- Se midió `similarity()` de erratas reales y de basura contra el diccionario
-- REAL de producción:
--
--     BASURA                          ERRATAS DE VERDAD
--     asdfghjkl  → asado      0.14    pizzza      → pizza        0.86
--     gracias    → farmacia   0.13    hanburguesa → hamburguesa  0.60
--     hola       → helado     0.09    piza        → pizza        0.57
--     sdadskads  → seco       0.08    parriyada   → parrillada   0.50
--     qwerty     → ceviche    0.00    almuerso    → almuerzo     0.50
--                                     seviche     → ceviche      0.45
--                                     anburguesa  → hamburguesa  0.44
--
-- Hay una línea limpia en **0.40**: por encima solo erratas, por debajo solo
-- basura, con **3 veces de margen** sobre la peor basura (0.14).
--
-- ⚠️ LO QUE ESTE MÉTODO NO PESCA, Y ES HONESTO SABERLO: «pissa» (0.20) y
-- «pisa» (0.22) caen en territorio de basura. No es un fallo del umbral: son
-- palabras demasiado CORTAS y a los trigramas les faltan letras para estar
-- seguros. Bajar el umbral para pescarlas metería «asdfghjkl» dentro. Esas
-- caen al menú de categorías — que tampoco es mal sitio: desde ahí el cliente
-- llega a su pizza en un toque, y el menú educa sin sermón.
--
-- ⚠️ `pg_trgm` YA estaba instalada en producción; no se añade ninguna
-- extensión.
-- ============================================================================

-- ⚠️ Existe como función y no como filtro de PostgREST porque `similarity()`
-- no se puede expresar en un `select` de supabase-js: hace falta ordenar POR
-- el parecido y quedarse con el mejor.
create or replace function public.marketplace_alias_parecido(
  p_palabras text[],
  p_minimo   real default 0.40
)
returns table (
  category_code text,
  term          text,
  parecido      real
)
language sql
stable
security definer
set search_path = public, pg_temp, extensions
as $$
  select a.category_code, a.term, max(similarity(a.term, p.palabra))::real as parecido
  from public.marketplace_search_aliases a
  cross join unnest(p_palabras) as p(palabra)
  -- Palabras de menos de 4 letras NO entran: son justo donde los trigramas
  -- fallan («pisa» contra «pizza» da 0.22, lo mismo que la basura).
  where char_length(p.palabra) >= 4
    and similarity(a.term, p.palabra) >= p_minimo
  group by a.category_code, a.term
  order by parecido desc, a.term
  limit 1;
$$;

revoke all on function public.marketplace_alias_parecido(text[], real)
  from public, anon, authenticated;
grant execute on function public.marketplace_alias_parecido(text[], real)
  to service_role;

-- El índice que lo hace barato. Sin él, cada errata recorre el diccionario
-- entero calculando trigramas — hoy son 44 filas y da igual, pero esta tabla
-- crece con cada término que añade el superadmin.
create index if not exists idx_alias_trigramas
  on public.marketplace_search_aliases using gin (term extensions.gin_trgm_ops);
