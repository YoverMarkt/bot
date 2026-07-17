# 🤖 BotPanel SaaS

Plataforma **multi-empresa (SaaS)** para crear y gestionar bots de atención al cliente con IA en **WhatsApp y Telegram**. Cada negocio tiene su propio bot personalizado (prompt, catálogo, horarios), su panel de control, y un panel de administración central para gestionar todos los clientes y cobros.

---

## ✨ ¿Qué hace?

- **El admin** (tú) crea empresas/clientes, cada uno con su número de WhatsApp y su bot
- Al crear una empresa, el tipo recomienda dos capacidades independientes: agenda pendiente de confirmación y pedidos con total oficial. El admin puede ajustar ambas sin que el tipo las imponga
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
- **React + Vite + TypeScript + Tailwind + shadcn/ui** — paneles Admin y Cliente
- **TanStack Query** para datos y actualización por *polling* controlado

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
| 📅 Citas | Agenda de capacidad única con solicitudes pendientes de confirmación |
| 🏨 Hospedaje | Habitaciones, noches, cupos, tarifas, fotos/videos y hold transaccional; el equipo autorizado confirma |
| 💵 Pedidos y cobro manual | Totales oficiales; el dueño confirma y coordina el pago directamente con el cliente |
| ℹ️ Modo informativo | Responde precios, stock, catálogo y multimedia; deriva la intención de comprar sin crear pedidos ni pagos |
| 🙋 Traspaso a humano | Modo manual + alarma por groserías, off-topic o ventas |
| 🔔 Alarmas | Aviso sonoro y notificación al dueño cuando hay que atender |
| 💳 Facturación | Cobros mensuales automáticos por plan/monto |
| 🧮 Calculadora | Estima costos y precio sugerido por cliente |
| ⌨️ Humanización | Pausa natural + indicador "escribiendo…" |

---

## 📁 Estructura

```
bot/
├── server/                 # Backend Express + TypeScript
│   ├── src/index.ts        # Composición y arranque
│   ├── src/routes/         # Endpoints y webhooks tipados
│   ├── src/services/       # Bot, IA, reportes y lógica de negocio
│   ├── src/integrations/   # WhatsApp, Telegram, Retell y Cloudinary
│   ├── src/db/             # Cliente y repositorios Supabase
│   ├── dist/               # Runtime compilado (generado por npm run build)
│   └── .env                # Credenciales (NO subir a git)
├── apps/admin/             # Panel de administración React + TypeScript
├── apps/client/            # Panel del cliente React + TypeScript
├── packages/ui/            # Sistema de componentes shadcn/ui compartido
└── README.md
```

---

## ⚙️ Instalación (desarrollo local)

```bash
# 1. Instalar dependencias del monorepo
npm install

# 2. Configurar credenciales en server/.env (ver más abajo)

# 3. Compilar paneles e iniciar
npm run build
npm start
```

Para esta versión, ejecuta una vez en Supabase SQL Editor:

```text
server/migration-atomicidad-reservas.sql
server/migration-hospedaje.sql
server/migration-preparacion-produccion.sql
```

La primera serializa las citas e impide intervalos activos solapados. La segunda agrega hospedaje: inventario, tarifas, bloqueos, cotizaciones y retenciones pendientes. La última retira la infraestructura antigua de cobros automáticos, completa el ciclo manual de pedidos y garantiza horarios iniciales.

- Admin:   `http://localhost:3000/app-admin`
- Cliente: `http://localhost:3000/app`

En local arranca un **túnel Cloudflare** para que WhatsApp pueda enviar mensajes a tu máquina. Instala previamente `cloudflared` (`brew install cloudflared` en macOS).

### Verificación automática

```bash
npm run check             # lint, tipos y Vitest
npm run build             # servidor TypeScript + ambos paneles
npm run test:e2e:install  # solo la primera vez
npm run test:e2e          # Playwright: login, permisos, navegación y móvil
```

---

## 🌐 Despliegue a producción

En producción **NO se usa el túnel** — se usa un dominio fijo.

1. Usa Node.js 22+ y crea una cuenta en **Railway**
2. Conecta este repositorio
3. Configura las **variables de entorno** de `server/.env.example`, incluido `NODE_ENV=production`
4. **Importante:** define `BASE_URL=https://tu-dominio.up.railway.app`
   - Esto **desactiva el túnel** y hace que Telegram use webhook
5. En YCloud, apunta el webhook a `https://tu-dominio/webhook/ycloud?secret=<WEBHOOK_SECRET>` usando un secreto aleatorio de 32+ caracteres

> El código detecta `BASE_URL`: si existe → modo producción (dominio fijo, sin túnel). Si no → modo local (túnel automático).

**Infraestructura necesaria para producción:** **Railway** (hosting) y Supabase; no necesitas Cloudflare.

---

## 🔐 Variables de entorno (`server/.env`)

```bash
# Base de datos
SUPABASE_URL="https://xxxx.supabase.co"
SUPABASE_KEY="sb_publishable_..."          # anon (pública)
SUPABASE_SERVICE_KEY="eyJ..."              # secret (backend, bypassa RLS)

# Seguridad
JWT_SECRET="frase-aleatoria-de-32-o-mas-caracteres"
ADMIN_EMAIL="tu@correo.com"
ADMIN_PASSWORD="contraseña-de-12-o-mas-caracteres"

# IA (también se pueden guardar desde el panel — esto es solo respaldo)
GROQ_API_KEY=""
OPENAI_API_KEY=""
GEMINI_API_KEY=""
ANTHROPIC_API_KEY=""

# Telegram (bot de pruebas compartido)
TELEGRAM_BOT_TOKEN=""
TELEGRAM_WEBHOOK_SECRET=""

# Producción (deja vacío en local)
BASE_URL=""
NODE_ENV=""
WEBHOOK_SECRET=""
PORT=3000
```

> 💡 Las API keys de IA y las credenciales de WhatsApp se administran desde los paneles. Los cobros al cliente se coordinan manualmente fuera de la plataforma.

---

## 🔒 Seguridad

- **RLS (Row Level Security)** activo en todas las tablas — el backend usa la *service key*
- Contraseñas con **bcrypt**
- **Rate limiting** en login y webhooks
- Firma HMAC obligatoria para Meta, secreto para YCloud/Kapso y cabecera secreta oficial de Telegram en producción
- El servidor falla antes de abrir el puerto si la configuración crítica es insegura o incompleta
- Componentes React sin inyección de HTML y secretos enmascarados en las APIs administrativas
- Ventas manuales y pedidos toman precios del catálogo del negocio; el navegador y la IA no deciden montos
- El dueño coordina el cobro directamente fuera de la plataforma

---

## 💰 Modelo de negocio

Cobras una **mensualidad por empresa** según su volumen. Con IA gratis (Groq) y WhatsApp de servicio (gratis), tus costos son mínimos (~$10-30/mes para 1000 clientes), permitiendo márgenes altos. La **calculadora integrada** en el panel admin te ayuda a cotizar cada cliente.

---

## 📞 Roadmap

- ✅ WhatsApp + Telegram con texto, voz e imágenes
- ✅ Reservas, facturación, multi-IA (Groq/Gemini/OpenAI/Claude)
- 🔜 Integración financiera futura, solo cuando el producto base esté estable
- 🔜 Voz telefónica (Retell / Vapi / Twilio)
- 🔜 RAG con embeddings gratis (Gemini/Groq)

---

*Construido con Node.js, Supabase e IA multi-proveedor.*
