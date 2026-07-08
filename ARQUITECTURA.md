# ARQUITECTURA.md — BotPanel: arquitectura objetivo y plan de migración

> **Qué es este documento:** la "biblia técnica" del proyecto. Define el stack
> objetivo de gran escala, la estructura del monorepo y el plan de migración
> **gradual** (patrón estrangulador — nunca big-bang). Complementa a `CLAUDE.md`
> (reglas de trabajo); este archivo define **hacia dónde** evoluciona el código.
> Decidido con el dueño el 2026-07-06. Cualquier programador que se sume al
> proyecto debe leer ambos documentos antes de tocar código.

---

## 1. PRINCIPIOS (por qué migramos así)

1. **Nunca big-bang.** Reescribir todo de golpe mata startups: meses sin vender
   y bugs nuevos en lo que ya funcionaba. Se migra por piezas, con el sistema
   viejo y el nuevo conviviendo detrás del mismo dominio (patrón estrangulador).
2. **Primero las puertas de un solo sentido.** Lo difícil de cambiar con 1000
   clientes no es el código (interno, se refactoriza igual a cualquier escala);
   es lo que los clientes usan/guardan: dominio, datos, canal de WhatsApp,
   esquema de BD. Eso se resuelve ANTES que cualquier refactor bonito.
3. **Regla de oro desde hoy:** todo lo NUEVO nace en la estructura nueva; nada
   nuevo se agrega a los HTML viejos ni engorda `index.js`. El sistema viejo no
   crece más y muere solo.
4. **La IA conversa, el código calcula** (regla inviolable #8 de CLAUDE.md) se
   mantiene intacta en la nueva arquitectura: dinero solo server-side.

---

## 2. STACK OBJETIVO

| Capa | Hoy | Objetivo | Decisión |
|---|---|---|---|
| Lenguaje | JS puro | **TypeScript** (backend y frontend) | Gradual: `@ts-check` → `.ts` |
| Backend | Node + Express (monolito) | **Node + Express + TS**, rutas delgadas / servicios gordos, validación runtime con **Zod** | ✅ Express SE QUEDA (estándar de industria); solo se ordena |
| Base de datos | Supabase (Postgres + RLS + pgvector) | **La misma** | ✅ No se toca. Multi-tenant por `business_id` intacto |
| Frontend paneles | HTML con JS inline | **React + Vite + TypeScript + Tailwind** (SPA) | 🚨 El cambio real |
| Web pública (landing) | No existe | **Next.js** (SEO) | Futuro — Next SOLO para lo público |
| Datos en el front | fetch + polling manual | **TanStack Query** | Con cada feature migrada |
| Tests | Manuales (tester-saas) | **Vitest** (+ Supertest) — dinero PRIMERO | `money`, resolución, totales |
| CI/CD | No hay | **GitHub Actions**: lint + types + tests en cada PR | Fase 0 |
| Deploy | Local + túnel Cloudflare | **Railway + dominio propio + Sentry** | Fase 0 — puerta irreversible |
| Backups | No hay (plan free) | **Supabase Pro** (backups diarios) | Fase 0 — no negociable con clientes reales |
| Escala | — | Redis/BullMQ (colas), workers, Realtime | ⏳ SOLO cuando el volumen lo pida (ver CLAUDE.md §11) |

**¿Por qué Vite y no Next.js para los paneles?** Los paneles viven detrás de un
login: Google no los ve (el SSR/SEO de Next no aporta) y Next exigiría operar un
segundo servidor. Una SPA de Vite son archivos estáticos que el Express actual
sirve igual que hoy sirve los HTML: un solo servidor, un solo deploy. Next.js se
usará donde brilla: la landing pública con SEO.

**¿Por qué React?** Requisito del proyecto: "que cualquier programador sepa cómo
funciona". React tiene el mayor mercado de desarrolladores (incl. Ecuador/
Colombia): se contrata mañana y produce el día uno.

---

## 3. ESTRUCTURA OBJETIVO DEL MONOREPO

> Monorepo = todo el producto en un solo repositorio (lo que ya existe), con
> **npm workspaces** para manejar las sub-apps. Solo se agregan las "paredes
> internas".

