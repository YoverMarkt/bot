---
name: premium-ui-design
description: Diseña interfaces de food delivery de nivel premium (estilo Rappi, iFood, Careem) para la mini app de la tienda. Úsala siempre que se creen o editen pantallas, componentes de UI, cards de producto, checkout, o cualquier vista de apps/store con React/Tailwind. Aplica el design system de la marca y evita el look genérico "de IA".
---

# Premium UI Design — la mini app de la tienda

Cuando construyas o edites cualquier interfaz de `apps/store`, sigue este
sistema. El objetivo es que se vea diseñado por un diseñador profesional, a la
altura de Rappi, iFood y Careem — no generado por IA.

> ⚠️ **Esta skill NO manda sobre [DISENO-MINIAPP.md](../../../DISENO-MINIAPP.md).**
> Aquel documento es el respaldo del diagrama que el dueño aprobó el 2026-08-05
> y define la ESTRUCTURA de las once pantallas. Esta skill define el ACABADO:
> sombras, jerarquía tipográfica, tokens neutros y disciplina de color. Donde
> las dos hablen de lo mismo, manda el documento. Los tres puntos donde se
> tocan están resueltos abajo.

## Reglas anti "look de IA" (críticas)

1. **Fondo claro y cálido**, nunca dark mode. La comida resalta sobre superficies
   claras. Cards blancas sobre fondo off-white. ✅ Coincide con la decisión ya
   tomada en `apps/store/src/index.css`: `color-scheme: light` fijo, porque el
   modo oscuro le daba la vuelta a la tinta y el dueño veía la app distinta
   según cómo tuviera el teléfono.
2. **La foto real es el héroe.** Cada producto lleva fotografía real. Nunca
   ilustraciones planas, SVG de comida, ni emoji como imagen de producto. Si una
   imagen falla, muestra un bloque con gradiente tintado como fallback — nunca
   roto. ✅ Coincide con «La foto manda. Sin fotos, este diseño no funciona — no
   es un problema de CSS».
3. **Jerarquía tipográfica fuerte.** Contraste marcado entre tamaños: títulos
   24–26px peso 800 con letter-spacing negativo, junto a captions de 12px. Nada
   de escalas uniformes y compactas.
4. **Color de acento solo en acciones.** El acento aparece únicamente en: botón
   de agregar, precio, botón de pagar y estados activos. Todo lo demás es
   negro/neutro. Disciplina de color = sensación premium.
5. **Sombras en capas**, nunca una sombra plana. Cada card lleva una sombra fina
   de contacto + una difusa de elevación. Bordes redondeados generosos (16–24px).

## Design tokens

⚠️ **EL ACENTO NO SE FIJA AQUÍ.** Sale de `businesses.brand_color` a través de
la variable CSS `--acento`, y el de la plataforma es el lima `#D9F950`. Un
negocio con marca azul tiene que verse azul: por eso el motor de la tienda
**nunca** escribe un color de marca en el CSS. Los tokens de abajo son los
NEUTROS y las sombras, que sí son de la plataforma y sí se fijan.

```js
const T = {
  // El acento viene de var(--acento). NO se escribe un hex aquí.
  ember: "#F0542D",  // acento de apetito, uso escaso y nunca como marca
  gold:  "#F2B705",  // ratings, cuando existan
  ink:   "#14181A",  ink2: "#3D4548",  ink3: "#8A9296", // texto
  bg:    "#F6F7F5",  card: "#FFFFFF",  line: "#ECEEEB",
};

const SH = {
  card:     "0 1px 2px rgba(20,24,26,0.04), 0 4px 16px -6px rgba(20,24,26,0.08)",
  raise:    "0 2px 4px rgba(20,24,26,0.05), 0 12px 30px -10px rgba(20,24,26,0.14)",
  acento:   "0 6px 16px -6px color-mix(in srgb, var(--acento) 45%, transparent)",
  acentoBig:"0 14px 30px -10px color-mix(in srgb, var(--acento) 50%, transparent)",
  float:    "0 10px 40px -8px rgba(20,24,26,0.22)",
};
```

Tipografía: sans geométrica (Inter, Manrope o Geist). Pesos 500 / 700 / 800.

## Componentes base

- **Product card (horizontal):** foto 108px a la izquierda con badge opcional
  ("Más pedida" en ember, "Premium" en negro); a la derecha nombre (16px bold),
  descripción 2 líneas en gris, fila de metadatos y precio (19px bold) y botón
  "+" con el acento y su glow.
- **Botón primario:** acento, alto 58–60px, radio 18px, sombra `SH.acentoBig`,
  con micro-interacción `active:scale-95`.
- **Pills de categoría:** activa en tinta (#14181A) texto blanco; inactiva blanca
  con `SH.card`.
- **Tab bar:** pill blanca flotante, tab activa con un tinte del acento.
- **Selectores (tamaño/masa/extras):** opción activa en acento sólido con `SH.acento`.

## Reglas técnicas

- React + Tailwind. Tokens neutros y sombras en `tailwind.config`, no sueltos.
- Las imágenes de producto salen de **Cloudinary** (`image_url` del catálogo),
  que es lo que este proyecto usa. Nunca placeholders de stock.
- Skeleton loaders con shimmer mientras cargan las imágenes.
- Respeta `prefers-reduced-motion` y focus rings visibles por accesibilidad.
- Texto de cuerpo mínimo #3D4548 sobre blanco (contraste AA).
- **Copy en español** neutro (Ecuador/Colombia), tono apetitoso y directo.

## Lo que NO se copia

De cualquier referencia visual (Careem, Rappi, Uber Eats, iFood) se toma la
estructura y la jerarquía. **No** se copian marca, colores corporativos, textos
literales, iconos, fotografías ni identidad visual. La plataforma tiene la suya.

⚠️ Y no se pinta un control que no controle nada: un filtro «4.5+ Rated» sin
sistema de ratings, o un «Best Sellers» que no ordena, es el mismo fallo de
«construido y desconectado» que este proyecto lleva nueve veces pagando, solo
que en la interfaz. Si el dato no existe, el control no se dibuja.

## Checklist antes de dar por terminada una pantalla

- [ ] ¿Fondo claro y cards con sombra en capas?
- [ ] ¿Foto real como héroe, con fallback de gradiente?
- [ ] ¿El acento sale de `var(--acento)` y solo se usa en acciones?
- [ ] ¿Jerarquía tipográfica con contraste fuerte?
- [ ] ¿Tokens tomados de `T` y `SH`, no hardcodeados sueltos?
- [ ] ¿Skeleton + reduced-motion + focus visible?
- [ ] ¿Todo control que se dibuja hace algo de verdad?
