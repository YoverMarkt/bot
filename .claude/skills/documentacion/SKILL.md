---
name: documentacion
description: Úsala SIEMPRE (aunque no lo pidan) al crear features, endpoints o etiquetas/tools nuevas del bot, o al cambiar comportamiento que otros consumen, en BotPanel. Un cambio no está terminado hasta que su documentación está al día. Evita variables y comportamientos "fantasma" sin documentar.
---

# documentacion

En un proyecto que crece, lo no documentado se vuelve invisible y se rompe. Esta skill mantiene la documentación viva.

## Cuándo se activa
- Crear un feature, endpoint o etiqueta/tool del bot nueva.
- Cambiar el comportamiento de algo que el frontend, otro módulo o el dueño del negocio consumen.
- Agregar una variable de entorno o una clave de configuración.
- Crear/modificar una tabla o columna (junto con **base-de-datos**).

## Qué mantener actualizado

### 1. README.md
- Si cambia el stack, un flujo importante, los pasos de despliegue o las funcionalidades → actualízalo.
- Mantén la tabla de funcionalidades y el roadmap al día.

### 2. CLAUDE.md
- **Etiqueta/tool nueva del bot** → agrégala a la lista de §7 (convenciones) y al MAPA si cambia el flujo.
- **Regla nueva o invariante** → §4.
- **Comando nuevo** → §6 (solo si existe de verdad en package.json).

### 3. Variables de entorno → `server/.env.example` (sin valores reales)
- `server/.env.example` YA existe y documenta todas las variables. Si agregas una nueva variable de entorno, **agrégala ahí** con la clave y un comentario, nunca con el valor real.
```bash
# Ejemplo de entrada en .env.example
NUEVA_VARIABLE=   # para qué sirve, de dónde se saca
```
- Recuerda: las keys de IA y de WhatsApp por cliente van en BD (panel), no en `.env`. Documenta dónde vive cada credencial.

### 4. Etiquetas/tools del bot
- Documenta: nombre exacto (`##NOMBRE##` o `##NOMBRE:datos##`), cuándo la emite el bot, qué hace el servidor al detectarla, y que opera sobre el `business_id` de la conversación.
- Etiquetas actuales a mantener documentadas: `##BOOK:nombre|YYYY-MM-DD|HH:MM|servicio##`, `##BOOKING##`, `##HANDOFF##`, `##VENTA##`/`##PEDIDO##`, `##IMG##`, `##CATALOG##`.

### 5. Decisiones de arquitectura importantes
- Si tomas una decisión que cambia cómo funciona el sistema (ej: "el RAG usa embeddings de OpenAI por compatibilidad de dimensión", "el frontend usa polling porque RLS bloquea el realtime con anon key"), déjala registrada en el README o en un comentario claro en el código.

## Reglas
- **Un cambio no está terminado hasta que su doc está al día.** Inclúyelo en el mismo cambio.
- **Nunca pongas valores reales de secretos** en documentación o ejemplos.
- Documenta en **español**, claro y accionable (sin relleno).
- Si cambiaste comportamiento que el dueño del negocio ve (panel/bot), explícalo en términos de usuario, no solo técnicos.

> La pregunta al cerrar: "¿alguien que lea la doc dentro de 3 meses entendería este cambio sin leer el código?"
