# Guía del equipo — BotPanel

Bienvenido/a. BotPanel es un SaaS multi-empresa de bots de atención con IA (WhatsApp/Telegram) para negocios reales. Esta guía es lo mínimo que debes leer antes de tu primer PR. La referencia técnica profunda vive en [CLAUDE.md](CLAUDE.md) y [ARQUITECTURA.md](ARQUITECTURA.md).

## Levantar el proyecto (10 minutos)

1. **Node.js ≥ 22** (`node -v`).
2. `npm install` en la raíz (monorepo con workspaces: instala server + paneles de una vez).
3. Copia `server/.env.example` → `server/.env` y llena las credenciales ([CREDENCIALES-DONDE-CONSEGUIRLAS.md](CREDENCIALES-DONDE-CONSEGUIRLAS.md)). **Nunca uses credenciales de producción en desarrollo.**
4. `npm run dev` — servidor con recarga. Paneles: `localhost:3000/app` (cliente) y `/app-admin` (superadmin).
5. Guía completa de instalación: [PASOS-INSTALACION.md](PASOS-INSTALACION.md).

## Flujo de trabajo (obligatorio — `main` está protegida)

No se puede hacer push directo a `main`: todo cambio entra por PR con el CI en verde. Sin excepciones, ni para admins.

1. **Rama** desde `main` actualizada: `tipo/descripcion-corta` (ej. `fix/csp-media-blob-alarma`, `feat/modales-etiquetas`).
2. **Commits pequeños y descriptivos, en español**: `fix: el CSP bloqueaba el sonido de la alarma`.
3. **Verifica antes de subir**: `npm run check` (lint + tipos + tests) y `npm run test:e2e` si tocaste UI.
4. **PR** con la plantilla (se carga sola): qué cambia, qué NO se toca, cómo se verificó.
5. **CI en verde** (4 checks) → merge. Si el CI falla, se arregla en la rama; nunca se fuerza.

## Estándares de código

- **TypeScript estricto** en `server/src/**`; `server/dist/` es compilado (no se edita). Los paneles son React + Vite + TS + Tailwind + **shadcn/ui** (`packages/ui`).
- **Nombres en inglés** (`camelCase` en TS, `snake_case` en BD); **comentarios y logs en español**; **textos visibles al cliente en español neutro** (mercado Ecuador/Colombia).
- **Todo acceso a Supabase pasa por `server/src/db/`** (repositorios). Nunca `sb.from(...)` desde rutas o servicios.
- **Keys y secretos**: variables de entorno o `server_settings` vía `services/settings.ts`. Jamás en el código.
- **Edición quirúrgica**: no reescribas archivos completos ni borres lo que no se pidió tocar.
- Cambio nuevo = **test nuevo** que lo proteja (Vitest en `server/tests/`, E2E en `e2e/`).

## Reglas inviolables (violarlas = el PR no entra)

1. **Multi-tenancy:** toda consulta se filtra por `business_id`, y en endpoints de cliente sale SIEMPRE del JWT (`req.user.businessId`), nunca de un parámetro. Toda tabla nueva nace con `business_id` + RLS. RLS jamás se debilita.
2. **`SUPABASE_SERVICE_KEY` solo en el servidor.** El frontend nunca habla directo con Supabase.
3. **La IA conversa, el CÓDIGO calcula.** Ningún monto que vea un cliente sale del modelo: totales y precios solo server-side (`services/money.ts`, `services/lodging.ts`, RPCs). El prompt es cortesía, no seguridad.
4. **El bot nunca inventa datos** — precios, stock y horarios salen solo de los datos del negocio.
5. **Cobro manual:** la plataforma nunca procesa pagos; el equipo del negocio confirma y cobra.
6. **Toda superficie que procese respuestas de la IA usa el parser central** (`services/bot-tags.ts`). Nada de limpiar etiquetas `##...##` a mano.

## Antes de tocar zonas sensibles

Base de datos, RLS, auth, dinero, etiquetas del bot o multi-tenancy → consulta primero [ARQUITECTURA.md](ARQUITECTURA.md) y las skills de `.claude/skills/` (arquitecto-saas, seguridad-saas, base-de-datos). Si trabajas con Claude Code, estas reglas se aplican automáticamente; si no, léelas tú.

## Mapa rápido del repo

| Dónde | Qué |
|---|---|
| `server/src/routes/` | Endpoints Express (auth por JWT en `middleware/auth.ts`) |
| `server/src/services/` | Lógica del bot, dinero, hospedaje, reportes |
| `server/src/db/repositories/` | Único punto de acceso a Supabase |
| `apps/client` · `apps/admin` | Panel del negocio · panel del superadmin |
| `packages/ui` | Componentes shadcn/ui compartidos |
| `server/tests/` · `e2e/` | Vitest (contra `dist/`) · Playwright |
| `server/schema.sql` | Esquema vigente de la base (referencia única) |
