---
name: tester-saas
description: Úsala SIEMPRE después de cualquier cambio de código en BotPanel para verificar que nada se rompió, aunque el usuario no lo pida. Este proyecto NO tiene framework de tests, typecheck ni lint, así que la verificación es manual y obligatoria. Un cambio no está terminado hasta verificarlo.
---

# tester-saas

BotPanel no tiene tests automatizados, ni TypeScript, ni linter, ni CI. Eso hace que verificar a mano sea **obligatorio**: es la única red de seguridad.

## Comandos reales de verificación (los que SÍ existen)

```bash
# 1. ¿Los módulos cargan sin error de sintaxis/require?
cd server
node -e "require('./bot'); require('./db'); require('./index')" 2>&1 | head

# 2. Sintaxis del JS de los paneles (no hay bundler)
node -e "const fs=require('fs');const h=fs.readFileSync('../admin/index.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m,i)=>{try{new Function(m[1])}catch(e){console.log('admin bloque '+i+': '+e.message)}})"

# 3. Arrancar el servidor y ver que no truena
node index.js   # debe imprimir "🚀 BotPanel corriendo..."

# 4. Smoke test de endpoints
curl -s http://localhost:3000/api/health        # {"ok":true,...}
```

> NO existen `npm test`, `npm run lint`, `npm run build` ni `tsc`. No los inventes ni los "corras". Si el usuario quiere CI/tests reales, es una tarea aparte.

## Zonas críticas — verifícalas por prioridad

1. **Aislamiento multi-tenant** (lo más importante): tras tocar `db.js` o rutas, confirma que las consultas siguen filtrando por `business_id` y que el id viene del JWT. Prueba con dos negocios distintos que uno no vea datos del otro.
2. **Etiquetas/tools del bot:** si tocaste `bot.js`, prueba el flujo real con `bot.handleMessage(...)` simulando un mensaje y revisa que `##BOOK## / ##HANDOFF## / ##VENTA##` se detecten y se quiten del texto.
3. **Flujo de venta/checkout:** que `##VENTA##` (o frases de cierre) pasen el chat a manual y disparen la alarma.
4. **Auth / RLS:** que las rutas privilegiadas exijan token; que la anon key no lea datos directo (RLS).

## Patrón de smoke test del bot (sin WhatsApp real)
```js
// node -e "..."  contra un negocio de prueba por Telegram
const bot = require('./bot')
const cap = []
const ctx = { reply: t => { cap.push(t); return Promise.resolve() }, sendChatAction: () => Promise.resolve() }
await bot.handleMessage('tg_test', 'hola', null, { channel:'telegram', ctx, slug:'<slug-negocio>' })
// revisar cap[] y el estado en conversation_sessions / bookings
```

## Si aún no hay tests y el cambio es delicado
- Crea pruebas **empezando por el aislamiento entre negocios** (que el negocio A nunca vea datos del B).
- Luego: detección de etiquetas del bot, y cierre de venta → manual.
- Guárdalas de forma que se puedan re-correr (script en `server/`).

## Reglas
- **No debilites ni borres una verificación/test para que "pase".** Si algo falla, el problema es el código, no la prueba.
- **No marques como terminado sin verificar.** Si no pudiste verificar, dilo explícitamente y explica por qué.
- Si la verificación revela un fallo → ve a **debugging**.

> "Compila" aquí significa: los módulos cargan, el server arranca, y el flujo afectado funciona en un smoke test. Sin eso, no está hecho.
