# 🤖 BotPanel SaaS

Plataforma **multi-empresa (SaaS)** para crear y gestionar bots de atención al cliente con IA en **WhatsApp y Telegram**. Cada negocio tiene su propio bot personalizado (prompt, catálogo, horarios), su panel de control, y un panel de administración central para gestionar todos los clientes y cobros.

---

## ✨ ¿Qué hace?

- **El admin** (tú) crea empresas/clientes, cada uno con su número de WhatsApp y su bot
- **El bot** atiende clientes 24/7 con IA: responde dudas, vende, agenda citas, reconoce fotos y entiende audios
- **El dueño del negocio** configura desde su panel: la personalidad del bot (prompt), su catálogo, horarios y ve sus conversaciones
- **Traspaso a humano** automático cuando hay groserías, temas fuera del negocio o se concreta una venta
- **Facturación** automática por plan y monto de cada cliente

---

## 🧱 Stack tecnológico

### Backend
- **Node.js + Express** — servidor y API REST
- **Supabase (PostgreSQL)** — base de datos
- **pgvector** — búsqueda semántica (RAG) para catálogos grandes
- **JWT** — autenticación (admin y clientes)
- **bcrypt** — encriptación de contraseñas
- **express-rate-limit** — protección anti abuso

### Inteligencia Artificial (multi-proveedor, intercambiable desde el panel)
- **Groq (Llama)** — chat, audio y visión · *gratis* ⭐
- **Google Gemini** — chat, audio y visión · *gratis*
- **OpenAI** — GPT-4o-mini, Whisper, embeddings, visión
- **Anthropic Claude** — chat y visión

### Mensajería
- **WhatsApp** — YCloud, Meta (Graph API), Kapso
- **Telegram** — telegraf (polling en local, webhook en producción)
- **Retell** — voz telefónica (preparado, opcional)

### Frontend
- **HTML + CSS + JavaScript puro** (sin framework) — paneles Admin y Cliente
- Actualización en tiempo real por *polling*

### Infraestructura
- **Railway / Render** — despliegue en producción (dominio fijo)
- **Cloudflare Tunnel** — URL pública **solo para desarrollo local**

---

## 🚀 Funcionalidades

| Función | Descripción |
|---------|-------------|
| 💬 Chat IA | Responde con la personalidad/prompt de cada negocio |
| 📸 Visión | Reconoce productos desde una foto y los busca en el catálogo |
| 🎙️ Audio | Transcribe notas de voz y las procesa como texto |
| 🔎 RAG vectorial | Búsqueda inteligente en catálogos de miles de productos |
| 📅 Reservas | Sistema de citas con calendario y confirmación |
| 🙋 Traspaso a humano | Modo manual + alarma por groserías, off-topic o ventas |
| 🔔 Alarmas | Aviso sonoro y notificación al dueño cuando hay que atender |
| 💳 Facturación | Cobros mensuales automáticos por plan/monto |
| 🧮 Calculadora | Estima costos y precio sugerido por cliente |
| ⌨️ Humanización | Pausa natural + indicador "escribiendo…" |

---

## 📁 Estructura

```
bot/
├── server/                 # Backend (Node.js + Express)
│   ├── index.js            # Servidor, rutas API, webhooks
│   ├── bot.js              # Lógica del bot, IA, visión, audio, RAG
│   ├── db.js               # Acceso a Supabase
│   ├── settings.js         # Config de keys (panel > .env)
│   ├── telegram.js         # Integración Telegram
│   ├── ycloud.js           # Integración WhatsApp YCloud
│   ├── retell.js           # Voz telefónica (Retell)
│   ├── tunnel.js           # Túnel Cloudflare (solo local)
│   └── .env                # Credenciales (NO subir a git)
├── admin/                  # Panel de administración (tú)
├── client/                 # Panel del cliente (dueño del negocio)
└── README.md
```

---

## ⚙️ Instalación (desarrollo local)

```bash
# 1. Instalar dependencias
cd server
npm install

# 2. Configurar credenciales en server/.env (ver más abajo)

# 3. Iniciar
node index.js
```

- Admin:   `http://localhost:3000/admin`
- Cliente: `http://localhost:3000/client`

En local arranca solo un **túnel Cloudflare** para que WhatsApp pueda enviar mensajes a tu máquina.

---

## 🌐 Despliegue a producción

En producción **NO se usa el túnel** — se usa un dominio fijo.

1. Crea cuenta en **Railway** (o Render)
2. Conecta este repositorio
3. Configura las **variables de entorno** (las mismas del `.env`)
4. **Importante:** define `BASE_URL=https://tu-dominio.up.railway.app`
   - Esto **desactiva el túnel** y hace que Telegram use webhook
5. En YCloud, apunta el webhook a `https://tu-dominio/webhook/ycloud` (fijo, nunca cambia)

> El código detecta `BASE_URL`: si existe → modo producción (dominio fijo, sin túnel). Si no → modo local (túnel automático).

**Cuentas necesarias para producción:** solo **Railway** (hosting). NO necesitas Cloudflare.

---

## 🔐 Variables de entorno (`server/.env`)

```bash
# Base de datos
SUPABASE_URL="https://xxxx.supabase.co"
SUPABASE_KEY="sb_publishable_..."          # anon (pública)
SUPABASE_SERVICE_KEY="eyJ..."              # secret (backend, bypassa RLS)

# Seguridad
JWT_SECRET="frase-larga-secreta"
ADMIN_EMAIL="tu@correo.com"
ADMIN_PASSWORD="tu-contraseña"

# IA (también se pueden guardar desde el panel — esto es solo respaldo)
GROQ_API_KEY=""
OPENAI_API_KEY=""
GEMINI_API_KEY=""
ANTHROPIC_API_KEY=""

# Telegram (bot de pruebas compartido)
TELEGRAM_BOT_TOKEN=""

# Producción (deja vacío en local)
BASE_URL=""
PORT=3000
```

> 💡 Las API keys de IA y de cada cliente (WhatsApp) se administran **desde el panel** y se guardan en la base de datos. El `.env` es solo respaldo.

---

## 🔒 Seguridad

- **RLS (Row Level Security)** activo en todas las tablas — el backend usa la *service key*
- Contraseñas con **bcrypt**
- **Rate limiting** en login y webhooks
- Firma HMAC opcional para webhooks de Meta
- Escape de HTML en el panel (anti-XSS)

---

## 💰 Modelo de negocio

Cobras una **mensualidad por empresa** según su volumen. Con IA gratis (Groq) y WhatsApp de servicio (gratis), tus costos son mínimos (~$10-30/mes para 1000 clientes), permitiendo márgenes altos. La **calculadora integrada** en el panel admin te ayuda a cotizar cada cliente.

---

## 📞 Roadmap

- ✅ WhatsApp + Telegram con texto, voz e imágenes
- ✅ Reservas, facturación, multi-IA (Groq/Gemini/OpenAI/Claude)
- 🔜 Voz telefónica (Retell / Vapi / Twilio)
- 🔜 RAG con embeddings gratis (Gemini/Groq)

---

*Construido con Node.js, Supabase e IA multi-proveedor.*
