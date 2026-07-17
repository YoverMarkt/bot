---
name: tester-saas
description: Verifica BotPanel después de cualquier cambio de código, esquema, rutas o UI. Usar siempre antes de declarar terminado un bloque para ejecutar lint, tipos, Vitest, builds React y smoke tests proporcionales al riesgo, con prioridad en dinero y aislamiento multi-tenant.
---

# tester-saas

Aplicar la pirámide de verificación desde lo rápido hasta lo integrado. No debilitar una prueba para hacerla pasar.

## Verificación base obligatoria

Desde la raíz del monorepo:

```bash
npm run check   # ESLint/Oxlint + TypeScript estricto + Vitest del servidor
npm run build   # TypeScript + build Vite de client y admin
git diff --check
```

El estado esperado es cero errores. Registrar warnings existentes y no introducir warnings nuevos.

## Seleccionar pruebas adicionales

- **Dinero, pedidos o catálogo:** ejecutar `npm test`; probar producto exacto, ambiguo, oferta, cantidad y redondeo.
- **Auth, permisos o rutas cliente:** probar sin token, token de dueño y empleado sin permiso. Confirmar que `businessId` sale del JWT.
- **BD/RLS/multi-tenancy:** usar dos negocios de prueba; A nunca lee ni modifica B. Verificar RLS e índices en el SQL nuevo.
- **Webhooks/secretos:** probar firma válida, inválida, ausente y replay. Confirmar que producción falla cerrado.
- **Bot/etiquetas:** simular el flujo afectado y confirmar que la etiqueta se procesa, se retira del texto y conserva `business_id`.
- **React/shadcn:** compilar ambos paneles, revisar la ruta afectada en claro/oscuro y móvil/escritorio, además de teclado, foco, loading, empty y error.
- **Login, navegación, permisos o responsive:** ejecutar `npm run test:e2e`. La primera vez, instalar Chromium con `npm run test:e2e:install`.
- **Eliminación legacy:** buscar referencias con `rg -n "admin-legacy|client-legacy|admin/index|client/index" .` y confirmar que no quedan consumidores.

## Smoke test del servidor

Arrancar solo cuando las variables locales necesarias estén configuradas:

```bash
npm start
curl -fsS http://localhost:3000/api/health
```

No importar `server/dist/index.js` como chequeo de módulo: abre puerto, timers, túnel y Telegram. La compilación TypeScript valida la sintaxis; para el entrypoint usa el smoke test con integraciones externas desactivadas.

## Pruebas E2E de los paneles

Playwright levanta ambos Vite servers y simula las APIs; no necesita Supabase ni secretos:

```bash
npm run test:e2e
```

Las pruebas viven en `e2e/` y deben usar roles/labels accesibles. Cubrir al menos redirección sin sesión, login, persistencia de token, navegación móvil y visibilidad por permisos. No sustituye la prueba de staging contra una base y canales reales.

## Regla de cierre

Reportar qué se ejecutó, qué pasó, qué no pudo probarse sin credenciales/BD y el riesgo residual. Un build verde no sustituye un smoke test funcional de la zona modificada.
