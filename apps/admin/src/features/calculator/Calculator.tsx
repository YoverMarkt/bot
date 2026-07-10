import { useState } from 'react'
import { ClipboardList, DollarSign, Target, TrendingUp, Bot as BotIcon, Camera, Mic, MessageSquare, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Calculadora de precios — Modelo B (TODO INCLUIDO): tú absorbes el costo
// de Meta y cobras un solo pago mensual. Misma fórmula que el panel viejo:
// Meta cobra por mensaje SALIENTE (≈ la mitad de la conversación) y el
// colchón (%) cubre si el cliente conversa más de lo estimado.

const CALC = {
  chatPerMsg: 0.0006,  // respuesta de chat (input+output con RAG)
  visionPerImg: 0.004, // análisis de 1 foto
  audioPerMin: 0.006,  // Whisper; ~0.5 min por nota
  audioAvgMin: 0.5,
}

const money = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money0 = (v: number) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 })

const input = 'w-full rounded-lg bg-muted border border-input text-foreground px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
const label = 'text-xs font-medium text-muted-foreground'
const card = 'bg-card rounded-xl border p-5'

export default function Calculator() {
  const [f, setF] = useState({ clients: '1000', msgs: '8', photo: '20', audio: '15', wa: '0.01', buffer: '20', fixed: '11', mult: '3', price: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF(p => ({ ...p, [k]: e.target.value }))
  const num = (k: keyof typeof f) => Number(f[k]) || 0

  const n = num('clients'), m = num('msgs')
  const ph = num('photo') / 100, au = num('audio') / 100
  const wa = num('wa'), buf = num('buffer') / 100
  const fixed = num('fixed'), mult = num('mult') || 3

  const totalMsgs = n * m
  const outMsgs = Math.ceil(totalMsgs / 2) // Meta cobra lo SALIENTE (lo que envía el bot)
  const cChat = totalMsgs * CALC.chatPerMsg
  const cVision = n * ph * CALC.visionPerImg
  const cAudio = n * au * CALC.audioAvgMin * CALC.audioPerMin
  const cWa = outMsgs * wa * (1 + buf)
  const cTotal = cChat + cVision + cAudio + cWa + fixed
  const price = cTotal * mult
  const profit = price - cTotal

  const myPrice = num('price')
  const margin = myPrice - cTotal
  const marginPct = cTotal > 0 ? (margin / cTotal) * 100 : 0
  const realMult = cTotal > 0 ? myPrice / cTotal : 0
  const ok = margin > 0

  const rows = [
    { icon: BotIcon, name: `Chat IA (${totalMsgs.toLocaleString()} msgs)`, cost: cChat },
    { icon: Camera, name: `Visión (${Math.round(n * ph)} fotos)`, cost: cVision },
    { icon: Mic, name: `Audio (${Math.round(n * au)} notas)`, cost: cAudio },
    { icon: MessageSquare, name: `WhatsApp Meta (${outMsgs.toLocaleString()} salientes${buf > 0 ? ` +${Math.round(buf * 100)}% colchón` : ''})`, cost: cWa },
    { icon: Server, name: 'Fijos (hosting, dominio)', cost: fixed },
  ]

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-foreground mb-1">Calculadora de precios</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Modelo <strong className="text-foreground/80">todo incluido</strong>: un solo pago mensual, tú absorbes el costo de Meta
        (desde el 1 de octubre Meta cobra TODOS los mensajes salientes, incluidos los de servicio).
      </p>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Entradas */}
        <section className={card}>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><ClipboardList className="w-4 h-4" /> Datos del cliente</h2>
          <div className="grid grid-cols-2 gap-3">
            <div><span className={label}>Clientes que escriben al mes</span><Input className={input} type="number" value={f.clients} onChange={set('clients')} /></div>
            <div><span className={label}>Mensajes por conversación</span><Input className={input} type="number" value={f.msgs} onChange={set('msgs')} /></div>
            <div><span className={label}>% que envía FOTOS</span><Input className={input} type="number" value={f.photo} onChange={set('photo')} /></div>
            <div><span className={label}>% que envía AUDIOS</span><Input className={input} type="number" value={f.audio} onChange={set('audio')} /></div>
            <div>
              <span className={label}>Costo Meta por mensaje SALIENTE ($)</span>
              <Input className={input} type="number" step="0.001" value={f.wa} onChange={set('wa')} />
            </div>
            <div>
              <span className={label}>Colchón de seguridad Meta (%)</span>
              <Input className={input} type="number" step="5" value={f.buffer} onChange={set('buffer')} />
            </div>
            <div><span className={label}>Costos fijos mensuales ($)</span><Input className={input} type="number" value={f.fixed} onChange={set('fixed')} /></div>
            <div>
              <span className={label}>Multiplicador de precio</span>
              <div className="flex gap-1.5 items-center">
                {[3, 5, 8, 10].map(v => (
                  <Button variant="ghost" key={v} onClick={() => setF(p => ({ ...p, mult: String(v) }))}
                    className={`rounded-lg text-xs px-2.5 py-2 ${Number(f.mult) === v ? 'bg-primary text-foreground font-semibold' : 'border border-input text-foreground/80'}`}>
                    {v}x
                  </Button>
                ))}
                <Input className={`${input} !w-16 text-center font-bold`} type="number" step="0.5" value={f.mult} onChange={set('mult')} />
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/70 mt-3">
            El colchón te cubre si el cliente conversa más de lo estimado. Gracias a la regla de eficiencia
            (una sola respuesta completa por turno) no se paga de más.
          </p>
        </section>

        {/* Resultado */}
        <section className={card}>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><DollarSign className="w-4 h-4" /> Tu costo real</h2>
          <div className="space-y-1.5 text-sm">
            {rows.map(r => (
              <div key={r.name} className="flex justify-between">
                <span className="text-muted-foreground inline-flex items-center gap-1.5"><r.icon className="w-3.5 h-3.5" /> {r.name}</span>
                <span className="text-foreground/90 font-mono">{money(r.cost)}</span>
              </div>
            ))}
          </div>
          <hr className="border-border my-3" />
          <div className="flex justify-between text-sm"><span className="text-muted-foreground">Costo total/mes</span><strong className="text-foreground font-mono">{money(cTotal)}</strong></div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1"><span>Costo por cliente</span><span className="font-mono">{n ? money(cTotal / n) : '$0'}</span></div>
          <div className="mt-4 rounded-xl bg-primary/10 border border-primary/30 p-4 flex items-end justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-primary">Precio sugerido (todo incluido)</div>
              <div className="text-3xl font-extrabold text-foreground">{money(price)}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-muted-foreground">Ganancia/mes</div>
              <div className="text-lg font-bold text-primary">{money(profit)}</div>
            </div>
          </div>
        </section>

        {/* Precio manual */}
        <section className={card}>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><Target className="w-4 h-4" /> ¿Cuánto piensas cobrar?</h2>
          <Input className={input} type="number" value={f.price} onChange={set('price')} placeholder="Ej: 99" />
          {myPrice > 0 ? (
            <div className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Tu precio</span><strong className="text-foreground font-mono">{money(myPrice)}</strong></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Costo</span><span className="text-foreground/90 font-mono">{money(cTotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Ganancia</span><strong className={`font-mono ${ok ? 'text-primary' : 'text-destructive'}`}>{money(margin)}</strong></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Margen</span><span className={ok ? 'text-primary' : 'text-destructive'}>{marginPct.toFixed(0)}% ({realMult.toFixed(1)}x)</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">De tu precio, Meta se lleva</span><span className="text-foreground/90 font-mono">{money(cWa)} ({Math.round((cWa / myPrice) * 100)}%)</span></div>
              <div className={`mt-2 rounded-lg px-3 py-2 text-xs ${ok ? 'bg-primary/10 text-primary' : 'bg-red-600/10 text-destructive'}`}>
                {ok ? (marginPct >= 200 ? '✓ Excelente margen' : '✓ Rentable, pero podrías cobrar más') : 'Atención: Estás cobrando por debajo del costo'}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground/70 mt-3">Escribe tu precio para ver el margen exacto.</p>
          )}
        </section>

        {/* Proyección anual */}
        <section className={card}>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Proyección anual (precio sugerido)</h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Costo anual</span><span className="text-foreground/90 font-mono">{money0(cTotal * 12)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Ingreso anual</span><span className="text-foreground/90 font-mono">{money0(price * 12)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Ganancia anual</span><strong className="text-primary font-mono">{money0(profit * 12)}</strong></div>
            <hr className="border-border my-2" />
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Si tuvieras 10 empresas así</span><strong className="text-foreground font-mono">{money0(profit * 12 * 10)}/año</strong></div>
          </div>
        </section>
      </div>
    </div>
  )
}
