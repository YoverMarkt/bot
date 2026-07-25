# Deploy de Vezzper (BotPanel) en Railway — Checklist

Guía para poner el servidor 24/7 usando primero el dominio temporal HTTPS de
Railway (`*.up.railway.app`). Comprar y conectar `vezzper.com` es un paso
posterior y opcional para estas pruebas. El servidor es un monolito Node +
Express que sirve el bot, la API y los dos paneles desde un solo proceso.

---

## 0. Prerrequisitos

- [ ] Cuenta en [Railway](https://railway.com).
- [ ] Repo `YoverMarkt/bot` conectado a Railway (deploy desde GitHub).
- [ ] Los mismos valores que hoy tienes en `server/.env` (Supabase, JWT, admin, etc.).
- [ ] Opcional más adelante: dominio `vezzper.com` comprado.

---

## 1. Configuración del servicio en Railway

| Ajuste | Valor |
|---|---|
| **Root Directory** | `/` (raíz del repo — es un monorepo con workspaces) |
| **Builder** | Railpack |
| **Build Command** | `npm run build` |
| **Start Command** | `node server/dist/index.js` |
| **Healthcheck Path** | `/api/health` |
| **Node version** | ≥ 22 (ya declarado en `engines`) |
| **PORT** | Railway lo inyecta; no crear esta variable manualmente |

Estos valores ya están versionados en `railway.json`, que es la fuente de
verdad del servicio. Railpack instala las dependencias del monorepo antes de
ejecutar el build; no hace falta anteponer `npm install`.

> `npm run build` compila el servidor TypeScript **y** los dos paneles. El
> start corre el resultado ya compilado, sin volver a compilar.

---

## 2. Variables de entorno

En Railway → pestaña **Variables**. Copiar los valores desde tu `server/.env` actual.

### Obligatorias SIEMPRE (sin ellas el server no arranca)
- [ ] `SUPABASE_URL` — URL del proyecto Supabase.
- [ ] `SUPABASE_SERVICE_KEY` — service role key de Supabase. **Solo en el servidor, jamás en el frontend.**
- [ ] `JWT_SECRET` — secreto para firmar tokens. **Mínimo 32 caracteres.**
- [ ] `ADMIN_EMAIL` — correo del superadmin (login del panel admin).
- [ ] `ADMIN_PASSWORD` — contraseña del superadmin. **Mínimo 12 caracteres.**

### Obligatoria en PRODUCCIÓN
- [ ] `BASE_URL` — el origen público generado en la sección 3, por ejemplo
      `https://vezzper-production.up.railway.app`. Debe ser HTTPS y escribirse
      **sin slash final, ruta, query ni hash**.
- [ ] `NODE_ENV=production`

### Variables que Railway inyecta

Railway crea `PORT`, `RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_NAME` y, tras
generar el dominio, `RAILWAY_PUBLIC_DOMAIN`. No las copies desde `.env` ni las
sobrescribas. Esta aplicación sigue exigiendo `BASE_URL` explícita para que los
webhooks y CORS tengan un único origen canónico.

### Condicionales
- [ ] `TELEGRAM_BOT_TOKEN` — solo si usas Telegram. Si lo pones en producción, **también** exige:
- [ ] `TELEGRAM_WEBHOOK_SECRET` — mínimo 32 caracteres (en producción Telegram usa webhook, no polling).

### WhatsApp por YCloud (recomendado para tu caso)
- [ ] `YCLOUD_WEBHOOK_ENDPOINT_ID` y `YCLOUD_WEBHOOK_SECRET` — van **juntos** (o ambos o ninguno). El secreto mínimo 32 caracteres. Validan la firma del webhook de YCloud.
- [ ] `YCLOUD_API_KEY` — **opcional**. Es solo el *fallback global* para enviar mensajes.

> 🔑 **Importante — las credenciales por negocio NO son variables de entorno.**
> La API key de YCloud se resuelve así: `negocio.ycloud_api_key` (base de datos)
> y, si está vacía, `YCLOUD_API_KEY` (variable global). Lo mismo con el signing
> secret del webhook. Como cada negocio guarda su key **en Supabase** desde el
> panel admin, esas credenciales **viajan solas con la base de datos**: al
> desplegar en Railway no hay que volver a cargarlas. Solo define
> `YCLOUD_API_KEY` si quieres una key global para negocios que no tengan la suya.

### WhatsApp por Meta directo (a futuro, no ahora)
- [ ] `META_VERIFY_TOKEN` — token que tú inventas para validar el webhook con Meta.
- [ ] `META_APP_SECRET` — secreto de tu app de Meta (valida la firma de los webhooks).
- [ ] `META_GRAPH_API_VERSION` — opcional, formato `vNN.0` (ej. `v21.0`).

### Keys de IA (OpenAI, Anthropic, Groq, Gemini)
- No son variables de arranque. Se leen primero de `server_settings` (base de
  datos, se configuran **desde el panel admin → Configuración**) y, como
  fallback, de las variables `OPENAI_API_KEY` y `ANTHROPIC_API_KEY`.
- Como ya están guardadas en Supabase, **también viajan con la base de datos**;
  no hace falta recargarlas en Railway.

> ⚠️ El servidor **falla cerrado**: si falta una variable obligatoria o una es
> inválida (JWT corto, BASE_URL que no sea un origen HTTPS puro, etc.), no abre
> el puerto y lo dice en el log. Es a propósito — evita publicar con
> configuración incompleta.

---

## 3. Pasos del deploy

1. [ ] Crear el proyecto en Railway apuntando al repo `YoverMarkt/bot`. Si
   Railway inicia un deploy automático sin variables, puede fallar; se
   relanzará después de completar estos pasos.
2. [ ] Abrir el servicio → **Settings → Networking → Public Networking** y
   pulsar **Generate Domain**. Railway no crea un dominio público por defecto.
3. [ ] Copiar el origen generado, por ejemplo
   `https://vezzper-production.up.railway.app`, sin el slash final.
4. [ ] Abrir **Variables**, cargar todas las variables de la sección 2 y usar
   ese origen como `BASE_URL`.
5. [ ] Confirmar que Railway detectó `railway.json` y lanzar **Deploy/Redeploy**.
6. [ ] Revisar el log: debe decir `🚀 BotPanel corriendo`.
7. [ ] Confirmar que `/api/health` responde HTTP 200 y probar:
   `/app-admin`, `/app`, `/privacidad` y `/terminos`.

---

## 4. Apuntar `vezzper.com` más adelante (opcional)

1. [ ] En Railway → Settings → Networking → **Custom Domain** → agregar `vezzper.com` (y `www.vezzper.com`).
2. [ ] Copiar exactamente en el proveedor DNS los registros que muestre
   Railway. La configuración actual usa un registro **CNAME** y un registro
   **TXT** de verificación.
3. [ ] Esperar la verificación y emisión automática del certificado HTTPS.
4. [ ] Cambiar `BASE_URL` a `https://vezzper.com` y hacer redeploy.
5. [ ] Actualizar en YCloud/Meta/Telegram las URLs de webhook al dominio nuevo.
6. [ ] Verificar: `https://vezzper.com/privacidad` y `https://vezzper.com/terminos`.

---

## 5. Conectar el webhook de WhatsApp (YCloud)

Una vez con `BASE_URL` en producción:
1. [ ] En YCloud, apuntar el webhook a
   `https://<dominio-activo>/webhook/ycloud`. Durante las pruebas será, por
   ejemplo, `https://vezzper-production.up.railway.app/webhook/ycloud`.
   **No usar `/webhook`**, porque esa ruta corresponde a Meta directo.
2. [ ] Configurar el `endpoint ID` + `signing secret` (por negocio en el panel, o como variables globales).
3. [ ] Hacer una prueba real enviando un mensaje al número conectado.

---

## 6. Qué necesito de ti para ejecutar el deploy

Cuando me des acceso, para hacerlo yo necesito:
- Acceso al proyecto de Railway (o un token de Railway / que me invites).
- Los valores de las variables de la sección 2 (los secretos actuales de tu `.env`). **Nunca los pegues en un chat público**; pásalos por el panel de Railway directamente o por un medio seguro.
- Solo cuando se compre el dominio: acceso o coordinación para configurar sus
  registros DNS.

---

## Notas

- Las **páginas legales** (`/privacidad`, `/terminos`) ya quedan servidas por el
  servidor, así que apenas esté en `vezzper.com` estarán en
  `https://vezzper.com/privacidad` y `https://vezzper.com/terminos` — listas para Meta.
- El **túnel Cloudflare** era solo para desarrollo local; en Railway no se usa
  (la URL pública sale de `BASE_URL`).

## Referencias oficiales

- [Configuración como código (`railway.json`)](https://docs.railway.com/config-as-code/reference)
- [Dominios públicos y personalizados](https://docs.railway.com/networking/domains/working-with-domains)
- [Variables proporcionadas por Railway](https://docs.railway.com/variables/reference)
- [Healthchecks de despliegue](https://docs.railway.com/deployments/healthchecks)
- [Railpack para Node.js](https://railpack.com/languages/node/)
