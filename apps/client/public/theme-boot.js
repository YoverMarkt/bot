// Aplica el tema guardado ANTES del primer pintado: el esqueleto de
// arranque nace del color correcto y se elimina el flash de tema.
// Vive como archivo externo porque el CSP (script-src 'self') bloquea
// los scripts inline del index.html.
try {
  if (localStorage.getItem('bp-theme-client') === 'dark') {
    document.documentElement.classList.add('dark')
  }
} catch { /* almacenamiento bloqueado: tema claro por defecto */ }
