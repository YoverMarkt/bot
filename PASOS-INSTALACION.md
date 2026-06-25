# BOTPANEL SAAS — Pasos de instalación

## Estructura del proyecto
```
botpanel/
├── server/
│   ├── index.js       ← servidor principal
│   ├── bot.js         ← agente Claude + Kapso
│   ├── db.js          ← base de datos Supabase
│   ├── schema.sql     ← ejecutar en Supabase (una vez)
│   ├── .env           ← TUS CREDENCIALES (llenar antes de correr)
│   └── package.json
├── admin/
│   └── index.html     ← tu panel → localhost:3000/admin
└── client/
    └── index.html     ← panel del cliente → localhost:3000/client
```

---

## PASO 1 — Supabase (base de datos)

1. Ve a supabase.com → crea cuenta → crea proyecto
2. Espera ~2 minutos que inicie
3. Ve a Settings → API → copia:
   - Project URL  → va en SUPABASE_URL del .env
   - anon public  → va en SUPABASE_KEY del .env
4. Ve a SQL Editor → New query → pega TODO el contenido
   de schema.sql → clic en RUN
5. Debe decir "Success"

---

## PASO 2 — Anthropic (Claude API)

1. Ve a console.anthropic.com → crea cuenta
2. API Keys → Create Key → copia la key
3. Va en ANTHROPIC_API_KEY del .env

---

## PASO 3 — Kapso (WhatsApp)

1. Ve a kapso.ai → crea cuenta
2. Crea un proyecto
3. Conecta tu número (o usa el sandbox para pruebas)
4. Ve a API Keys → copia tu API Key
   → va en KAPSO_API_KEY del .env
5. El Number ID de tu número (ej: 597907523413541)
   → va en kapso_number_id cuando crees un cliente

---

## PASO 4 — Llenar el .env

Abre server/.env y llena TODOS los campos:

```
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_KEY=eyJhbGci...
JWT_SECRET=escribe_cualquier_frase_larga_minimo_32_caracteres
ADMIN_EMAIL=tu@email.com
ADMIN_PASSWORD=tuPasswordSeguro
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxx
KAPSO_API_KEY=kap_live_xxxxxxxxx
PORT=3000
```

---

## PASO 5 — Instalar y correr

```bash
cd server
npm install
npm run dev
```

Debes ver:
```
🚀 BotPanel corriendo en http://localhost:3000
👑 Admin:   http://localhost:3000/admin
👤 Cliente: http://localhost:3000/client
📡 Webhook: http://localhost:3000/webhook
```

---

## PASO 6 — Ngrok (para pruebas locales con Kapso)

En una segunda terminal:
```bash
ngrok http 3000
```
Copia la URL: https://xxxx.ngrok-free.app

En Kapso → tu número → Webhook URL:
https://xxxx.ngrok-free.app/webhook

---

## PASO 7 — Entrar al panel admin

Abre: http://localhost:3000/admin

Email:    el que pusiste en ADMIN_EMAIL
Password: el que pusiste en ADMIN_PASSWORD

---

## PASO 8 — Crear tu primer cliente

En el panel admin → Nuevo cliente:
- Nombre del negocio
- Número WhatsApp del negocio
- Kapso Number ID (el ID del número en Kapso)
- Email y password para el cliente

El cliente entra en: http://localhost:3000/client

---

## Cuando un cliente no paga

Admin → Clientes → Suspender → escribe el motivo

El bot automáticamente responde a sus clientes:
"Este servicio tiene un pago pendiente..."

Para reactivar: Admin → Clientes → Reactivar
