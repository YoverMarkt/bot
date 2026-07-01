---
name: cambios-seguros
description: Úsala SIEMPRE (aunque no lo pidan) al modificar algo que ya existe en BotPanel, especialmente si el pedido es amplio, vago o dice "mejora/arregla/optimiza todo esto". Acota el cambio al mínimo y evita romper trabajo que ya funcionaba. Es la skill por defecto ante cualquier edición de código existente.
---

# cambios-seguros

En un proyecto grande y vivo, el mayor riesgo no es no hacer el cambio: es romper de paso algo que ya servía. Esta skill te obliga a un cambio quirúrgico.

## Cuándo se activa
- Cualquier pedido de modificar, ajustar, "mejorar" o "arreglar" código existente.
- Pedidos amplios o ambiguos ("haz que esto funcione mejor", "límpialo", "optimízalo").
- Cuando el archivo a tocar es grande (`bot.js`, `index.js`, los `index.html`).

## Flujo ANTES de tocar código
1. **Reformula el alcance** en una frase: "Voy a cambiar X. NO voy a tocar Y ni Z." Si no puedes nombrar qué NO tocas, todavía no entendiste el pedido → pregunta.
2. **Punto limpio en Git** — confirma con `git status` que no hay cambios sin guardar mezclados; si los hay, sepáralos o coméntalo.
3. **Localiza los archivos mínimos.** En este proyecto, casi siempre:
   - Datos → `server/db.js`
   - Lógica del bot / IA / etiquetas → `server/bot.js`
   - Rutas / endpoints / webhooks → `server/index.js`
   - UI admin → `admin/index.html` · UI cliente → `client/index.html`
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

## Al terminar — reporta
- Qué archivos cambiaron y por qué.
- Qué se verificó (ver **tester-saas**).
- Qué quedó **intacto** a propósito (lo que el usuario podría temer que tocaste).
- Cualquier hallazgo o riesgo detectado al margen.

> Un cambio pequeño y verificado vale más que una "mejora" grande que nadie pidió y que rompe tres cosas.
