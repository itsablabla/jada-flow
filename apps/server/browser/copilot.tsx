import './copilot.css'
import type { FormEvent } from 'react'

import { Button, Textarea } from '@oomol-lab/open-flow/ui'
import { useEffect, useRef, useState } from 'react'
import { idempotencyKey } from './idempotency.ts'

interface Turn {
  turnId: string
  status: string
  message: string
  answer: string
  revisionId: string | null
}
interface CopilotEvent {
  cursor: number
  turnId: string
  kind: string
  delta?: string
  name?: string
}

export function JadaLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" width="26" height="26" className="jada-logo">
      <path d="M8 7h16v10c0 7-4 10-10 10-4 0-7-2-8-5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="7" r="3" fill="currentColor" />
      <circle cx="24" cy="7" r="3" fill="currentColor" />
      <circle cx="6" cy="22" r="3" fill="currentColor" />
    </svg>
  )
}

export function CopilotPanel({ flowId, onClose, onConfigure }: { flowId: string; onClose(): void; onConfigure(): void }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [configured, setConfigured] = useState(true)
  const [pending, setPending] = useState(false)
  const [stream, setStream] = useState<Record<string, string>>({})
  const [activity, setActivity] = useState('Ready to build')
  const after = useRef(0)
  const conversation = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const endpoint = `/v1/flows/${encodeURIComponent(flowId)}/copilot`
  const running = turns.some((turn) => turn.status === 'running')

  useEffect(() => {
    if (following.current && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight
  }, [turns, stream])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const response = await fetch(`${endpoint}?after=${after.current}`, { credentials: 'same-origin', signal: controller.signal })
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to continue.' : 'Could not load this conversation.')
        const data: { turns: Turn[]; configured: boolean; events: CopilotEvent[] } = await response.json()
        setTurns(data.turns)
        setConfigured(data.configured)
        for (const event of data.events) {
          after.current = Math.max(after.current, event.cursor)
          if (event.kind === 'text' && event.delta) setStream((value) => ({ ...value, [event.turnId]: (value[event.turnId] ?? '') + event.delta }))
          if (event.kind === 'tool') setActivity(event.name?.replaceAll('_', ' ') ?? 'Working')
          if (event.kind === 'saved') setActivity('Workflow saved')
        }
        if (!data.turns.some((turn) => turn.status === 'running')) setActivity('Ready to build')
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Connection unavailable.')
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 700)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [endpoint])

  async function send(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim() || pending || running) return
    setPending(true)
    following.current = true
    setError('')
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: draft.trim(), requestId: idempotencyKey() }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error?.message ?? data?.error ?? 'Could not start. Check the model connection and try again.')
      }
      setDraft('')
      setActivity('Starting Pipali')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start.')
    } finally {
      setPending(false)
    }
  }

  async function stop() {
    const response = await fetch(`${endpoint}/stop`, { method: 'POST', credentials: 'same-origin' })
    if (!response.ok) setError('Could not stop this turn. Try again.')
  }

  return (
    <aside className="jada-copilot" aria-label="Pipali workflow copilot">
      <header className="jada-copilot-header">
        <div>
          <strong>Pipali copilot</strong>
          <span>Describe it. See it. Refine it.</span>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>
      <div
        className="jada-conversation"
        aria-live="polite"
        ref={conversation}
        onScroll={(event) => {
          const box = event.currentTarget
          following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80
        }}
      >
        {turns.length === 0 && (
          <div className="jada-copilot-intro">
            <JadaLogo />
            <h2>What should this workflow do?</h2>
            <p>I can build and edit the real workflow on your canvas, write code, and help connect its steps.</p>
            <button
              onClick={() =>
                setDraft('Build a manual workflow that adds 17 and 25 in a Code Task, then passes the result to an Agent that returns structured JSON.')
              }
            >
              Build a calculation with an Agent
            </button>
            <button
              onClick={() =>
                setDraft(
                  'Build a support-request workflow that drafts a reply and requires human approval before sending. Ask me which connections are missing.',
                )
              }
            >
              Draft a reply, then ask for approval
            </button>
          </div>
        )}
        {turns.map((turn) => (
          <section className="jada-turn" key={turn.turnId}>
            <div className="jada-user-message">{turn.message}</div>
            <div className="jada-agent-message">{turn.answer || stream[turn.turnId] || (turn.status === 'running' ? activity : 'No response recorded.')}</div>
            <div className="jada-turn-status" data-status={turn.status}>
              {turn.status === 'completed'
                ? 'Saved and validated · not executed'
                : turn.status === 'draft'
                  ? 'Draft saved · needs attention'
                  : turn.status === 'needs-input'
                    ? 'Waiting for your answer or connection'
                    : turn.status === 'running'
                      ? 'Pipali is working'
                      : turn.status}
            </div>
            {turn.status === 'needs-input' && (
              <Button variant="outline" onClick={onConfigure}>
                Open connection settings
              </Button>
            )}
          </section>
        ))}
      </div>
      <form className="jada-composer" onSubmit={(event) => void send(event)}>
        {(!configured || error) && (
          <div role="alert" className="jada-copilot-error">
            {error || 'Configure a model connection to use Pipali.'}
            {!configured && (
              <Button variant="outline" onClick={onConfigure}>
                Open Settings
              </Button>
            )}
          </div>
        )}
        <Textarea
          aria-label="Describe your workflow"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Tell Pipali what you want to automate…"
          rows={3}
          disabled={pending}
        />
        <div className="jada-composer-actions">
          <span>Changes save to this draft. Publishing stays in your control.</span>
          {running ? (
            <Button type="button" variant="outline" onClick={() => void stop()}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!draft.trim() || pending || !configured}>
              {pending ? 'Starting…' : 'Build'}
            </Button>
          )}
        </div>
      </form>
    </aside>
  )
}
