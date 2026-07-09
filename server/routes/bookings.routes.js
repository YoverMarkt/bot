// ── RUTAS: HORARIOS Y RESERVAS (citas) ───────────────────────────────
// Extraído de index.js (Fase 1 de ARQUITECTURA.md) SIN cambios de
// comportamiento. Aislamiento multi-tenant: business_id SIEMPRE del JWT.
const express = require('express')
const db      = require('../db')
const { sendToContact } = require('../services/notify')
const { authClient, requirePermission } = require('../middleware/auth')

const router = express.Router()

// ── HORARIOS ──────────────────────────────────────────────
router.get('/api/client/schedule',  authClient, requirePermission('citas'), async (req, res) => res.json(await db.getSchedule(req.user.businessId)))
router.put('/api/client/schedule',  authClient, requirePermission('citas'), async (req, res) => { await db.upsertSchedule(req.user.businessId, req.body.days); res.json({ ok: true }) })

// ── RESERVAS ──────────────────────────────────────────────
router.get('/api/client/bookings',  authClient, requirePermission('citas'), async (req, res) => res.json(await db.getBookings(req.user.businessId, req.query.from, req.query.to)))
router.put('/api/client/bookings/:id/status', authClient, requirePermission('citas'), async (req, res) => {
  const { status } = req.body
  if (!['pending', 'confirmed', 'cancelled', 'no_show'].includes(status)) return res.status(400).json({ error: 'Estado inválido' })
  try {
    const booking = await db.getBookingById(req.params.id)
    // Aislamiento: la reserva debe pertenecer a ESTE negocio
    if (!booking || booking.business_id !== req.user.businessId) return res.status(404).json({ error: 'Reserva no encontrada' })
    await db.updateBookingStatus(req.user.businessId, req.params.id, status)

    // Notificar al cliente por su canal (no bloquea la respuesta si falla)
    if (booking && booking.contact_phone) {
      const biz = await db.getBusinessById(req.user.businessId)
      const fecha = booking.booking_date
      const hora  = (booking.booking_time || '').slice(0, 5)
      const svc   = booking.service ? ` de *${booking.service}*` : ''
      let msg = null
      if (status === 'confirmed') {
        msg = `✅ ¡Tu cita${svc} quedó *confirmada* para el ${fecha} a las ${hora}! Te esperamos en ${biz.name} 😊`
      } else if (status === 'cancelled') {
        msg = `⚠️ Lamentamos informarte que tu cita${svc} del ${fecha} a las ${hora} fue *cancelada*. Si deseas, podemos agendarte en otro horario disponible. Escríbenos cuándo te conviene 🙏`
      }
      if (msg) {
        sendToContact(biz, booking.contact_phone, msg)
          .then(() => db.saveMessage(biz.id, booking.contact_phone, 'owner', msg))
          .catch(e => console.error('❌ Notificación de reserva:', e.message))
      }
    }
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
