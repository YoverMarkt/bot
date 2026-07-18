## Qué cambia

<!-- El problema o pedido, la causa si es un fix, y qué hace este PR. -->

## Qué NO se toca

<!-- Qué queda intacto a propósito (endpoints, lógica, pantallas). Delimita el alcance. -->

## Verificación

<!-- Marca lo que corriste y agrega evidencia (números de tests, capturas si es UI). -->

- [ ] `npm run check` (lint + tipos + tests) en verde
- [ ] `npm run test:e2e` en verde (si toca paneles o flujos)
- [ ] Probado a mano en la zona afectada
- [ ] Cambio nuevo = test nuevo que lo protege

## Reglas inviolables

- [ ] Multi-tenancy intacto (`business_id` del JWT, RLS sin debilitar)
- [ ] Sin secretos en el código ni en el diff
- [ ] Ningún monto calculado por la IA (dinero solo server-side)
