const CALENDAR_TYPES = [
  'barbería', 'barberia', 'peluquería', 'peluqueria', 'salón', 'salon',
  'spa', 'masajes', 'estética', 'estetica', 'uñas', 'maquillaje',
  'clínica', 'clinica', 'consultorio', 'médico', 'medico', 'dentista',
  'odontología', 'odontologia', 'fisioterapia', 'psicología', 'psicologia',
  'gym', 'gimnasio', 'entrenador', 'yoga', 'pilates',
  'restaurante', 'café', 'cafeteria', 'reservas', 'hotel',
] as const

export function businessNeedsCalendar(businessType: string | null | undefined): boolean {
  if (!businessType) return false
  const normalizedType = businessType.toLocaleLowerCase('es')
  return CALENDAR_TYPES.some((keyword) => normalizedType.includes(keyword))
}
