// ── MOTOR DE ALARMA (port fiel del panel viejo) ─────────────────────
// Dos motores de audio:
//   1) Web Audio (webBeep) → suena fuerte en primer plano
//   2) <audio> WAV en bucle → sigue sonando con la pestaña en segundo plano
// + parpadeo del título de la pestaña.

let alarmAudio: HTMLAudioElement | null = null
let audioCtx: AudioContext | null = null

// 1s de tono alterno (880↔1175 Hz) en WAV → se reproduce en bucle
function buildAlarmUrl(): string {
  const sr = 44100, n = sr
  const ab = new ArrayBuffer(44 + n * 2), dv = new DataView(ab)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  w(36, 'data'); dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const f = (t % 0.5) < 0.25 ? 880 : 1175
    dv.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * t) * 0.85 * 32767, true)
  }
  return URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }))
}

export function initAlarmAudio() {
  if (!alarmAudio) {
    alarmAudio = new Audio(buildAlarmUrl())
    alarmAudio.loop = true
    alarmAudio.volume = 1
  }
  if (!audioCtx) {
    try { audioCtx = new AudioContext() } catch { /* navegador sin soporte */ }
  }
}

// El navegador bloquea audio hasta la primera interacción — esto lo desbloquea
export function unlockAudio() {
  initAlarmAudio()
  try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume() } catch { /* ignorar */ }
}

export function webBeep() {
  if (!audioCtx) return
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume()
    ;[988, 1319, 988, 1319].forEach((f, i) => {
      const o = audioCtx!.createOscillator(), g = audioCtx!.createGain()
      o.type = 'square'; o.frequency.value = f; o.connect(g); g.connect(audioCtx!.destination)
      const t = audioCtx!.currentTime + i * 0.18
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
      o.start(t); o.stop(t + 0.18)
    })
  } catch { /* ignorar */ }
}

export function playAlarm() {
  initAlarmAudio()
  webBeep()
  try { alarmAudio!.currentTime = 0; alarmAudio!.play().catch(() => {}) } catch { /* ignorar */ }
}

export function stopAlarmSound() {
  if (!alarmAudio) return
  try { alarmAudio.pause(); alarmAudio.currentTime = 0 } catch { /* ignorar */ }
}

// Botón de prueba: desbloquea el audio y verifica que suena (3s)
export function testAlarmSound(onOk: () => void, onBlocked: (msg: string) => void) {
  initAlarmAudio()
  unlockAudio()
  webBeep()
  alarmAudio!.currentTime = 0
  alarmAudio!.play().then(() => {
    onOk()
    setTimeout(() => { alarmAudio!.pause(); alarmAudio!.currentTime = 0 }, 3000)
  }).catch(e => onBlocked(e?.name || e?.message || 'permiso'))
}

// ── Parpadeo del título de la pestaña ──
let titleFlashTimer: ReturnType<typeof setInterval> | null = null
const ORIG_TITLE = document.title

export function startTitleFlash() {
  if (titleFlashTimer) return
  let on = false
  titleFlashTimer = setInterval(() => {
    document.title = on ? '🔔 ¡ATENCIÓN! · BotPanel' : ORIG_TITLE
    on = !on
  }, 1000)
}

export function stopTitleFlash() {
  if (titleFlashTimer) clearInterval(titleFlashTimer)
  titleFlashTimer = null
  document.title = ORIG_TITLE
}
