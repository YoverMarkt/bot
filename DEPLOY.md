# DEPLOY — BotPanel en Railway

Guía para pasar de local (túnel Cloudflare) a producción 24/7 en **Railway** con dominio propio. La base de datos ya está en Supabase (no se toca).

---

## 1. Antes de empezar

- Cuenta en [Railway](https://railway.app) (conecta tu GitHub `YoverMarkt/bot`).
- Un dominio (Namecheap, GoDaddy, Cloudflare, etc.).
- Tener a mano las credenciales de Supabase y del superadmin.

---

## 2. Crear el servicio en Railway

1. **New Project → Deploy from GitHub repo →** elige `YoverMarkt/bot`, rama `main`.
2. **Settings → Root Directory:** deja **vacío** (raíz).
   - El `package.json` de la raíz ya instala las dependencias de `server/` (via `postinstall`) y arranca con `node server/index.js`.
   - *(Alternativa limpia: poner Root Directory = `server` y Railway usará `server/package.json` directo. Cualquiera de las dos funciona.)*
3. Railway detecta Node y usa `npm start`. No necesitas configurar build.

---

## 3. Variables de entorno (Railway → Variables)

**Críticas (sin estas el login/panel NO funciona):**

| Variable | Valor |
|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_KEY` | anon / publishable |
| `SUPABASE_SERVICE_KEY` | service_role (secreta, solo servidor) |
| `JWT_SECRET` | frase larga aleatoria (ver abajo) |
| `ADMIN_EMAIL` | tu correo de superadmin |
| `ADMIN_PASSWORD` | tu contraseña de superadmin |

**Producción (muy recomendadas):**

| Variable | Valor |
|---|---|
| `BASE_URL` | tu dominio final, sin `/` al final (ej. `https://tubot.com`). **Desactiva el túnel local.** |
| `WEBHOOK_SECRET` | secreto para proteger los webhooks (ver §6) |
| `PORT` | **NO la pongas** — Railway la inyecta sola |

**Opcionales:** `META_APP_SECRET` (verifica firma de Meta), `TELEGRAM_BOT_TOKEN`, `GROQ_API_KEY`/`GEMINI_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` (lo normal es cargar las keys de IA desde el panel admin, no aquí).

**Generar un `JWT_SECRET` seguro:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```
> ⚠️ Si cambias `JWT_SECRET` después, todos los usuarios tendrán que volver a iniciar sesión (los tokens viejos dejan de valer).

Al arrancar, en los logs de Railway verás `✅ Variables de entorno críticas: OK` o un `❌ FALTAN…` con lo que falte.

---

## 4. Primer deploy y verificación

1. Railway despliega solo al hacer push a `main`.
2. Abre la URL temporal de Railway (`https://xxx.up.railway.app`):
   - `/` → redirige a `/admin` (login superadmin).
   - `/client` → login de negocios.
3. En los logs debe aparecer `🚀 BotPanel corriendo…` y NO debe intentar túnel (porque `BASE_URL` está puesta).

---

## 5. Dominio propio

1. Compra el dominio.
2. Railway → tu servicio → **Settings → Networking → Custom Domain →** agrega `tubot.com` (o `app.tubot.com`).
3. Railway te da un registro **CNAME**; ponlo en el DNS de tu proveedor.
4. Espera la propagación (minutos a horas). Railway emite el HTTPS solo.
5. Actualiza la variable `BASE_URL` a tu dominio final y **redeploy**.

---

## 6. Webhooks (WhatsApp / Meta)

La URL del webhook cambia a tu dominio fijo (ya no cambia en cada reinicio 🎉).

- **YCloud / Kapso:** configura la URL como
  `https://tubot.com/webhook/ycloud?secret=<WEBHOOK_SECRET>`
  (si definiste `WEBHOOK_SECRET`; si no, sin el `?secret=`).
- **Meta:** `https://tubot.com/webhook/meta` + define `META_APP_SECRET` para que se verifique la firma.
- **Telegram:** con `BASE_URL` puesta, el bot usa webhook automático a tu dominio.

> El panel del superadmin (Integraciones) muestra la URL del webhook ya con el `?secret=` incluido.

---

## 7. Checklist final antes de vender

- [ ] Deploy verde en Railway, logs con `✅ Variables… OK`.
- [ ] `/admin` y `/client` cargan por el dominio propio (HTTPS).
- [ ] Login superadmin y login de un negocio funcionan.
- [ ] Webhook de WhatsApp apuntando al dominio (probar un mensaje real).
- [ ] Un negocio de prueba con productos + prompt + horario (usa el **checklist de onboarding** del panel).
- [ ] Números/keys de WhatsApp de cada negocio cargados desde el panel admin.

---

## Notas

- **Supabase** ya es tu base 24/7 (no migra nada al deploy). Solo asegúrate de haber corrido los `.sql` de migración (ya hechos).
- La red de seguridad (`uncaughtException`/`unhandledRejection`) mantiene el server vivo ante errores aislados.
- `trust proxy` está activado para que el rate-limit funcione detrás del proxy de Railway.
