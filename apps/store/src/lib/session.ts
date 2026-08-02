// La credencial de la tienda es el enlace que mandó el bot. No hay usuario ni
// contraseña: el cliente ya se identificó al escribir por WhatsApp.
//
// Dos cosas que importan y no son obvias:
//
//  1. El token se BORRA de la barra de direcciones en cuanto se lee. Una
//     captura de pantalla compartida en un grupo no puede regalar la sesión.
//  2. El identificador de dispositivo se genera una vez y se conserva. Es lo
//     que ata la sesión a ESTE teléfono: si el enlace se reenvía, el servidor
//     ve otro dispositivo y lo rechaza.

const DEVICE_KEY = 'vz_store_device'
const TOKEN_KEY = 'vz_store_token'

/** El slug vive en la ruta: /t/<slug>. Sin router: leerlo es una línea. */
export function readSlug(): string {
  const partes = window.location.pathname.split('/').filter(Boolean)
  const indice = partes.indexOf('t')
  return indice >= 0 ? (partes[indice + 1] || '') : (partes[0] || '')
}

/**
 * Identificador aleatorio. `crypto.randomUUID` no existe en los WebView
 * viejos de Android —justo los que abre WhatsApp en teléfonos modestos—, así
 * que hay un camino alternativo antes de rendirse.
 */
function randomId(): string {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    // Último recurso: sin generador criptográfico no se puede atar nada de
    // forma fiable, pero al menos NO se devuelve una constante compartida —
    // eso haría que dos teléfonos distintos parecieran el mismo.
    return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  }
}

/** Identificador estable de este navegador. Se crea una sola vez. */
export function deviceId(): string {
  try {
    const guardado = localStorage.getItem(DEVICE_KEY)
    if (guardado) return guardado
    const nuevo = randomId()
    localStorage.setItem(DEVICE_KEY, nuevo)
    return nuevo
  } catch {
    // Almacenamiento bloqueado: se guarda en memoria para que al menos
    // sobreviva a la navegación dentro de la misma pestaña.
    memoriaDevice ||= randomId()
    return memoriaDevice
  }
}

let memoriaDevice = ''

/**
 * Toma el token del enlace, lo guarda y limpia la URL.
 * Si se vuelve a abrir la app sin `?s=`, sirve el que ya estaba guardado.
 */
export function readToken(): string {
  let token = ''
  try {
    const parametros = new URLSearchParams(window.location.search)
    token = (parametros.get('s') || '').trim()
  } catch {
    token = ''
  }

  if (token) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token)
    } catch { /* sin almacenamiento: se usa el de memoria */ }
    // Fuera de la barra de direcciones: ya está guardado.
    try {
      window.history.replaceState({}, '', window.location.pathname)
    } catch { /* algunos webviews lo impiden; no es crítico */ }
    return token
  }

  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

/** Se llama cuando el servidor rechaza la sesión: guardarla ya no sirve. */
export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch { /* nada que limpiar */ }
}
