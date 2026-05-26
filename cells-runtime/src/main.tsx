import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CAPABILITIES,
  getConfiguredExtensionDirs,
  mergeCapabilityResults,
  type CapabilityResult,
  type ProbeMessage,
} from './extensions'
import { openDevToolsFor, openExternal } from './nw-api'
import { WebviewController, type BrowserEvent, type WebviewElement } from './webview-controller'
import './styles.css'

const TEST_PAGE = new URL('../test-pages/probe.html', window.location.href).href
const LOGIN_PAGE = new URL('../test-pages/login.html', window.location.href).href
const BLOCKED_URL = 'https://cells-runtime.invalid/blocked-by-dnr.js'

function App() {
  const controller = useMemo(() => new WebviewController(), [])
  const mainWebviewRef = useRef<WebviewElement | null>(null)
  const secondWebviewRef = useRef<WebviewElement | null>(null)
  const [url, setUrl] = useState('https://example.com')
  const [loadedUrl, setLoadedUrl] = useState('https://example.com')
  const [secondUrl, setSecondUrl] = useState(TEST_PAGE)
  const [loadedSecondUrl, setLoadedSecondUrl] = useState(TEST_PAGE)
  const [activeBrowserId, setActiveBrowserId] = useState<'project-a' | 'project-b'>('project-a')
  const [capabilities, setCapabilities] = useState<CapabilityResult[]>(CAPABILITIES)
  const [events, setEvents] = useState<string[]>([])
  const [consoleLines, setConsoleLines] = useState<string[]>([])
  const [networkLines, setNetworkLines] = useState<string[]>([])
  const [status, setStatus] = useState('Ready')
  const extensionDirs = useMemo(() => getConfiguredExtensionDirs(), [])

  const appendEvent = useCallback((line: string) => {
    setEvents((current) => [`${new Date().toLocaleTimeString()} ${line}`, ...current].slice(0, 80))
  }, [])
  const appendConsole = useCallback((line: string) => {
    setConsoleLines((current) => [line, ...current].slice(0, 120))
  }, [])
  const appendNetwork = useCallback((line: string) => {
    setNetworkLines((current) => [line, ...current].slice(0, 80))
  }, [])

  const readProbeConsole = useCallback(
    (detail: string) => {
      const marker = 'CELLS_NW_PROBE:'
      const index = detail.indexOf(marker)
      if (index === -1) return
      try {
        const parsed = JSON.parse(detail.slice(index + marker.length)) as ProbeMessage
        if (parsed.results) {
          setCapabilities((current) => mergeCapabilityResults(current, parsed.results ?? []))
        }
        if (parsed.kind === 'network') {
          appendNetwork(parsed.detail ?? JSON.stringify(parsed.payload))
        }
      } catch (error) {
        appendConsole(`Failed to parse probe console payload: ${String(error)}`)
      }
    },
    [appendConsole, appendNetwork],
  )

  useEffect(() => {
    if (mainWebviewRef.current) controller.register('project-a', mainWebviewRef.current)
    if (secondWebviewRef.current) controller.register('project-b', secondWebviewRef.current)
    return () => {
      controller.unregister('project-a')
      controller.unregister('project-b')
    }
  }, [appendConsole, appendEvent, controller, readProbeConsole])

  useEffect(() => {
    return controller.subscribe((event: BrowserEvent) => {
      if (event.type === 'load-start') {
        appendEvent(`${event.browserId}: load start ${event.url}`)
        setCapabilities((current) =>
          mergeCapabilityResults(current, [
            {
              id: 'browser-embedding',
              label: '<webview> browser embedding',
              status: 'pass',
              detail: 'NW.js webview emitted load events.',
              source: 'native',
            },
          ]),
        )
      } else if (event.type === 'load-stop') {
        appendEvent(`${event.browserId}: load stop ${event.url}`)
      } else if (event.type === 'console') {
        appendConsole(`${event.browserId}: ${event.detail}`)
        readProbeConsole(event.detail)
      } else if (event.type === 'new-window') {
        appendEvent(`${event.browserId}: new window ${event.url}`)
      } else {
        appendEvent(`${event.browserId}: ${event.type} ${event.detail}`)
      }
    })
  }, [appendConsole, appendEvent, controller, readProbeConsole])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as ProbeMessage
      if (!data || data.source !== 'cells-nw-probe') return
      if (data.results) {
        setCapabilities((current) => mergeCapabilityResults(current, data.results ?? []))
        appendEvent(`probe results: ${data.results.map((result) => result.id).join(', ')}`)
      }
      if (data.detail) appendConsole(data.detail)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [appendConsole, appendEvent])

  function navigate(browserId: 'project-a' | 'project-b', nextUrl: string) {
    if (browserId === 'project-a') setLoadedUrl(nextUrl)
    else setLoadedSecondUrl(nextUrl)
    controller.navigate(browserId, nextUrl)
  }

  async function runApiProbe() {
    setStatus('Running API probe')
    navigate(activeBrowserId, TEST_PAGE)
    window.setTimeout(async () => {
      try {
        await controller.execute(
          activeBrowserId,
          `window.postMessage({source:'cells-nw-shell', kind:'run-api-probe'}, '*')`,
        )
        setStatus('API probe requested. Check capability rows for extension responses.')
      } catch (error) {
        setStatus(`API probe failed to start: ${String(error)}`)
      }
    }, 700)
  }

  async function runAdBlockProbe() {
    setStatus('Running ad-block probe')
    appendNetwork(`requesting ${BLOCKED_URL}`)
    navigate(
      activeBrowserId,
      `${TEST_PAGE}?blocked=${encodeURIComponent(BLOCKED_URL)}&ts=${Date.now()}`,
    )
    window.setTimeout(async () => {
      try {
        const blockedScriptLoaded = await controller.execute(
          activeBrowserId,
          'Boolean(window.__cellsNwBlockedScriptLoaded)',
        )
        setCapabilities((current) =>
          mergeCapabilityResults(current, [
            {
              id: 'declarative-net-request',
              label: 'chrome.declarativeNetRequest',
              status: blockedScriptLoaded ? 'fail' : 'pass',
              detail: blockedScriptLoaded
                ? 'Blocked test script executed; DNR did not block the marker URL.'
                : 'Blocked test script did not execute. Confirm with extension logs.',
              source: 'probe',
            },
          ]),
        )
        appendNetwork(
          blockedScriptLoaded
            ? 'blocked marker script executed: FAIL'
            : 'blocked marker script absent: PASS or network failure',
        )
      } catch (error) {
        appendNetwork(`ad-block probe failed: ${String(error)}`)
      }
    }, 1500)
  }

  async function runCookiesProbe() {
    setStatus('Running partition/cookies probe')
    navigate('project-a', `${TEST_PAGE}?partition=a`)
    navigate('project-b', `${TEST_PAGE}?partition=b`)
    window.setTimeout(async () => {
      try {
        await controller.execute(
          'project-a',
          `document.cookie = "cells_partition=project-a; path=/"`,
        )
        await controller.execute(
          'project-b',
          `document.cookie = "cells_partition=project-b; path=/"`,
        )
        const cookieA = await controller.execute('project-a', 'document.cookie')
        const cookieB = await controller.execute('project-b', 'document.cookie')
        const isolated =
          String(cookieA).includes('project-a') && String(cookieB).includes('project-b')
        setCapabilities((current) =>
          mergeCapabilityResults(current, [
            {
              id: 'partition-isolation',
              label: 'Project-like partition isolation',
              status: isolated ? 'pass' : 'fail',
              detail: `project-a cookie=${String(cookieA)}; project-b cookie=${String(cookieB)}`,
              source: 'native',
            },
          ]),
        )
      } catch (error) {
        appendConsole(`cookies probe failed: ${String(error)}`)
      }
    }, 800)
  }

  function openExtensionPopup() {
    const candidates = extensionDirs
      .map((dir) => dir.replace(/\/$/, '').split(/[\\/]/).pop())
      .filter(Boolean)
    const idOrPathHint = candidates[0]
    if (!idOrPathHint) {
      setStatus('No extension directories configured.')
      return
    }
    setStatus(
      'Open chrome://extensions in NW.js DevTools to find the runtime ID, then navigate to chrome-extension://<id>/popup.html.',
    )
    openExternal('chrome://extensions')
  }

  const state = controller.getState(activeBrowserId)

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <strong>Cells Runtime Extension Lab</strong>
          <span>Runtime 0.109.0 SDK sidecar</span>
        </div>
        <div className="toolbar">
          <button onClick={() => controller.back(activeBrowserId)}>Back</button>
          <button onClick={() => controller.forward(activeBrowserId)}>Forward</button>
          <button onClick={() => controller.reload(activeBrowserId)}>Reload</button>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') navigate(activeBrowserId, url)
            }}
          />
          <button onClick={() => navigate(activeBrowserId, url)}>Go</button>
        </div>
      </header>

      <section className="controls">
        <label>
          Active webview
          <select
            value={activeBrowserId}
            onChange={(event) =>
              setActiveBrowserId(event.target.value as 'project-a' | 'project-b')
            }
          >
            <option value="project-a">project-a</option>
            <option value="project-b">project-b</option>
          </select>
        </label>
        <button onClick={() => navigate(activeBrowserId, TEST_PAGE)}>Load Test Page</button>
        <button onClick={() => navigate(activeBrowserId, LOGIN_PAGE)}>Load Login Page</button>
        <button onClick={runApiProbe}>Run API Probe</button>
        <button onClick={runAdBlockProbe}>Run Ad-Block Probe</button>
        <button onClick={runCookiesProbe}>Run Cookies Probe</button>
        <button onClick={openExtensionPopup}>Open Extension Popup</button>
        <button
          onClick={() => {
            const ok = openDevToolsFor(controller.getElement(activeBrowserId))
            setCapabilities((current) =>
              mergeCapabilityResults(current, [
                {
                  id: 'devtools',
                  label: 'Webview DevTools',
                  status: ok ? 'pass' : 'fail',
                  detail: ok
                    ? 'NW.js showDevTools was invoked.'
                    : 'NW.js DevTools API unavailable.',
                  source: 'native',
                },
              ]),
            )
          }}
        >
          Inspect Webview
        </button>
      </section>

      <section className="content">
        <div className="webviews">
          <div className="webviewPanel">
            <div className="panelTitle">project-a partition</div>
            <webview
              ref={mainWebviewRef as React.RefObject<HTMLElement>}
              src={loadedUrl}
              partition="project-a"
              className={activeBrowserId === 'project-a' ? 'activeWebview' : ''}
            />
          </div>
          <div className="webviewPanel secondary">
            <div className="panelTitle">project-b partition</div>
            <webview
              ref={secondWebviewRef as React.RefObject<HTMLElement>}
              src={loadedSecondUrl}
              partition="project-b"
              className={activeBrowserId === 'project-b' ? 'activeWebview' : ''}
            />
            <div className="secondaryNav">
              <input value={secondUrl} onChange={(event) => setSecondUrl(event.target.value)} />
              <button onClick={() => navigate('project-b', secondUrl)}>Go</button>
            </div>
          </div>
        </div>

        <aside className="sidebar">
          <section>
            <h2>Runtime</h2>
            <p>{status}</p>
            <p>
              {state ? `${activeBrowserId}: ${state.title || state.url}` : 'No active state yet'}
            </p>
          </section>
          <section>
            <h2>Extensions</h2>
            {extensionDirs.length ? (
              <ul>
                {extensionDirs.map((dir) => (
                  <li key={dir}>{dir}</li>
                ))}
              </ul>
            ) : (
              <p>No extension dirs passed to NW.js.</p>
            )}
          </section>
          <section>
            <h2>Capabilities</h2>
            <div className="capabilities">
              {capabilities.map((capability) => (
                <div key={capability.id} className={`capability ${capability.status}`}>
                  <span>{capability.status}</span>
                  <strong>{capability.label}</strong>
                  <small>{capability.detail}</small>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>

      <section className="logs">
        <Log title="Events" lines={events} />
        <Log title="Network Probe" lines={networkLines} />
        <Log title="Console" lines={consoleLines} />
      </section>
    </main>
  )
}

function Log({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="log">
      <h2>{title}</h2>
      <pre>{lines.length ? lines.join('\n') : 'No entries yet.'}</pre>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
      }
    }
  }
}