```
bot/                                  ← monorepo (npm workspaces)
│
├── server/                           ← API + bot (el Express actual, ordenado)
│   ├── src/
│   │   ├── index.ts                  ← arranque delgado: solo levanta el server
│   │   ├── routes/                   ← UNA ruta = UN archivo
│   │   │   ├── auth.routes.ts
│   │   │   ├── products.routes.ts
│   │   │   ├── orders.routes.ts      ←   pedidos (núcleo de dinero)
│   │   │   ├── sales.routes.ts
│   │   │   ├── sessions.routes.ts
│   │   │   ├── admin.routes.ts
│   │   │   └── webhooks.routes.ts    ←   Meta/YCloud/Kapso (anti-duplicados)
│   │   ├── services/                 ← la LÓGICA (rutas delgadas, servicios gordos)
│   │   │   ├── money.service.ts      ←   ex money.js — nació limpio
│   │   │   ├── payments.service.ts   ←   pasarelas (DeUna se enchufa aquí)
│   │   │   ├── bot.service.ts        ←   processMessage, prompt, media
│   │   │   ├── ai.service.ts         ←   callAI multi-proveedor + visión + audio
│   │   │   ├── reports.service.ts    ←   7 reportes + alertas
│   │   │   └── schedule.service.ts   ←   horarios / fuera de horario
│   │   ├── db/
│   │   │   ├── client.ts             ←   conexión Supabase (ÚNICA)
│   │   │   └── repositories/         ←   ex db.js, partido por tabla
│   │   ├── middleware/               ←   authAdmin, authClient, permisos, rate-limit
│   │   └── lib/                      ←   helpers puros (fechas, key9, etc.)
│   ├── tests/                        ← Vitest — dinero primero
│   └── package.json
│
├── apps/
│   ├── client/                       ← panel del cliente — React + Vite + TS
│   │   └── src/
│   │       ├── features/             ← POR FUNCIÓN, no por tipo de archivo
│   │       │   ├── conversations/    ←   chat, etiquetas, modo manual
│   │       │   ├── catalog/          ←   productos, fotos/videos
│   │       │   ├── sales/            ←   ventas + pedidos del bot
│   │       │   ├── reports/          ←   dashboards, KPIs, alertas
│   │       │   ├── customers/        ←   directorio, reactivar, perdidos
│   │       │   └── settings/         ←   horarios, prompt, equipo
│   │       ├── components/           ←   UI compartida (botones, modales, tablas)
│   │       ├── api/                  ←   llamadas al server (TanStack Query)
│   │       └── App.tsx / main.tsx
│   ├── admin/                        ← panel superadmin — misma estructura
│   └── landing/                      ← (futuro) Next.js — web pública con SEO
│
├── packages/
│   └── shared/                       ← tipos compartidos: Order, Product, Business…
│       └── types.ts                  ←   definidos UNA vez; front y back avisan si rompes el contrato
│
├── .github/workflows/ci.yml          ← lint + types + tests en cada PR
├── ARQUITECTURA.md                   ← este documento
├── CLAUDE.md                         ← reglas de trabajo (leer SIEMPRE)
└── package.json                      ← raíz workspaces
```

### Las 3 reglas que hacen que esto escale
1. **Rutas delgadas, servicios gordos** — la ruta solo recibe/responde HTTP; la
   lógica vive en `services/` y se testea sin levantar el servidor.
2. **Frontend por `features/`, no por tipo** — todo lo de "ventas" vive junto.
   Un programador nuevo encuentra cualquier cosa en 30 segundos.
3. **Tipos compartidos en `packages/shared`** — el contrato front↔back es UNO.
   Cambias un campo y ambos lados marcan en rojo lo que se rompió.

---

## 4. PLAN DE MIGRACIÓN (estrangulador — nadie espera nada)

| Fase | Qué se hace | El sistema viejo… |
|---|---|---|
| **0. Cimientos** | Railway + **dominio propio** + Supabase Pro (**backups**) + npm workspaces + CI (lint + `@ts-check` en dinero) + Sentry | …sigue atendiendo clientes, intacto |
| **1. Server ordenado** | Crear `routes/` y `services/`; mover módulo por módulo (primeros: `money`, `payments` — ya nacieron limpios). `@ts-check` → `.ts` gradual | …convive; `index.js` se adelgaza pieza a pieza |
| **2. Panel cliente React** | `apps/client` con Vite. Migrar por feature empezando por **Conversaciones** (la más usada), luego Ventas → Reportes → resto. Express sirve la app nueva cuando cada sección esté lista | …el HTML viejo responde hasta que su sección muere |
| **3. Panel admin React** | Igual (solo lo usa el dueño del SaaS — menos urgente) | …igual |
| **4. Landing Next.js** | Web pública con SEO (precios, comparativas, testimonios) | no existe hoy — todo es ganancia |
| **5. Escala real** | Redis/colas/workers/Realtime **cuando el volumen lo pida** | — |

**Orden de fases = orden de riesgo:** primero lo irreversible (dominio, backups,
canal), después las barandillas (CI/tests), y solo entonces el refactor visible.
Un panel React precioso corriendo en un Mac con túnel y sin backups NO es
"empresa grande".

### Criterios de "hecho" por fase
- **Fase 0 hecha** cuando: los paneles cargan desde el dominio propio, un push a
  `main` deploya solo, la BD tiene backup diario y el CI corre en cada PR.
- **Fase 1 hecha** cuando: `index.js` < ~200 líneas (solo arranque) y el dinero
  tiene tests que corren en CI.
- **Fase 2 hecha** cuando: el dueño de un negocio hace TODO su día en la app
  React sin tocar el HTML viejo.

---

## 5. QUÉ NO CAMBIA NUNCA (invariantes)

- Aislamiento multi-tenant por `business_id` (JWT) — reglas §4 de CLAUDE.md.
- El dinero se calcula SOLO server-side (`money.service`) — regla #8.
- Supabase/Postgres como única base; `schema.sql` como referencia del esquema.
- Migraciones de BD aditivas, jamás destructivas.
- Español en textos de cara al cliente; commits en español.
- Monolito hasta que la demanda real exija otra cosa (CLAUDE.md §11).
