---
name: debugging
description: Úsala SIEMPRE (aunque no lo pidan) cuando aparezca un error, bug o comportamiento inesperado en BotPanel (el bot responde mal, no agenda, no detecta venta, un endpoint falla, la alarma no suena, etc.). Obliga a encontrar la causa raíz y hacer el arreglo mínimo, sin tapar el síntoma.
---

# debugging

Arreglar el síntoma sin entender la causa crea bugs nuevos. Esta skill te obliga a diagnosticar antes de tocar.

## Cuándo se activa
- Cualquier error, excepción, stack trace o "no funciona".
- Comportamiento inesperado del bot (responde raro, no agenda, deriva cuando no debe, no detecta venta).
- Algo "que antes funcionaba y dejó de funcionar".

## Flujo de debugging

### 1. Reproduce ANTES de tocar
- Consigue los pasos exactos para que el problema ocurra.
- Para el bot: usa el smoke test (`bot.handleMessage(...)` simulando el canal) y observa la salida real.
- Revisa el log del servidor (`/tmp/botpanel.log` u la consola): busca `❌`, `🛑`, stacks.

### 2. Lee el error completo
- El stack entero, no solo la primera línea. El archivo + línea reales.
- Para errores de API externas (IA, YCloud): mira `e.response?.data` (ahí está el mensaje real: 401/404/429, etc.).

### 3. Localiza la CAUSA RAÍZ, no el síntoma
Preguntas guía según zona:
- **Bot responde mal / no detecta etiqueta:** ¿el prompt incluye la instrucción? ¿la etiqueta se está detectando y removiendo en `processMessage`? ¿el provider/modelo es el correcto?
- **No agenda / no guarda:** ¿la columna existe en la BD? (recuerda: los .sql están desactualizados). ¿el insert devolvió `error`? Revisa el objeto de respuesta de Supabase.
- **Un negocio ve datos de otro:** falta filtro `business_id` → es **arquitecto-saas** + incidente.
- **Endpoint falla:** ¿faltó auth? ¿el body llega como se espera? ¿un campo no existe en la tabla y rompe el update entero (patrón conocido)?
- **Alarma/realtime no actualiza:** el frontend usa polling; revisa el estado en BD (`conversation_sessions.unread_owner`, `bookings.status`).

### 4. Arreglo MÍNIMO
- Cambia solo lo necesario para corregir la causa. No reescribas de más (ver **cambios-seguros**).
- Si el bug revela una clase de problema (ej: updates que fallan en silencio por columnas inválidas), corrige también la detección/reporte del error, no solo el caso puntual.

### 5. Verifica que el fix no rompió otra cosa
- Re-corre el smoke test del flujo afectado (**tester-saas**).
- Prueba el caso que fallaba **y** un caso vecino que sí funcionaba.

## Reglas inquebrantables
- **No silencies errores.** Nada de `catch(e){}` vacío para "que no truene". Si atrapas, logea (`console.error`) y maneja.
- **No ocultes el problema** con un workaround que esconda la causa (ej: un `try` que se traga un fallo de guardado).
- **No bajes validaciones ni filtros** para que "deje de fallar".
- Si el fix requiere tocar BD/RLS/auth → pasa por **arquitecto-saas** / **base-de-datos** / **seguridad-saas**.

## Patrón ya visto en este proyecto
- **Update que falla en silencio:** enviar a Supabase un campo que no es columna (ej: `monthly_rate` cuando no existía) hace fallar TODO el update, pero el endpoint respondía `ok`. Lección: revisa el `error` que devuelve Supabase y reporta; filtra el payload a columnas válidas.

> El objetivo no es que "deje de dar error" — es que el comportamiento sea correcto y entiendas por qué lo era y por qué ahora lo es.
