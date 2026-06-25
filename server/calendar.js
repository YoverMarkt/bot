// Business types that benefit from calendar/booking
const CALENDAR_TYPES = [
  'barbería', 'barberia', 'peluquería', 'peluqueria', 'salón', 'salon',
  'spa', 'masajes', 'estética', 'estetica', 'uñas', 'maquillaje',
  'clínica', 'clinica', 'consultorio', 'médico', 'medico', 'dentista',
  'odontología', 'odontologia', 'fisioterapia', 'psicología', 'psicologia',
  'gym', 'gimnasio', 'entrenador', 'yoga', 'pilates',
  'restaurante', 'café', 'cafeteria', 'reservas', 'hotel'
]

function businessNeedsCalendar(bizType) {
  if (!bizType) return false
  const t = bizType.toLowerCase()
  return CALENDAR_TYPES.some(k => t.includes(k))
}

module.exports = { businessNeedsCalendar }
