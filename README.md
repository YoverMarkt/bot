# BotPanel SaaS

Panel de administración para gestionar bots de WhatsApp con IA (Claude) por cliente. Cada negocio tiene su propio bot personalizado, panel de control y base de conocimientos.

## ¿Qué hace?

- **Admin** crea clientes (negocios), cada uno con su número de WhatsApp y bot propio
- **El bot** responde mensajes de WhatsApp automáticamente usando Claude (Anthropic)
- **El cliente** configura el nombre, personalidad e instrucciones de su bot desde su panel
- El admin puede suspender o reactivar clientes con un clic

## Stack

- **Backend:** Node.js + Express
- **Base de datos:** Supabase (PostgreSQL)
- **IA:** Claude (Anthropic API)
- **WhatsApp:** Kapso
- **Deploy:** Railway

## Estructura

```
botpanel/
├── server/
│   ├── index.js       ← servidor principal
│   ├── bot.js         ← agente Claude + Kapso
│   ├── db.js          ← base de datos Supabase
│   ├── schema.sql     ← ejecutar en Supabase (una vez)
│   └── .env           ← credenciales (no subir al repo)
├── admin/
│   └── index.html     ← panel del administrador
└── client/
    └── index.html     ← panel del cliente
```

## Instalación

Ver [PASOS-INSTALACION.md](PASOS-INSTALACION.md) para la guía completa paso a paso.

Ver [CREDENCIALES-DONDE-CONSEGUIRLAS.md](CREDENCIALES-DONDE-CONSEGUIRLAS.md) para obtener las API keys necesarias.

## Variables de entorno

```env
SUPABASE_URL=
SUPABASE_KEY=
JWT_SECRET=
ADMIN_EMAIL=
ADMIN_PASSWORD=
ANTHROPIC_API_KEY=
KAPSO_API_KEY=
PORT=3000
```

## Correr en local

```bash
cd server
npm install
npm run dev
```

Accesos:
- Admin: `http://localhost:3000/admin`
- Cliente: `http://localhost:3000/client`
- Webhook: `http://localhost:3000/webhook`
