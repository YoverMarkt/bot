import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { getClients } from '../clients/api'
import { Trash2, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Simulador de bot — prueba el bot de cualquier negocio SIN WhatsApp real.
// Usa el mismo motor que el bot real (POST /api/admin/simulate).

type Msg = { role: 'user' | 'bot'; text: string; image?: string | null; at: string }

const now = () => new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })

export default function Simulator() {
  const { data: clients = [] } = useQuery({ queryKey: ['adm-clients'], queryFn: getClients })
  const [bizId, setBizId] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const biz = clients.find(c => c.id === bizId)
  const scroll = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)

  function selectBiz(id: string) {
    setBizId(id)
    setMsgs([])
  }

  async function send() {
    const t = text.trim()
    if (!t || !bizId || typing) return
    setText('')
    setMsgs(m => [...m, { role: 'user', text: t, at: now() }])
    setTyping(true)
    scroll()
    try {
      const d = await api<{ reply?: string; image?: string | null }>('/api/admin/simulate', {
        method: 'POST',
        body: JSON.stringify({ business_id: bizId, message: t }),
      })
      if (d.reply) setMsgs(m => [...m, { role: 'bot', text: d.reply!, image: d.image, at: now() }])
    } catch (e) {
      setMsgs(m => [...m, { role: 'bot', text: `Atención: Error de conexión: ${e instanceof Error ? e.message : e}`, at: now() }])
    }
    setTyping(false)
    scroll()
  }

  async function clear() {
    if (!bizId || !confirm('¿Limpiar la conversación de prueba?')) return
    await api(`/api/admin/simulate/${bizId}/history`, { method: 'DELETE' })
    setMsgs([])
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Simulador de Bot</h1>
          <p className="text-sm text-muted-foreground">Prueba el bot de cualquier negocio sin WhatsApp real</p>
        </div>
        <div className="flex gap-2">
          <select value={bizId} onChange={e => selectBiz(e.target.value)}
            className="rounded-lg bg-muted border border-input text-foreground px-3 py-2 text-sm min-w-56 focus:outline-none focus:ring-2 focus:ring-ring">
            <option value="">— Elige un negocio —</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {bizId && (
            <Button variant="outline" onClick={clear}><span className="inline-flex items-center gap-1.5"><Trash2 className="w-4 h-4" /> Limpiar chat</span></Button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col bg-card rounded-xl border overflow-hidden">
        {/* Barra del chat */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card">
          <div className="w-9 h-9 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold">
            {biz ? biz.name.charAt(0).toUpperCase() : '🤖'}
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">{biz?.name || 'Ningún negocio seleccionado'}</div>
            <div className="text-xs text-muted-foreground">{biz ? `${biz.type || '—'} · ${biz.whatsapp_number || ''}` : 'Elige un negocio del menú para comenzar'}</div>
          </div>
        </div>

        {/* Mensajes */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!msgs.length && !typing && (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground/70 text-sm gap-2">
              <MessageSquare className="w-8 h-8 text-muted-foreground" />
              <p>{biz ? 'Escribe un mensaje como si fueras un cliente.' : 'Selecciona un negocio para probar su bot.'}</p>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                m.role === 'user' ? 'bg-primary text-foreground rounded-br-sm' : 'bg-muted text-stone-100 rounded-bl-sm'
              }`}>
                {m.text}
              </div>
              {m.image && (
                <img src={m.image} alt="" className="mt-2 max-w-56 rounded-xl border border-input"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
              )}
              <span className="text-[10px] text-muted-foreground/70 mt-1">{m.at}</span>
            </div>
          ))}
          {typing && (
            <div className="flex items-start">
              <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1.5">
                {[0, 1, 2].map(i => (
                  <span key={i} className="w-2 h-2 rounded-full bg-stone-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Input */}
        <div className="flex gap-2 p-3 border-t border-border">
          <Input value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            disabled={!bizId}
            placeholder={bizId ? 'Escribe un mensaje… (Enter para enviar)' : 'Selecciona un negocio primero'} className="flex-1" />
          <Button onClick={send} disabled={!bizId || typing || !text.trim()}>
            Enviar
          </Button>
        </div>
      </div>
    </div>
  )
}
