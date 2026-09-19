-- ═══════════════════════════════════════════════════════════════════════════
-- UNA VENTA SIN FECHA NO EXISTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `sales.sold_at` tenía `default now()` pero NO `not null`, así que un insert
-- que pasara NULL explícitamente lo aceptaba.
--
-- Lo destapó el tipado generado de la base (2026-09-19): la columna es
-- `string | null` para PostgREST, mientras que `services/reports.ts` la declara
-- `string` y hace `new Date(v.sold_at).getTime()` en tres sitios. Con NULL eso
-- no lanza — devuelve el epoch — así que esa venta se habría contado en **1970**
-- y habría desaparecido de los reportes del dueño sin un solo error en ningún
-- log. El peor tipo de fallo: silencioso y en el dinero.
--
-- Hoy no está pasando: 0 de 9 ventas tienen `sold_at` nulo. Esto cierra la
-- puerta antes de que pase, que es cuando sale barato.
--
-- ⚠️ Idempotente y sin pérdida: solo actúa si la columna sigue siendo nullable,
-- y antes de exigir el NOT NULL rellena lo que hubiera con `created_at` (y solo
-- si tampoco lo hay, con `now()`). Ninguna fila se borra ni se descarta.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sales'
      and column_name = 'sold_at'
      and is_nullable = 'YES'
  ) then
    -- Por si alguna venta antigua se coló sin fecha: se le pone la de creación,
    -- que es lo más cercano a la verdad que hay.
    update sales
       set sold_at = coalesce(sold_at, created_at, now())
     where sold_at is null;

    alter table sales alter column sold_at set not null;

    raise notice 'sales.sold_at ahora es NOT NULL';
  end if;
end $$;
