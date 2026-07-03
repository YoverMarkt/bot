---
name: graficos-dashboard
description: Úsala SIEMPRE (aunque no lo pidan) al crear o modificar gráficos, dashboards, KPIs o visualizaciones de datos en el panel de BotPanel. Garantiza que todos los gráficos se vean como un sistema premium y coherente, con la paleta validada (CVD-safe), sin dependencias externas, y respetando el stack (HTML/CSS/JS puro) y los permisos multi-tenant.
---

# graficos-dashboard

Todos los gráficos del panel deben verse **premium y como un mismo sistema**: colores consistentes, marcas finas, etiquetas directas y accesibles. Esta skill fija el estándar para no improvisar cada vez. Se apoya en la skill bundled **dataviz** (método general); esta la adapta a BotPanel.

## Reglas del proyecto (no negociables)

1. **Sin dependencias externas.** Nada de Chart.js, D3 ni CDNs. Los gráficos se dibujan con **HTML/CSS (barras) y SVG inline (dona/línea)**. Motivo: stack puro (CLAUDE.md §2), velocidad, y privacidad (nada sale del servidor — se vende a empresas).
2. **Paleta validada, definida en `:root`** de `client/index.html` (no hardcodear hex en cada gráfico):
   - Categórica (identidad, hasta 4): `--c1 #2a78d6` · `--c2 #1baf7a` · `--c3 #eda100` · `--c4 #008300`. **Orden fijo, nunca ciclado** (es el mecanismo CVD-safe: ΔE 24.2).
   - Estado (stock, salud): `--c-good #0ca30c` · `--c-warn #f5a623` · `--c-crit #d03b3b`. Reservados — nunca como "serie 5".
   - Serie única (barras de un solo tipo): tinta `--c-bar #1e1e1e` (alto contraste, on-brand).
   - Chrome: `--grid`, `--axis`, texto en `--ink`/`--muted` (el texto NUNCA lleva el color de la serie).
3. **Regla de relieve:** `--c2` (aqua) y `--c3` (amarillo) quedan bajo 3:1 en fondo blanco → **siempre** con etiqueta/valor directo visible (leyenda con número), nunca identidad solo por color.
4. **Elegir la forma según el trabajo del dato** (método dataviz): magnitud→barras; composición→dona; tendencia en el tiempo→línea; un solo número→KPI tile. Ante duda, consultar la skill **dataviz** (`references/choosing-a-form.md`).
5. **Nunca doble eje** (dos escalas Y). Dos medidas de distinta escala → dos gráficos.
6. **Marcas finas + etiqueta directa:** barras con extremo redondeado ancladas al inicio; dona con gap de ~1.4 a la superficie; valor directo en cada barra/segmento (no un número por punto en líneas).
7. **Accesibilidad:** `<title>` en cada segmento/barra (tooltip nativo = capa hover mínima); leyenda presente para ≥2 series; `role`/`aria-label` en el SVG.
8. **Multi-tenant y permisos:** los datos salen del backend por `business_id` (endpoints `/api/client/dashboard`, `/api/client/reports`). En el frontend, todo bloque con datos de ventas se muestra **solo si `can('reportes')`** (los empleados sin permiso no lo ven ni disparan el fetch).

## Helpers ya construidos (reutilizar, no reinventar)

En `client/index.html`:
- `hBars(rows, {fmt, color})` — barras horizontales. `rows = [{label, value}]`.
- `donut(segs, {center, centerLabel})` — dona. `segs = [{label, value, color}]`.
- KPI tiles: clases `.kpi-row`, `.kpi`, `.kpi-l/v/d` (delta en verde `--c-good` / rojo `--red`).
- Tarjeta contenedora: `.chart-card` + `.chart-grid` (grid responsive).

Para un gráfico nuevo, primero mira si `hBars`/`donut` sirven. Si necesitas línea/tendencia, créala como SVG inline siguiendo estas reglas y agrega el helper (`lineChart`) para reutilizar.

## Backend

Los datos de gráficos se agregan en `server/reports.js` reutilizando los `compute*` existentes (ej. `getDashboard`). No dupliques cálculo: si ya existe `computeTop`, `computeComparison`, `computeCustomerSummary`, úsalos.

## Verificación (con tester-saas)

- `new Function()` sobre los `<script>` del panel (sintaxis).
- Smoke test del endpoint contra Supabase real.
- **Abrir/mirar el resultado**: los gráficos se revisan a ojo (colisiones de etiquetas, geometría, overflow) además de validar la paleta con el script de dataviz cuando se agregan colores nuevos.
