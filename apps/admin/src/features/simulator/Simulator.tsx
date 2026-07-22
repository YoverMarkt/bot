import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { getClients } from '../clients/api'
import { Trash2, MessageSquare, Bot as BotIcon } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'

// Simulador de bot — prueba el bot de cualquier negocio SIN WhatsApp real.
// Usa el mismo motor que el bot real (POST /api/admin/simulate).

// El servidor manda las opciones como texto simple o como {título, descripción},
// igual que una fila de lista de WhatsApp.
type MenuOption = string | { title: string; description?: string }
const optionTitle = (option: MenuOption) => typeof option === 'string' ? option : option.title
const optionDetail = (option: MenuOption) => typeof option === 'string' ? '' : (option.description || '')

type Msg = { role: 'user' | 'bot' | 'note'; text: string; image?: string | null; video?: string | null; options?: MenuOption[] | null; at: string }

const now = () => new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })

export default function Simulator() {
  const { data: clients = [] } = useQuery({ queryKey: ['adm-clients'], queryFn: getClients })
  const [bizId, setBizId] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  // Arranca en el modo REAL del negocio para que probar sea igual a lo que
  // recibe el cliente. El interruptor queda para comparar a propósito.
  const [mode, setMode] = useState<'menu' | 'ai'>('ai')
  const endRef = useRef<HTMLDivElement>(null)

  const biz = clients.find(c => c.id === bizId)
  const scroll = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)

  // Modo configurado del negocio (lo que de verdad usa en WhatsApp)
  const realMode: 'menu' | 'ai' = biz?.chat_mode === 'menu' ? 'menu' : 'ai'
  const testingOtherMode = Boolean(biz) && mode !== realMode

  function selectBiz(id: string) {
    setBizId(id)
    setMsgs([])
    // Al elegir negocio se adopta SU modo real: lo que pruebas es lo que recibe
    const chosen = clients.find(c => c.id === id)
    setMode(chosen?.chat_mode === 'menu' ? 'menu' : 'ai')
  }

  // fromOption: texto de un botón del menú guiado; tocar uno equivale a escribirlo
  async function send(fromOption?: string) {
    const t = (fromOption ?? text).trim()
    if (!t || !bizId || typing) return
    if (!fromOption) setText('')
    setMsgs(m => [...m, { role: 'user', text: t, at: now() }])
    setTyping(true)
    scroll()
    try {
      const d = await api<{ reply?: string; image?: string | null; video?: string | null; options?: MenuOption[] | null; mediaNote?: string | null; actionNote?: string | null }>('/api/admin/simulate', {
        method: 'POST',
        body: JSON.stringify({ business_id: bizId, message: t, mode }),
      })
      if (d.reply) setMsgs(m => [...m, { role: 'bot', text: d.reply!, image: d.image, video: d.video, options: d.options, at: now() }])
      // La nota de media ("no tengo foto de ese producto…") llega como
      // mensaje aparte, igual que en WhatsApp/Telegram.
      if (d.mediaNote) setMsgs(m => [...m, { role: 'bot', text: d.mediaNote!, at: now() }])
      // Nota del simulador: explica la acción interna detectada (el cliente real no la ve)
      if (d.actionNote) setMsgs(m => [...m, { role: 'note', text: d.actionNote!, at: now() }])
    } catch (e) {
      setMsgs(m => [...m, { role: 'bot', text: `Atención: Error de conexión: ${e instanceof Error ? e.message : e}`, at: now() }])
    }
    setTyping(false)
    scroll()
  }

  async function clear() {
    if (!bizId) return
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
          {/* Modo de conversación: menú guiado (sin IA) o IA conversacional */}
          {/* El modo configurado del negocio lleva un punto: si pruebas el otro,
              se avisa para no confundir la prueba con lo que recibe el cliente */}
          <div className="flex overflow-hidden rounded-lg border border-border">
            {(['menu', 'ai'] as const).map(option => (
              <button key={option} type="button" onClick={() => setMode(option)}
                title={realMode === option ? 'Modo configurado de este negocio' : 'Solo para comparar: no es el modo real'}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${mode === option ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}>
                {option === 'menu' ? 'Modo menú' : 'Modo IA'}
                {biz && realMode === option && <span className="ml-1.5">•</span>}
              </button>
            ))}
          </div>
          <Select value={bizId} onValueChange={selectBiz}>
            <SelectTrigger id="simulator-business" aria-label="Negocio para simular" className="min-w-56"><SelectValue placeholder="— Elige un negocio —" /></SelectTrigger>
            <SelectContent>
              {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {bizId && (
            <ConfirmAction
              trigger={<Button variant="outline"><Trash2 className="w-4 h-4" /> Limpiar chat</Button>}
              title="Limpiar conversación de prueba"
              description="Se eliminará el historial del simulador para este negocio."
              confirmLabel="Limpiar chat"
              destructive
              onConfirm={clear}
            />
          )}
        </div>
      </div>

      <Card className="flex-1 min-h-0 py-0 gap-0 overflow-hidden">
        {/* Barra del chat */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card">
          <div className="w-9 h-9 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold">
            {biz ? biz.name.charAt(0).toUpperCase() : <BotIcon className="w-4 h-4" />}
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">{biz?.name || 'Ningún negocio seleccionado'}</div>
            <div className="text-xs text-muted-foreground">{biz ? `${biz.type || '—'} · ${biz.whatsapp_number || ''}` : 'Elige un negocio del menú para comenzar'}</div>
          </div>
          {testingOtherMode && (
            <div className="ml-auto rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400">
              ⚠️ Estás probando <strong>{mode === 'menu' ? 'Modo menú' : 'Modo IA'}</strong>, pero en WhatsApp este negocio usa <strong>{realMode === 'menu' ? 'Modo menú' : 'Modo IA'}</strong>
            </div>
          )}
        </div>

        {/* Mensajes */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!msgs.length && !typing && (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground/70 text-sm gap-2">
              <MessageSquare className="w-8 h-8 text-muted-foreground" />
              <p>{biz ? 'Escribe un mensaje como si fueras un cliente.' : 'Selecciona un negocio para probar su bot.'}</p>
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
              <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                m.role === 'user' ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-muted text-foreground rounded-bl-sm'
              }`}>
                {m.text}
              </div>
              {m.image && (
                <img src={m.image} alt="" className="mt-2 max-w-56 rounded-xl border border-input"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
              )}
              {m.video && (
                <video src={m.video} controls className="mt-2 max-w-56 rounded-xl border border-input" />
              )}
              {/* Opciones del menú guiado (estilo respuestas rápidas de WhatsApp) */}
              {!!m.options?.length && (
                <div className="mt-2 flex max-w-[75%] flex-col items-start gap-1.5">
                  {m.options.map(o => (
                    <Button key={optionTitle(o)} variant="outline" size="sm" disabled={typing}
                      className="h-auto max-w-full flex-col items-start gap-0 rounded-xl border-primary/40 px-3 py-1.5 text-left hover:bg-primary/10"
                      onClick={() => send(optionTitle(o))}>
                      <span className="text-xs font-medium text-primary">{optionTitle(o)}</span>
                      {optionDetail(o) && (
                        <span className="text-[11px] font-normal text-muted-foreground">{optionDetail(o)}</span>
                      )}
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
            disabled={!bizId}
            placeholder={bizId ? 'Escribe un mensaje… (Enter para enviar)' : 'Selecciona un negocio primero'} className="flex-1" />
          <Button onClick={() => send()} disabled={!bizId || typing || !text.trim()}>
            Enviar
          </Button>
        </div>
      </Card>
    </div>
  )
}
