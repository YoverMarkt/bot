---
name: seguridad-saas
description: Úsala SIEMPRE (aunque no lo pidan) cuando un cambio toque autenticación, manejo de secretos/keys, encriptación, datos sensibles, webhooks o endpoints públicos en BotPanel. Previene fugas de credenciales, accesos sin auth y que un negocio acceda a datos de otro.
---

# seguridad-saas

BotPanel maneja credenciales de WhatsApp, keys de IA y datos de muchos negocios. Un descuido aquí es un incidente, no un bug.

## Cuándo se activa
- Tocar login admin/cliente, JWT, middlewares `authAdmin`/`authClient`.
- Manejar API keys (IA, YCloud, Meta, Kapso) o la service key.
- Webhooks (`/webhook`, `/webhook/ycloud`, `/webhook/kapso`) o endpoints sin auth.
- Devolver datos al frontend o agregar un endpoint público.

## Checklist de seguridad

### Secretos y keys
- [ ] **Nunca** hardcodear una key en código. Usar `process.env` o `settings.get(...)`.
- [ ] **`SUPABASE_SERVICE_KEY` solo en el servidor.** Jamás en `admin/`, `client/`, ni en una respuesta de API. Los endpoints `supabase-config` devuelven `{}` a propósito — no los "arregles" para devolver la key.
- [ ] Las keys de IA/WhatsApp se guardan en BD (`server_settings` / `businesses`), no en el front.
- [ ] Al mostrar keys en el panel, van **enmascaradas** (ya hay `setSrvKeyHint`); no devolver el valor completo.
- [ ] Si una credencial entra a un diff de git → detente y avísalo.

### Autenticación y autorización
- [ ] Toda ruta `/api/admin/*` pasa por `authAdmin`; toda `/api/client/*` por `authClient`.
- [ ] El `business_id` de un cliente sale del JWT (`req.user.businessId`), **nunca** de un param/body manipulable → previene IDOR (que un cliente pida datos de otro cambiando un id).
- [ ] El login admin valida contra `ADMIN_EMAIL`/`ADMIN_PASSWORD` del entorno; el de cliente contra `client_users` con `bcrypt.compare`.
- [ ] Contraseñas siempre con `bcrypt` (nunca texto plano).
- [ ] `JWT_SECRET` fuerte y solo en entorno.

### Webhooks y entradas
- [ ] Validar la forma del payload antes de usarlo (`body?.entry?.[0]?.changes...`).
- [ ] Rate limiting puesto en login y webhooks (`loginLimiter`, `webhookLimiter`) — no quitarlo.
- [ ] Meta: si `META_APP_SECRET` está configurado, se verifica la firma HMAC (`verifyMetaSignature`). No romper esa verificación.
- [ ] YCloud/Kapso: verificación opt-in por secreto en la URL (`verifyWebhookSecret`). Si `WEBHOOK_SECRET` está definido, la URL debe llevar `?secret=<valor>`; si no, no se exige. No romper esa lógica.
- [ ] Escapar HTML al renderizar contenido del cliente en los paneles (usar `esc(...)`) → anti-XSS.

## Señales de alerta (vulnerabilidades comunes)
- **IDOR:** un endpoint usa un `id` del request para buscar datos sin verificar que pertenezca al `business_id` del token.
- **Exposición de datos de otro negocio:** una consulta sin filtro `business_id`.
- **Fuga de secreto:** una key en logs, en una respuesta de API, o en el HTML del panel.
- **Inyección:** concatenar input del usuario en una query. (Aquí se usa el SDK de Supabase, que parametriza — no construir SQL a mano con strings de usuario.)
- **Auth saltada:** una ruta nueva que olvidó su middleware de auth.

## Ante un hallazgo
Señala la vulnerabilidad, su impacto (qué dato/quién se afecta), y propón el arreglo mínimo. Si es grave (fuga de datos entre negocios o de secretos), trátalo como prioritario y avisa al usuario antes de seguir con otra cosa.

> Pregunta clave en cada cambio: "¿esto deja que alguien vea algo que no debería, o expone una credencial?"
