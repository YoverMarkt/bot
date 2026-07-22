# Deploy de Vezzper (BotPanel) en Railway — Checklist

Guía para poner el servidor 24/7 en Railway con dominio propio (`vezzper.com`).
El servidor es un monolito Node + Express que sirve el bot, la API y los dos
paneles (admin y cliente) desde un solo proceso.

---

## 0. Prerrequisitos

- [ ] Cuenta en [railway.app](https://railway.app) (el plan Hobby ~$5/mes sirve para empezar).
- [ ] Repo `YoverMarkt/bot` conectado a Railway (deploy desde GitHub).
- [ ] Dominio `vezzper.com` comprado (para apuntarlo al final).
- [ ] Los mismos valores que hoy tienes en `server/.env` (Supabase, JWT, admin, etc.).

---

## 1. Configuración del servicio en Railway

| Ajuste | Valor |
|---|---|
| **Root Directory** | `/` (raíz del repo — es un monorepo con workspaces) |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `node server/dist/index.js` |
| **Node version** | ≥ 22 (ya declarado en `engines`; Railway lo respeta) |
| **PORT** | Railway lo inyecta solo; el server ya lee `process.env.PORT` |

> `npm run build` compila el servidor TypeScript **y** los dos paneles (admin +
> cliente). El start corre el resultado ya compilado, sin volver a compilar.

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
- [ ] `BASE_URL` — la URL pública final, ej. `https://vezzper.com`. **Debe ser HTTPS.**
      (Al inicio puedes usar la URL que Railway te da, ej. `https://vezzper-production.up.railway.app`, y luego cambiarla al dominio propio.)
- [ ] `NODE_ENV=production`

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
> inválida (JWT corto, BASE_URL sin HTTPS, etc.), no abre el puerto y lo dice en
> el log. Es a propósito — evita publicar con configuración incompleta.

---

## 3. Pasos del deploy

1. [ ] Crear el proyecto en Railway apuntando al repo `YoverMarkt/bot`.
2. [ ] Poner Build/Start commands de la sección 1.
3. [ ] Cargar TODAS las variables de la sección 2.
4. [ ] Lanzar el primer deploy. Revisar el log: debe decir `🚀 BotPanel corriendo`.
5. [ ] Probar la URL de Railway: `/app-admin` (login), `/privacidad`, `/terminos`.

---

## 4. Apuntar el dominio `vezzper.com`

1. [ ] En Railway → Settings → Networking → **Custom Domain** → agregar `vezzper.com` (y `www.vezzper.com`).
2. [ ] Railway te da un registro **CNAME** (o A/AAAA). Ponerlo en el DNS de tu dominio (donde lo compraste).
3. [ ] Esperar la propagación (minutos a un par de horas). Railway emite el certificado HTTPS solo.
4. [ ] Cambiar `BASE_URL` a `https://vezzper.com` y redeploy.
5. [ ] Verificar: `https://vezzper.com/privacidad` y `https://vezzper.com/terminos` cargan.

---

## 5. Conectar el webhook de WhatsApp (YCloud)

Una vez con `BASE_URL` en producción:
1. [ ] En YCloud, apuntar el webhook a `https://vezzper.com/webhook`.
2. [ ] Configurar el `endpoint ID` + `signing secret` (por negocio en el panel, o como variables globales).
3. [ ] Hacer una prueba real enviando un mensaje al número conectado.

---

## 6. Qué necesito de ti para ejecutar el deploy

Cuando me des acceso, para hacerlo yo necesito:
- Acceso al proyecto de Railway (o un token de Railway / que me invites).
- Los valores de las variables de la sección 2 (los secretos actuales de tu `.env`). **Nunca los pegues en un chat público**; pásalos por el panel de Railway directamente o por un medio seguro.
- Confirmar el DNS del dominio (lo configuras tú donde compraste `vezzper.com`).

---

## Notas

- Las **páginas legales** (`/privacidad`, `/terminos`) ya quedan servidas por el
  servidor, así que apenas esté en `vezzper.com` estarán en
  `https://vezzper.com/privacidad` y `https://vezzper.com/terminos` — listas para Meta.
- El **túnel Cloudflare** era solo para desarrollo local; en Railway no se usa
  (la URL pública sale de `BASE_URL`).
