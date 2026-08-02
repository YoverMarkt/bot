# PENDIENTE.md — módulos futuros y decisiones de NO construir

Movido de `CLAUDE.md` **sin cambiar una frase**.

> **No construir nada de aquí de forma especulativa.** Cada entrada está
> anotada con lo que haría falta definir ANTES de empezar, y varias existen
> justamente para dejar constancia de que se decidió *no* hacerlas todavía.
> Esperar la señal de un cliente o piloto real.

---

- **Sucursales / multi-local por negocio.** Un negocio con varios locales. Enfoque **aditivo** cuando se pida: tabla `locations` + columna `location_id` (nullable) en `products`, `sales`, `bookings`, `conversation_sessions`. Los negocios de un solo local quedan con `location_id` nulo (sin cambios). NO construir de forma especulativa: mete "impuesto de complejidad" a todos y toca multi-tenancy (filtrar por `business_id` **y** `location_id`). Requiere definir antes: ¿cada sucursal tiene su propio número de WhatsApp?, ¿comparten catálogo?, ¿un empleado pertenece a una o varias? Va con **arquitecto-saas**.
- **Ventas por sucursal** (reporte) depende del módulo anterior.
- **Perfil de cliente ampliado (paso 2 del directorio de clientes).** Agregar al directorio: **ciudad, cédula y correo del cliente**, y permitir **buscar por cédula y correo**. Hoy NO se recopilan esos datos. Requiere definir: (a) dónde se guardan (tabla/perfil de cliente por `business_id`, hoy el cliente es solo `contact_phone` disperso en `sales`/`conversation_sessions`), y (b) **cómo se capturan** (¿el dueño los escribe a mano?, ¿el bot los pide?). ⚠️ La **cédula es PII sensible** → va con **seguridad-saas** (para qué se usa, consentimiento, almacenamiento cuidado). El directorio base (nuevos/frecuentes/inactivos, última compra, total gastado, frecuencia, búsqueda por nombre/teléfono) YA está hecho.
- **Alertas — Fase 2 (push instantáneo) y Fase 3 (resumen diario).** La Fase 1 YA está hecha: **banner de alertas en el panel** (sección Reportes, endpoint `/api/client/alerts` → `reports.computeAlerts`), que vigila con los cálculos existentes. Falta: (a) **Fase 2 — push por WhatsApp al dueño** de las críticas, con hook en `server/src/services/bot-conversation.ts`/venta, umbral configurable y anti-duplicado; (b) **Fase 3 — resumen diario**, programado desde `server/src/index.ts`. ⚠️ Toca envío y multi-tenancy → va con **arquitecto-saas**.
- **Reporte de IA — Fase 2: con IA.** La Fase 1 YA está hecha (sin IA): preguntas frecuentes por reglas y huecos persistidos en `ai_gaps` desde `server/src/services/bot-actions.ts`. Falta agrupar preguntas abiertas y sugerir automáticamente mejoras por lotes. ⚠️ Usa IA sobre conversaciones → va con **seguridad-saas** y **arquitecto-saas**.
- **Clientes perdidos — Capa 2: razón completa.** El reporte "Clientes perdidos" (Capa 1) YA está hecho: lista de quienes **escribieron pero no compraron en el período**, con badge 🔁 ya-cliente / 🆕 nuevo y razón automática **"No respondió"** (el negocio habló al final). Falta la **razón completa**: **Precio / Sin stock / Cambió de opinión** (hoy quedan como "Sin clasificar"). Requiere definir el método de captura: (a) **manual** — el dueño marca la razón por cliente desde el panel (columna nueva, ej. tabla `lost_customers` o campo en sesión, por `business_id`); (b) **IA infiere** — clasificar leyendo la conversación (costo de llamadas IA, ~aproximado); (c) **mixto**. ⚠️ Si se usa IA sobre conversaciones del cliente → va con **seguridad-saas**; en todo caso con **arquitecto-saas** (dónde persiste la razón sin romper multi-tenancy). Entregar al usuario para analizar antes de construir.
- **Campañas / difusión (mensajes salientes).** NO existe. Mandar una promo a una audiencia (todos, clientes perdidos, en riesgo). Cimientos listos: envío (`ycloud.sendText/sendImage`, Telegram) + audiencias ya calculadas (directorio, perdidos, riesgo). Falta: módulo que arme el mensaje + elija audiencia + envíe a muchos, tabla de campañas + control de envíos, y UI. ⚠️ Envío proactivo en WhatsApp fuera de la ventana de 24h exige **plantillas aprobadas por Meta** + opt-in. **Construir SOLO después de estabilizar el canal (Meta) y el deploy.** Va con **arquitecto-saas** + **seguridad-saas**.
- **Asistente de voz para el dueño ("Jarvis" — ElevenLabs).** NO existe. Que el bot responda con nota de voz al `owner_phone`. Falta key mediante `server/src/services/settings.ts`, generación TTS, envío por la integración del canal y control de costo. ⚠️ Va con **arquitecto-saas** + **seguridad-saas** después del deploy + Meta.
- **Recordatorios automáticos de citas (mensajes salientes).** NO existe. Avisar antes de una cita usando `bookings`, la capa de envío y una tarea programada desde `server/src/index.ts`; requiere `reminded_at` o estado equivalente para no repetir. ⚠️ Construir después de Meta + deploy con **arquitecto-saas**.
- **Hospedaje — extensiones futuras (anotado 2026-07-17; construir SOLO cuando un hostal real lo pida).** El módulo base está COMPLETO (cotización oficial → retención con vencimiento → confirmación del equipo, anti-sobreventa con locks + trigger, bloqueos manuales, tarifas por fecha, reporte de Ingresos por estadías confirmadas —aparte de las ventas de productos—, panel de 5 pestañas). Candidatos por orden de valor real: (1) **Sincronización iCal con Booking/Airbnb** — hoy las reservas externas se registran como bloqueos manuales; los OTAs exponen calendarios iCal que se podrían importar periódicamente para descontar cupo solo (es lo primero que sufrirá un hostal que venda en OTAs). ⚠️ Tarea programada + escritura de bloqueos por `business_id` → va con **arquitecto-saas**. (2) **Vista calendario de ocupación** en el panel (mes con ocupación por tipo de habitación; hoy solo hay búsqueda por fechas) — va con **graficos-dashboard**. (3) **Recordatorio de llegada al huésped** — pertenece a la familia de mensajes salientes post-Meta/deploy, junto a recordatorios de citas y campañas. (4) **Inventarios grandes / muchos tipos de habitación (anotado 2026-07-23; consulta del usuario).** Aclaración clave: el menú lista TIPOS de habitación, NO habitaciones físicas; un hostal de 100 habitaciones suele ser ~6-10 tipos con `total_units` alto, así que el registro NO cambia y ese caso YA funciona tal cual. Solo si un negocio tiene MUCHOS tipos (15-30+) el menú paginado (8 + "Ver más") incomoda. Enfoque recomendado cuando llegue un caso real: **invertir el flujo — pedir fechas + personas PRIMERO y que el servidor muestre solo las disponibles que caben** (reaprovecha `quote_lodging_options`, que ya filtra por disponibilidad; escala a cualquier tamaño, estilo Booking). Complementario: **agrupar tipos por categoría** (como el flujo de productos), requiere un campo de grupo en el tipo de habitación. Inventario gigante con tarifas dinámicas/canales → motor de reservas web + bot como embudo (junta fechas → cotiza → deriva), o modo IA + cotización del servidor. NO construir hasta que un hostal grande real lo pida. Va con **arquitecto-saas**.
- **Reglas de descuento automáticas por código (promos).** NO existe (anotado 2026-07: construir SOLO cuando un cliente real lo pida). Que el dueño configure promos con condiciones desde su panel — ej. "10% en pedidos sobre $50", "2x1 los martes", "descuento por combo" — y que las aplique `server/src/services/money.ts` en el campo `discount` que YA existe en `orders` (cimiento listo). La IA solo ANUNCIA la promo; la condición y la resta las calcula el SERVIDOR (regla inviolable #8: la IA jamás decide montos). Requiere: tabla de reglas por `business_id` + RLS, UI en el panel del dueño, y lógica de condiciones en `money.ts` (monto mínimo, día de semana, producto/combo). Mientras tanto, el **Precio oferta** (`price_sale`) por producto ya cubre promos simples y el núcleo lo respeta. Va con **arquitecto-saas** + **base-de-datos**; diseñar con el caso real del cliente que lo pida, no especulando.
- **Blindaje anti-invención de la IA — fase 2 (anotado 2026-07-18; construir cuando haya clientes grandes o antes de pasarelas de pago).** La fase 1 YA está hecha: grounding con datos reales, núcleo de dinero determinista, etiquetas con fallo cerrado, y detector de suplantación de resúmenes oficiales (`bot-tags.impersonatesOfficialSummary`, PR #100 — la IA imitó una cotización con datos inventados y ahora se descarta y deriva). Faltan tres capas, TODAS internas (no son pantallas de paneles): (1) **Evals de comportamiento** — comando interno tipo `npm run evals` con ~20 conversaciones doradas por tipo de negocio contra el bot real, verificando automáticamente "¿inventó datos/montos? ¿emitió la etiqueta correcta? ¿derivó cuando debía?"; correr antes de demos y al cambiar prompt o modelo (costo: centavos por corrida; es la capa que más paga por esfuerzo — construir primero). (2) **Validador de precios en salida** — chequeo en vivo en `bot-conversation`: todo monto `$X` que escriba la IA se compara contra el catálogo real del negocio; si no existe → se descarta el mensaje y deriva (fallo cerrado). ⚠️ Requiere calibrar falsos positivos con los evals del punto 1; va con **arquitecto-saas** + **seguridad-saas**. (3) **Modelo fuerte por negocio** — NO es código: palanca operativa que ya existe en el panel admin (proveedor de IA por negocio); asignar OpenAI a clientes grandes/pagantes. Regla para pasarelas de pago futuras: la IA JAMÁS toca el camino del pago — monto del pedido calculado por código, enlace generado por el servidor, la IA solo lo anuncia.
- **Optimización de egress / consumo de datos de Supabase.** NO hecho (decidido con el usuario 2026-07: por ahora se paga/aguanta, no se toca el código; anotado para cuando se justifique). **Contexto:** en plan free (5 GB egress/mes = datos leídos que SALEN de la base, NO storage) el consumo llegó a ~5.47 GB **sin subir archivos pesados**. Causa: **polling del panel** — `loadConversations` cada **3s** trae hasta **100 mensajes completos** + todas las sesiones con `select('*')`; `checkForUpdates` cada 5s; `checkNewBookings` cada 12s. Se acumula solo con el panel abierto. Segundo culpable histórico: lecturas de catálogo que incluían el `embedding` vector(1536); revisar `server/src/db/repositories/products.ts` antes de optimizar. **Cloudinary NO influye** (la media va a Cloudinary, no a Supabase). **Optimizaciones pendientes (por impacto/riesgo):** (1) bajar polling de conversaciones 3s→~10s + **pausar con Page Visibility API** cuando la pestaña no está visible → corta ~70-80%, riesgo mínimo; (2) confirmar selects mínimos del catálogo; (3) traer **solo lo nuevo** en conversaciones en vez de 100 completos; (4) detectado 2026-07-16: `reports.getAllReports` lanza ~8 lecturas idénticas de `getSalesWithItems` por carga (una por cada compute) — deduplicar trayendo las ventas UNA vez y pasándolas a los cálculos. **Alternativa operativa:** Supabase Pro. **Solución de fondo:** Realtime/WebSockets + caché cuando el volumen lo justifique. Va con **arquitecto-saas** + **base-de-datos**.

> **Estado del producto (nota estratégica):** el sistema está **listo para vender/demo**. La construcción de features está **en pausa a propósito** — el siguiente paso es **operativo**, no de código: demo → cambiar número a **Meta** (hoy YCloud) → **deploy 24/7 en servidor real** (hoy corre local + túnel). Campañas y recordatorios (los dos únicos que envían mensajes salientes) van **después** de eso. No construir más módulos de forma especulativa; esperar señal de un cliente/piloto real.

> **Escalabilidad (nota de arquitectura, a futuro):** hoy es un **monolito** (un solo servidor Node + Express). Es lo **correcto para la etapa actual** (primeros clientes) — simple, barato, fácil de operar. NO refactorizar de forma especulativa. Cuando haya **demanda real de escala** (muchos negocios/mensajes concurrentes), recién ahí evaluar: **Realtime/WebSockets** (empujar cambios al panel en vez de que pregunte cada X segundos — ataca de raíz el egress del polling), **caché (Redis)** (datos muy leídos en memoria, sin golpear la base), **colas** (procesar mensajes/IA sin bloquear), **workers** separados (envíos, embeddings, reportes pesados, transcodificar media), varias instancias + balanceador, réplicas de lectura, y quizás separar el bot del panel. Antes de todo eso, el paso barato es **Supabase Pro ($25/mes)** para subir los límites. Es un "problema de éxito": se aborda cuando el volumen lo justifique, no antes.

---

## EN CURSO — Pedidos como sección propia (decidido 2026-08-02)

**No es especulativo: sale de un cliente real** (Monster Pizza, creado hoy) y del diagrama
de flujo que trajo el dueño del SaaS.

### El diagnóstico

Medido en el código, no supuesto:

- **La alarma existe pero es sorda a los pedidos.** `components/AlarmSystem.tsx` suena y
  notifica por modo manual, reservas y hospedaje. `orders` NO está en la lista.
  Lo alimenta `hooks/useAttention.ts`, que tampoco los trae.
- **Los pedidos viven en el sitio equivocado:** `features/sales/Sales.tsx`, pestaña
  «Pedidos del bot», con recarga cada 15 s.

Son dos momentos distintos del negocio y por eso duele: un **pedido** llega y hay que
atenderlo ya, lo inicia el cliente; una **venta** se registra cuando ya se cobró, la cierra
el negocio. Meter el pedido dentro de Ventas obliga al dueño a entrar a «registrar una
venta» para ver algo que todavía no vendió — y por eso nadie conectó nunca la alarma ahí.

### El orden acordado

1. **Que la alarma oiga los pedidos.** Lo más pequeño y lo que más duele: sin esto se
   pierden pedidos. Tocar `useAttention.ts` + `AlarmSystem.tsx`.
2. **Sección Pedidos propia**, como bandeja de entrada, fuera de Ventas.
3. **El puente a la cooperativa de reparto**, cuando el pedido pasa a «en camino».

### La decisión que NO puede esperar

Hoy `orders.status` acepta `pendiente · confirmado · completado · cancelado · expirado`.
Al flujo real de una pizzería le faltan **`preparacion`** y **`en_camino`** — y ese último
es donde engancha la cooperativa.

⚠️ **Añadir esos estados ahora, con cero pedidos reales, es gratis. Dentro de un mes
significa migrar datos de un cliente que ya está operando.** Es el motivo de que esto esté
escrito antes de empezar a construir.

### Lo que ya está resuelto y no hay que rehacer

- Cuenta bancaria del negocio: panel + `/api/store/:slug/payment-info` (PR #132).
- Tamaños, categorías y sabores: cargados y funcionando.
- El total lo calcula el servidor y el pedido NO viaja como mensaje de WhatsApp editable.

### Lo que sigue faltando del diagrama del dueño

| Paso | Estado |
|---|---|
| Selector de método de pago | ❌ no hay columna `payment_method` |
| Subir comprobante de transferencia | ❌ |
| Coste de envío | ❌ `orders` solo tiene subtotal, discount, total |
| Tarjeta de crédito | descartado a propósito |
