import { useRef, useState } from 'react'
import { api } from '../../api/client'
import { Trash2, MessageSquare, Store } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'

// ═══════════════════════════════════════════════════════════════════════════
// SIMULADOR DEL MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════════
//
// Escribir al número de Umbani sin gastar un mensaje de WhatsApp.
//
// ⚠️ Ya no hay selector de negocio, y no es una simplificación: en el
// marketplace el local NO lo elige el superadmin, lo elige el cliente
// navegando el menú. Hasta el 2026-08-23 esta pantalla pedía un negocio y
// despachaba por su `chat_mode`, así que con el único local de producción en
// `miniapp` respondía «en el canal real, aquí se envía el enlace personal de la
// tienda» — una rama por la que no entra nadie. Ahora corre la MISMA función
// que atiende el webhook, con los datos de verdad.

type Msg = { role: 'user' | 'bot' | 'note'; text: string; options?: string[] | null; at: string }

const now = () => new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })

export default function Simulator() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const scroll = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)

  // fromOption: texto de un botón del menú guiado; tocar uno equivale a escribirlo
  async function send(fromOption?: string) {
    const t = (fromOption ?? text).trim()
    if (!t || typing) return
    if (!fromOption) setText('')
    setMsgs(m => [...m, { role: 'user', text: t, at: now() }])
    setTyping(true)
    scroll()
    try {
      // El checkout puede mandar dos mensajes seguidos (confirmación + paso
      // siguiente), igual que en WhatsApp: por eso llegan en lista.
      const d = await api<{ replies?: { reply: string; options: string[] }[]; notes?: string[] }>('/api/admin/simulate', {
        method: 'POST',
        body: JSON.stringify({ message: t }),
      })
      for (const r of d.replies || []) {
        setMsgs(m => [...m, { role: 'bot', text: r.reply, options: r.options, at: now() }])
      }
      // Notas del simulador: lo que en el canal real SÍ ocurriría y aquí no.
      for (const note of d.notes || []) {
        setMsgs(m => [...m, { role: 'note', text: note, at: now() }])
      }
    } catch (e) {
      setMsgs(m => [...m, { role: 'bot', text: `Atención: Error de conexión: ${e instanceof Error ? e.message : e}`, at: now() }])
    }
    setTyping(false)
    scroll()
  }

  async function clear() {
    await api('/api/admin/simulate/history', { method: 'DELETE' })
    setMsgs([])
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Simulador del marketplace</h1>
          <p className="text-sm text-muted-foreground">
            Escribe como un cliente al número de Umbani, sin gastar un mensaje de WhatsApp
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
          <ConfirmAction
            trigger={<Button variant="outline"><Trash2 className="w-4 h-4" /> Empezar de cero</Button>}
            title="Reiniciar la conversación de prueba"
            description="Vuelve al menú de categorías y suelta el local y el carrito, igual que cuando un cliente escribe MENÚ."
            confirmLabel="Empezar de cero"
            destructive
            onConfirm={clear}
          />
        </div>
      </div>

      <Card className="flex-1 min-h-0 py-0 gap-0 overflow-hidden">
        {/* Barra del chat */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/20 font-bold text-primary">
            <Store className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">Umbani</div>
            {/* ⚠️ Decirlo aquí y no en una nota escondida: el enlace que
                devuelve es de VERDAD y se puede abrir, y para poder crearlo
                el local acaba con un cliente de prueba (000000000000) en su
                ficha. Es el precio de que el enlace sirva; enterarse después
                sería peor. */}
            <div className="text-xs text-muted-foreground">
              Catálogo, precios y locales REALES · el pedido no se crea
            </div>
          </div>
        </div>

        {/* Mensajes */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!msgs.length && !typing && (
            <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground/70 text-sm gap-2 px-6">
              <MessageSquare className="w-8 h-8 text-muted-foreground" />
              <p>Escribe cualquier cosa —«hola», «quiero pizza»— como si fueras un cliente.</p>
              <p className="text-xs">Escribe <strong>MENÚ</strong> en cualquier momento para volver al principio.</p>
            </div>
          )}
          {msgs.map((m, i) => m.role === 'note' ? (
            <div key={i} className="flex justify-center">
              <div className="max-w-[85%] rounded-lg border border-dashed border-border bg-muted/50 px-3 py-1.5 text-center text-xs text-muted-foreground whitespace-pre-wrap">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              {m.text && (
                <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  m.role === 'user' ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-muted text-foreground rounded-bl-sm'
                }`}>
                  {m.text}
                </div>
              )}
              {!!m.options?.length && (
                <div className="mt-2 flex max-w-[75%] flex-col items-start gap-1.5">
                  {m.options.map(o => (
                    <Button key={o} variant="outline" size="sm" disabled={typing}
                      className="h-auto max-w-full justify-start rounded-xl border-primary/40 px-3 py-1.5 text-left text-xs font-medium text-primary hover:bg-primary/10"
                      onClick={() => send(o)}>
                      {o}
                    </Button>
                  ))}
                </div>
              )}
              <span className="text-[10px] text-muted-foreground/70 mt-1">{m.at}</span>
            </div>
          ))}
          {typing && (
            <div className="flex items-start">
              <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1.5">
                {[0, 1, 2].map(i => (
                  <span key={i} className="w-2 h-2 rounded-full bg-stone-500 animate-bounce motion-reduce:animate-none" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Input */}
        <div className="flex gap-2 p-3 border-t border-border">
          <Input id="simulator-message" aria-label="Mensaje para el bot" value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="Escribe un mensaje… (Enter para enviar)" className="flex-1" />
          <Button onClick={() => send()} disabled={typing || !text.trim()}>
            Enviar
          </Button>
        </div>
      </Card>
    </div>
  )
}
