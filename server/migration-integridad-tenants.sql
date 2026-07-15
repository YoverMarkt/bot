-- Refuerza el aislamiento multi-tenant en las tablas heredadas.
--
-- Esta migración:
--   1. comprueba que no existan filas sin negocio;
--   2. falla y revierte todo si encuentra alguna;
--   3. vuelve obligatorio business_id sin modificar datos válidos.
--
-- Es idempotente: puede ejecutarse nuevamente sin efectos adicionales.

begin;

-- Evita dejar la aplicación esperando indefinidamente si otra operación
-- mantiene bloqueada alguna tabla durante la ejecución.
set local lock_timeout = '5s';
set local statement_timeout = '2min';

do $$
declare
  v_table text;
  v_null_count bigint;
  v_tables constant text[] := array[
    'client_users',
    'products',
    'bot_policies',
    'conversation_history',
    'conversation_sessions',
    'conversation_tags',
    'business_schedule',
    'billing',
    'sales',
    'sale_items',
    'product_consultations',
    'ai_gaps',
    'orders',
    'order_items'
  ];
begin
  foreach v_table in array v_tables loop
    if to_regclass(format('public.%I', v_table)) is null then
      raise exception using
        errcode = '42P01',
        message = format('Falta la tabla requerida public.%I.', v_table);
    end if;

    execute format(
      'select count(*) from public.%I where business_id is null',
      v_table
    ) into v_null_count;

    if v_null_count > 0 then
      raise exception using
        errcode = '23502',
        message = format(
          'La tabla public.%I tiene %s fila(s) sin business_id. Corrígelas antes de continuar.',
          v_table,
          v_null_count
        );
    end if;
  end loop;
end;
$$;

alter table public.client_users alter column business_id set not null;
alter table public.products alter column business_id set not null;
alter table public.bot_policies alter column business_id set not null;
alter table public.conversation_history alter column business_id set not null;
alter table public.conversation_sessions alter column business_id set not null;
alter table public.conversation_tags alter column business_id set not null;
alter table public.business_schedule alter column business_id set not null;
alter table public.billing alter column business_id set not null;
alter table public.sales alter column business_id set not null;
alter table public.sale_items alter column business_id set not null;
alter table public.product_consultations alter column business_id set not null;
alter table public.ai_gaps alter column business_id set not null;
alter table public.orders alter column business_id set not null;
alter table public.order_items alter column business_id set not null;

commit;
