# Dónde conseguir cada credencial

---

## SUPABASE_URL y SUPABASE_KEY
1. supabase.com → New project
2. Settings → API:
   - "Project URL"  → SUPABASE_URL
   - "anon public"  → SUPABASE_KEY

---

## JWT_SECRET
Lo inventas tú (mínimo 32 caracteres).
Ejemplo: `botpanel2024_mi_clave_secreta_abc123xyz`

---

## ADMIN_EMAIL y ADMIN_PASSWORD
Tus credenciales para entrar a /admin. Los inventas tú.

---

## ANTHROPIC_API_KEY
1. console.anthropic.com → API Keys → Create Key
2. Empieza con `sk-ant-api03-...`

---

## YCLOUD_API_KEY (proveedor principal WhatsApp)
YCloud es partner oficial de Meta — más fácil que Meta directo.

1. Crea cuenta en **ycloud.com**
2. Dashboard → Settings → API Keys → Create API Key
3. Copia la key (empieza con `yc_live_...`)
4. En el dashboard también registra tu número de WhatsApp Business
5. Configura el Webhook URL en YCloud → Webhook → Add Endpoint:
   - URL: `https://TU_DOMINIO/webhook/ycloud`
   - Eventos: `whatsapp.inbound_message.received`

**Por negocio en el admin (campos YCloud):**
- `YCloud API Key`: la misma key o una por workspace
- `YCloud Phone Number`: el número de WhatsApp del negocio (ej: `+593991234567`)

---

## KAPSO_API_KEY (si el cliente usa Kapso)
1. kapso.ai → tu proyecto → API Keys
2. Copia la key (empieza con `kap_live_...`)
3. En el admin, selecciona proveedor **Kapso** y llena el **Number ID** del negocio
4. Webhook URL para Kapso: `/webhook/kapso`

---

## META_TOKEN, META_PHONE_ID, META_VERIFY_TOKEN (opcional)
Solo si algún cliente tiene Meta Business directo.

1. developers.facebook.com → tu App → WhatsApp → API Setup
2. Webhook URL: `https://TU_DOMINIO/webhook`

---

## TELEGRAM_BOT_TOKEN (para pruebas)
1. Abre Telegram y escribe a **@BotFather**
2. Envía `/newbot`
3. Elige nombre y username para el bot
4. BotFather te da el token: `1234567890:ABCxxxxxxxxxxxxxxxxx`
5. Pégalo en el .env como `TELEGRAM_BOT_TOKEN`

**Cómo usar para pruebas:**
- El bot arranca automáticamente con el servidor
- Escríbele a tu bot en Telegram
- Envía `/start` para ver la lista de negocios
- Envía `/start [slug-del-negocio]` para conectarte a uno específico
- El bot responde con la misma IA que WhatsApp

---

## RETELL_API_KEY (voz con IA)
Retell permite que tu bot responda **llamadas telefónicas** con voz.

1. Crea cuenta en **retell.ai**
2. Dashboard → API Keys → copia la key
3. Crea un agente:
   - Nombre: BotPanel
   - LLM: **Custom LLM**
   - LLM URL: `https://TU_DOMINIO/api/retell/llm`
4. Compra un número de teléfono en Retell y asígnalo al agente
5. El sistema ya procesa las llamadas con Claude usando los datos de tu negocio

---

## CAL.COM (reservas / citas)
Cal.com permite que el bot envíe **enlaces de reserva** al cliente.

1. Crea cuenta en **cal.com**
2. Crea un "Event Type" (ej: "Consulta — 30 minutos")
3. Tu enlace de reserva quedará así: `https://cal.com/tu-usuario/consulta`
4. En el admin, al crear/editar un negocio, pega ese enlace en el campo **Cal.com**
5. El bot detecta automáticamente si el cliente quiere agendar y envía el enlace

**Negocios que activan el calendario automáticamente:**
Barbería, peluquería, spa, clínica, consultorio, odontología, psicología, gym, restaurante (con reserva)

**Negocios sin calendario:** Perfumería, tienda de ropa, farmacia, etc.

---

## Resumen de webhooks por proveedor

| Proveedor | URL del webhook |
|-----------|----------------|
| YCloud    | `/webhook/ycloud` |
| Meta      | `/webhook` |
| Telegram  | Automático (polling) |
| Retell AI | `/api/retell/llm` |

---

## Ejemplo de .env completo

```
SUPABASE_URL=https://abcdefghij.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxx
JWT_SECRET=botpanel2024_secreto_muy_largo_abc123xyz
ADMIN_EMAIL=genesis@mibotpanel.com
ADMIN_PASSWORD=MiPassword2024Seguro
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxx
YCLOUD_API_KEY=yc_live_xxxxxxxxxxxxxxxxx
YCLOUD_VERIFY_TOKEN=botpanel_ycloud_2024
META_TOKEN=
META_PHONE_ID=
META_VERIFY_TOKEN=
TELEGRAM_BOT_TOKEN=1234567890:ABCxxxxxxxxxxxxxxxxx
RETELL_API_KEY=
PORT=3000
```
