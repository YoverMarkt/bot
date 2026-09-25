// ═══════════════════════════════════════════════════════════════════════════
// UN CORREO QUE YA TIENE CUENTA
// ═══════════════════════════════════════════════════════════════════════════
//
// El correo con el que se entra al panel es único en TODA la plataforma
// (`client_users_email_key`): el de un dueño no puede repetirse en otro local,
// ni el de un empleado.
//
// ⚠️ Nace el 2026-09-24. El dueño intentó cinco veces dar de alta un local en
// staging y la respuesta fue «Ese dato ya está registrado en otro negocio y
// debe ser único»: no decía CUÁL. Era el correo —el navegador lo había
// rellenado solo con una cuenta guardada— y hubo que buscarlo en el registro
// de la base. Al crear un empleado era peor: le llegaba el error crudo de
// PostgreSQL, en inglés.
//
// Sirve con los dos sabores de error que llegan aquí: el `Error` que lanza
// `assertDatabaseResult` y el objeto de error que devuelve supabase-js. Los dos
// llevan el nombre de la restricción en el mensaje.

export function esCorreoRepetido(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const mensaje = (error as { message?: unknown }).message
  return typeof mensaje === 'string' && /client_users_email_key/.test(mensaje)
}
