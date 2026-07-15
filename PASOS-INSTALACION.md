# BotPanel SaaS — instalación

## Requisitos

- Node.js 20.19 o superior.
- `cloudflared` para recibir webhooks durante el desarrollo local.
- Un proyecto de Supabase.
- Credenciales del superadmin.
- Al menos un proveedor de IA configurado desde el panel o el entorno.

## 1. Base de datos

Para una base nueva, ejecuta `server/schema.sql` en Supabase → SQL Editor.

Para una base existente, revisa y ejecuta solamente las migraciones pendientes. En particular, `server/migration-seguridad-rls-etiquetas.sql` activa RLS para `conversation_tags`, `server/migration-atomicidad-ventas.sql` instala la RPC transaccional de ventas, `server/migration-atomicidad-onboarding.sql` crea negocio, políticas, usuario dueño y facturación en una única transacción, `server/migration-atomicidad-pedidos.sql` crea pedidos atómicos y `server/migration-deduplicacion-webhooks.sql` instala deduplicación persistente. Hospedaje usa `server/migration-hospedaje.sql`. Ejecuta al final `server/migration-preparacion-produccion.sql` para retirar el antiguo modelo de cobros automáticos, completar el ciclo manual de pedidos y garantizar horarios iniciales. No vuelvas a ejecutar `migration-integraciones.sql`: se conserva únicamente como historial.

## 2. Variables de entorno

```bash
cp server/.env.example server/.env
```

Completa como mínimo:

```dotenv
SUPABASE_URL=
SUPABASE_KEY=
SUPABASE_SERVICE_KEY=
JWT_SECRET=
ADMIN_EMAIL=
ADMIN_PASSWORD=
PORT=3000
```

En producción también son obligatorias `NODE_ENV=production`, `BASE_URL` y un `WEBHOOK_SECRET` de 32+ caracteres. Si usas Meta, configura `META_VERIFY_TOKEN` y `META_APP_SECRET`; para Retell, `RETELL_API_KEY` y `RETELL_LLM_SECRET`; para Telegram, `TELEGRAM_BOT_TOKEN` y `TELEGRAM_WEBHOOK_SECRET`. Las credenciales de WhatsApp de cada negocio se guardan desde sus paneles, nunca en el frontend ni en el repositorio. Los cobros al cliente se coordinan manualmente fuera de la plataforma.

## 3. Instalar, verificar y arrancar

Todo se administra desde la raíz del monorepo:

```bash
npm install
npm run check
npm run build
npm start
```

Direcciones locales:

- Superadmin: `http://localhost:3000/app-admin`
- Negocios: `http://localhost:3000/app`
- Salud: `http://localhost:3000/api/health`

`/admin` y `/client` se conservan como alias que redirigen a las aplicaciones React. Ya no existen paneles legacy.

Para desarrollar un panel con recarga inmediata, deja el servidor corriendo y usa otra terminal:

```bash
npm run dev -w @botpanel/client
# o
npm run dev -w @botpanel/admin
```

## 4. Primer negocio

1. Entra al panel superadmin con `ADMIN_EMAIL` y `ADMIN_PASSWORD`.
2. Crea el negocio y su usuario de acceso.
3. Configura y verifica el proveedor de WhatsApp.
4. Completa catálogo, horarios, prompt y modo de operación.
5. Prueba login, aislamiento de datos y un mensaje real antes de habilitarlo.

## 5. Webhooks locales

Sin `BASE_URL`, el servidor intenta levantar el túnel de desarrollo automáticamente y muestra su URL en consola. Configura esa URL en el proveedor correspondiente. En producción usa siempre el dominio fijo y las firmas o secretos descritos en `DEPLOY.md`.
