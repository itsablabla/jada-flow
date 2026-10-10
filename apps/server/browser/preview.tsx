import 'virtual:uno.css'
import '@oomol-lab/open-flow/workbench.css'
import './host-ui.css'
import './styles.css'
import './preview.css'
import type { WorkbenchLocation } from '@oomol-lab/open-flow/workbench'

import { Button, notificationToasterProps } from '@oomol-lab/open-flow/ui'
import { OpenFlowWorkbench } from '@oomol-lab/open-flow/workbench'
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { I18nProvider } from 'val-i18n-react'
import { CopilotPanel, JadaLogo } from './copilot.tsx'
import { createBrowserHost } from './host.ts'
import { createI18n } from './i18n.ts'
import { notify } from './notifications.ts'

const port = '__PORT_7310__'
const apiBase = port.startsWith('__') ? 'http://127.0.0.1:7310' : new URL(port, document.baseURI).href.replace(/\/$/, '')

function fromHash(): WorkbenchLocation {
  const params = new URLSearchParams(location.hash.slice(1))
  const view = params.get('view')
  return {
    view: view === 'runs' || view === 'publications' ? view : 'design',
    ...(params.get('flow') ? { flowId: params.get('flow')! } : {}),
    ...(params.get('run') ? { runId: params.get('run')! } : {}),
  }
}

function hrefFor(where: WorkbenchLocation): string {
  const params = new URLSearchParams({ view: where.view })
  if (where.flowId) params.set('flow', where.flowId)
  if (where.runId) params.set('run', where.runId)
  return `#${params}`
}

function Preview() {
  const [i18n] = useState(() => createI18n('en'))
  const [session, setSession] = useState<{ userId: string; flowId: string }>()
  const [where, setWhere] = useState<WorkbenchLocation>(fromHash)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  const [panel, setPanel] = useState(true)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const preferences = useMemo(() => {
    const values = new Map<string, string>()
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
  }, [])
  const host = useMemo(() => {
    const native = createBrowserHost(notify, () => setError('Preview access needs refreshing. Reload this page.'), undefined, apiBase)
    return {
      ...native,
      async openExternalPage() {
        setNotice('External authorization pages are disabled in this private preview. Use the full self-hosted app to connect external services.')
        return false
      },
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void fetch(`${apiBase}/preview/session`, { method: 'POST', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        const value = await response.json()
        if (!response.ok) throw new Error(value.detail ?? value.error ?? 'Could not open the preview.')
        setSession(value)
        if (!fromHash().flowId) {
          const initial: WorkbenchLocation = { flowId: value.flowId, view: 'design' }
          location.hash = hrefFor(initial)
          setWhere(initial)
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not connect.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const update = () => setWhere(fromHash())
    addEventListener('hashchange', update)
    return () => removeEventListener('hashchange', update)
  }, [])
  useEffect(() => {
    document.body.dataset.theme = theme
  }, [theme])
  const configure = () =>
    setNotice('External app connections are not configured in this private workbench preview. You can build and test Code and Pipali Agent workflows now.')

  return (
    <I18nProvider i18n={i18n}>
      <div className="open-flow-theme server-host" data-theme={theme}>
        <header className="server-nav">
          <div className="server-nav-title">
            <JadaLogo />
            Jada Flow
          </div>
          <nav aria-label="Preview navigation">
            <a href="#view=design">Flows</a>
          </nav>
          <span className="jada-preview-label">Private workbench · editing and test runs enabled</span>
          <div className="server-nav-actions">
            <Button variant="ghost" onClick={() => setPanel((value) => !value)}>
              Copilot
            </Button>
            <Button variant="ghost" onClick={() => setTheme((value) => (value === 'light' ? 'dark' : 'light'))}>
              {theme === 'light' ? 'Dark mode' : 'Light mode'}
            </Button>
          </div>
        </header>
        {notice && (
          <div className="jada-preview-notice" role="status">
            <span>{notice}</span>
            <Button variant="ghost" onClick={() => setNotice('')}>
              Dismiss
            </Button>
          </div>
        )}
        {loading || error ? (
          <main className="jada-preview-loading">
            <JadaLogo />
            <h1>{error ? 'Preview connection' : 'Opening your Jada Flow workspace'}</h1>
            <p>{error || 'Preparing an isolated workspace with the real workflow editor and Pipali copilot.'}</p>
            {error && <Button onClick={() => location.reload()}>Reconnect</Button>}
          </main>
        ) : (
          session && (
            <div className="workbench-frame jada-workspace">
              <div className="jada-canvas">
                <OpenFlowWorkbench
                  host={host}
                  language="en"
                  theme={theme}
                  sessionKey={session.userId}
                  location={where}
                  hrefFor={hrefFor}
                  preferences={preferences}
                  onNavigate={(next) => {
                    location.hash = hrefFor(next)
                    setWhere(next)
                  }}
                  onLanguageChange={() => setNotice('This preview uses English. The full self-hosted app includes the native language controls.')}
                  onConfigureConnector={configure}
                  variables={false}
                />
              </div>
              {where.flowId && panel && (
                <CopilotPanel
                  key={`${session.userId}:${where.flowId}`}
                  flowId={where.flowId}
                  apiBase={apiBase}
                  onClose={() => setPanel(false)}
                  onConfigure={configure}
                />
              )}
            </div>
          )
        )}
        <Toaster {...notificationToasterProps} theme={theme} />
      </div>
    </I18nProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
