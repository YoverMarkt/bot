---
name: graficos-dashboard
description: Úsala SIEMPRE (aunque no lo pidan) al crear o modificar gráficos, dashboards, KPIs o visualizaciones de datos en BotPanel. Garantiza una presentación coherente y accesible sobre React, TypeScript, shadcn/ui y Recharts, respetando los permisos multi-tenant.
---

# graficos-dashboard

Todos los gráficos del panel deben verse **premium y como un mismo sistema**: colores consistentes, marcas finas, etiquetas directas y accesibles. Esta skill fija el estándar para no improvisar cada vez. Se apoya en la skill bundled **dataviz** (método general); esta la adapta a BotPanel.

## Reglas del proyecto (no negociables)

1. **Sistema compartido.** Usar `ChartContainer`, `ChartTooltip` y `ChartTooltipContent` desde `@botpanel/ui/components/chart`, con primitivas de `recharts`. No agregar Chart.js, D3, CDNs ni un segundo wrapper.
2. **Paleta por tokens.** Usar `var(--chart-1)`…`var(--chart-5)`, `foreground`, `muted-foreground`, `border` y tokens de estado del tema. No hardcodear una paleta distinta por gráfico y comprobar claro/oscuro.
3. **Color nunca como único significado:** acompañar series y estados con etiqueta, valor, tooltip o leyenda; mantener contraste suficiente.
4. **Elegir la forma según el trabajo del dato** (método dataviz): magnitud→barras; composición→dona; tendencia en el tiempo→línea; un solo número→KPI tile. Ante duda, consultar la skill **dataviz** (`references/choosing-a-form.md`).
5. **Nunca doble eje** (dos escalas Y). Dos medidas de distinta escala → dos gráficos.
6. **Marcas finas + etiqueta directa:** barras con extremo redondeado; valor directo cuando mejore lectura; evitar saturar líneas con un número por punto.
7. **Accesibilidad:** activar la capa accesible de Recharts, usar nombres legibles en `ChartConfig`, tooltip y leyenda para ≥2 series; no depender solo de hover.
8. **Multi-tenant y permisos:** los datos salen del backend por `business_id` (endpoints `/api/client/dashboard`, `/api/client/reports`). En el frontend, todo bloque con datos de ventas se muestra **solo si `can('reportes')`** (los empleados sin permiso no lo ven ni disparan el fetch).

## Helpers ya construidos (reutilizar, no reinventar)

La base compartida está en `packages/ui/src/components/chart.tsx`. Los ejemplos oficiales del proyecto viven en `apps/client/src/features/dashboard/Dashboard.tsx` y `apps/client/src/features/reports/Reports.tsx`. Reutiliza sus patrones de `LineChart`, `BarChart` y `PieChart`; mantén transformación y cálculo de datos fuera del JSX visual.

## Backend

Los datos se agregan en `server/src/services/reports.ts` y repositorios de `server/src/db/`. No dupliques cálculos: reutiliza `computeTop`, `computeComparison`, `computeCustomerSummary`, `computeSalesTrend` o el agregador existente correspondiente.

## Verificación (con tester-saas)

- `npm run check`, `npm run build` y pruebas del endpoint afectado.
- **Abrir/mirar el resultado** en claro/oscuro y móvil/escritorio: revisar colisiones, geometría, overflow, tooltip, empty/loading/error y contraste.
- Confirmar que un empleado sin permiso `reportes` no ve ni consulta los datos protegidos.
