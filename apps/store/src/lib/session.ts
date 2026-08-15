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

/**
 * La clave del token es POR NEGOCIO.
 *
 * ⚠️ Era una sola para toda la app, así que abrir la tienda de un segundo
 * local pisaba el token del primero: el cliente volvía al primero y se
 * encontraba con «este enlace no es válido», sin haber hecho nada raro. Cada
 * enlace pertenece a un negocio, y su token también.
 *
 * La clave vieja se sigue leyendo como respaldo —ver `readToken`— para no
 * echar a la calle a quien ya tuviera su sesión guardada.
 */
const tokenKeyFor = (slug: string): string => (
  slug ? `${TOKEN_KEY}:${slug}` : TOKEN_KEY
)

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
export function randomId(): string {
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
 *
 * ⚠️ `localStorage`, no `sessionStorage`. Estuvo en sessionStorage hasta el
 * 2026-08-02 y ese era el límite REAL del enlace, no las 6 horas que decía el
 * mensaje: sessionStorage se vacía al cerrar la pestaña, y el webview de
 * WhatsApp se cierra cada vez que el cliente vuelve al chat. Volver al día
 * siguiente —o al minuto siguiente, tras mirar el chat— mostraba «Necesitas tu
 * propio enlace» aunque el enlace estuviera perfectamente vivo en el servidor.
 *
 * El token se sigue quitando de la barra de direcciones: una captura de
 * pantalla compartida en un grupo no puede regalar la sesión. Y como ahora se
 * guarda de verdad, quitarlo de la URL ya no cuesta nada — el enlace en
 * favoritos funciona igual porque el token vive en el teléfono.
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
      localStorage.setItem(tokenKeyFor(readSlug()), token)
      // Restos de la época de sessionStorage y de la clave única: si no se
      // limpian, un token viejo podría ganarle al nuevo al leer.
      sessionStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(TOKEN_KEY)
    } catch { /* sin almacenamiento: se usa el de memoria */ }
    // Fuera de la barra de direcciones: ya está guardado.
    try {
      window.history.replaceState({}, '', window.location.pathname)
    } catch { /* algunos webviews lo impiden; no es crítico */ }
    return token
  }

  try {
    // Se mira también el almacén viejo para no echar a la calle a quien tenga
    // la app abierta justo durante el despliegue.
    // El de ESTE negocio primero. Las dos claves viejas quedan de respaldo
    // para quien ya tuviera su sesión guardada antes de separarlas: si el
    // token no es de este negocio, el servidor responde 401 y la app lleva a
    // pedir el enlace, que es lo que habría pasado igualmente.
    return localStorage.getItem(tokenKeyFor(readSlug()))
      || localStorage.getItem(TOKEN_KEY)
      || sessionStorage.getItem(TOKEN_KEY)
      || ''
  } catch {
    return ''
  }
}

/** Se llama cuando el servidor rechaza la sesión: guardarla ya no sirve. */
export function clearToken(): void {
  try {
    localStorage.removeItem(tokenKeyFor(readSlug()))
    localStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
  } catch { /* nada que limpiar */ }
}
