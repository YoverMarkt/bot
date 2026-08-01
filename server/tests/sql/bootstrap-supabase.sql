-- ============================================================================
-- BOOTSTRAP: emula lo mínimo de Supabase para poder aplicar schema.sql en un
-- PostgreSQL limpio (el del CI o el de tu Docker local).
--
-- Supabase trae de fábrica cosas que un Postgres vanilla no tiene, y schema.sql
-- las da por supuestas. Sin esto, el esquema ni siquiera se aplica.
--
-- ⚠️ Esto es una IMITACIÓN, no Supabase. Sirve para detectar migraciones rotas,
-- funciones que revientan y contratos que no cuadran — no para garantizar que
-- algo se comportará idéntico en producción.
-- ============================================================================

-- Supabase instala las extensiones en su propio esquema, no en `public`.
-- Reproducirlo es justamente lo que permite detectar el fallo de julio de 2026:
-- una función con `search_path = public, pg_temp` que llama a digest() de
-- pgcrypto no la encuentra, igual que en producción.
create schema if not exists extensions;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector;
create extension if not exists btree_gist;

-- Roles que schema.sql usa en sus `grant` y `revoke`.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
