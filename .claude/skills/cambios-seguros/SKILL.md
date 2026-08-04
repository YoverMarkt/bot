---
name: cambios-seguros
description: Úsala SIEMPRE (aunque no lo pidan) al modificar algo que ya existe en BotPanel, especialmente si el pedido es amplio, vago o dice "mejora/arregla/optimiza todo esto". Acota el cambio al mínimo y evita romper trabajo que ya funcionaba. Es la skill por defecto ante cualquier edición de código existente.
---

# cambios-seguros

En un proyecto grande y vivo, el mayor riesgo no es no hacer el cambio: es romper de paso algo que ya servía. Esta skill te obliga a un cambio quirúrgico.

## Cuándo se activa
- Cualquier pedido de modificar, ajustar, "mejorar" o "arreglar" código existente.
- Pedidos amplios o ambiguos ("haz que esto funcione mejor", "límpialo", "optimízalo").
- Cuando el módulo TypeScript a tocar concentra lógica crítica del bot, datos o una pantalla React agrupa varias funciones.

## Flujo ANTES de tocar código
1. **Reformula el alcance** en una frase: "Voy a cambiar X. NO voy a tocar Y ni Z." Si no puedes nombrar qué NO tocas, todavía no entendiste el pedido → pregunta.
2. **Punto limpio en Git** — confirma con `git status` que no hay cambios sin guardar mezclados; si los hay, sepáralos o coméntalo.
3. **Localiza los archivos mínimos.** En este proyecto, casi siempre:
   - Datos → `server/src/db/`
   - Lógica del bot / IA / etiquetas → `server/src/services/`
   - Rutas / endpoints / webhooks → `server/src/routes/`
   - Arranque / montaje → `server/src/index.ts`
   - UI admin → `apps/admin/src/` · UI cliente → `apps/client/src/`
   - Componentes compartidos → `packages/ui/` cuando exista; no duplicarlos entre apps
4. **Edición quirúrgica** — cambia solo las líneas necesarias. No reordenes, no "embellezcas", no renombres de paso.

## Señales de que estás por romper algo (DETENTE)
- Vas a **reescribir un archivo entero** por un cambio de pocas líneas.
- Vas a **borrar código "que parece no usarse"** — puede usarse desde otro archivo, un webhook o el frontend. Confírmalo con `grep` antes; si hay duda, NO lo borres.
- Vas a **renombrar algo en muchos archivos** (función, campo, endpoint) — alto riesgo de dejar referencias rotas.
- Vas a **cambiar una firma de función** que se llama en varios lados.
- Vas a tocar una **validación, un filtro `business_id` o una verificación de auth** "para simplificar".

Si aparece alguna señal: reduce el alcance, o pregunta antes de seguir.

## Reglas de oro
- **El cambio más pequeño que cumpla el pedido.** Nada extra "ya que estoy".
- **No borres funciones, campos, endpoints ni validaciones** que no se pidió quitar.
- **No cambies el stack ni agregues dependencias** sin pedido explícito.
- Si encuentras un bug aparte mientras trabajas, **anótalo y avisa**, no lo arregles en el mismo cambio.

## Cortar un flujo: el inventario de lo que hacía de paso

Un **corte** es meter un `return` temprano: un modo nuevo, un atajo, una
condición que evita trabajo. Es de los cambios más rentables y de los que más
rompen, porque el camino viejo casi nunca hacía solo lo que dice su nombre.

**El fallo del 2026-08-03 (el check azul).** En modo mini app se cortó el flujo
antes de la IA. Se verificó lo que se quitó (OpenAI) y lo que se puso (enlace,
recordatorio, 24 h). Nueve pruebas, todas en verde. Pero nadie comprobó **lo
que el camino viejo hacía de paso**: `sendTyping` no solo pinta «escribiendo…»,
también llama a `markAsRead`. Al no pasarlo, los mensajes del cliente se
quedaban en dos checks grises para siempre. Lo vio el dueño desde su teléfono,
no el CI.

### Antes de escribir el corte

Lista **qué HACE** el camino que vas a saltar, no qué responde. En este
proyecto el inventario típico es:

- [ ] ¿Marca el mensaje como leído? (`sendTyping` lo hace, y no se llama así)
- [ ] ¿Guarda el mensaje entrante en el historial?
- [ ] ¿Actualiza la sesión o el contacto?
- [ ] ¿Registra consumo, métricas o errores?
- [ ] ¿Notifica al dueño?
- [ ] ¿Libera algo — un lock, un hold, una reserva?

El corte debe conservar **todo lo que no sea "pensar"**. Lo caro es el modelo;
lo demás normalmente hay que seguir haciéndolo.

### Y una prueba de lo que NO debe perderse

No basta con probar la respuesta nueva. Añade al menos una prueba por cada
efecto de la lista que el corte conserva — que se marcó como leído, que se
guardó el mensaje. Sin eso, el punto ciego es exactamente el mismo: se verifica
el camino nuevo y nadie mira lo que dejó de ocurrir.

> Una función que hace dos cosas y se llama por una de ellas es una trampa.
> Ábrela y léela antes de decidir que tu atajo no la necesita.

## Al terminar — reporta
- Qué archivos cambiaron y por qué.
- Qué se verificó (ver **tester-saas**).
- Qué quedó **intacto** a propósito (lo que el usuario podría temer que tocaste).
- Cualquier hallazgo o riesgo detectado al margen.

> Un cambio pequeño y verificado vale más que una "mejora" grande que nadie pidió y que rompe tres cosas.
