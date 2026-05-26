export type CapabilityStatus = 'unknown' | 'pass' | 'fail' | 'partial'

export interface CapabilityResult {
  id: string
  label: string
  status: CapabilityStatus
  detail: string
  source: 'native' | 'probe' | 'polyfill' | 'manual'
}

export interface ProbeMessage {
  source?: string
  kind?: string
  results?: CapabilityResult[]
  detail?: string
  payload?: unknown
}

export const CAPABILITIES: CapabilityResult[] = [
  {
    id: 'browser-embedding',
    label: '<webview> browser embedding',
    status: 'unknown',
    detail: 'Waiting for webview load events.',
    source: 'native',
  },
  {
    id: 'partition-isolation',
    label: 'Project-like partition isolation',
    status: 'unknown',
    detail: 'Run the cookies probe against project A and project B.',
    source: 'native',
  },
  {
    id: 'content-scripts',
    label: 'Content scripts',
    status: 'unknown',
    detail: 'Waiting for content-script probe marker.',
    source: 'probe',
  },
  {
    id: 'runtime',
    label: 'chrome.runtime',
    status: 'unknown',
    detail: 'Waiting for extension API probe.',
    source: 'probe',
  },
  {
    id: 'storage',
    label: 'chrome.storage',
    status: 'unknown',
    detail: 'Waiting for extension API probe.',
    source: 'probe',
  },
  {
    id: 'tabs',
    label: 'chrome.tabs / scripting',
    status: 'unknown',
    detail: 'Waiting for extension API probe.',
    source: 'probe',
  },
  {
    id: 'cookies',
    label: 'chrome.cookies',
    status: 'unknown',
    detail: 'Waiting for extension API probe.',
    source: 'probe',
  },
  {
    id: 'web-request',
    label: 'chrome.webRequest',
    status: 'unknown',
    detail: 'Waiting for extension API probe.',
    source: 'probe',
  },
  {
    id: 'declarative-net-request',
    label: 'chrome.declarativeNetRequest',
    status: 'unknown',
    detail: 'Waiting for extension API probe and ad-block probe.',
    source: 'probe',
  },
  {
    id: 'extension-popups',
    label: 'Extension popups/actions',
    status: 'unknown',
    detail: 'Open the bundled popup manually from the prototype.',
    source: 'manual',
  },
  {
    id: 'devtools',
    label: 'Webview DevTools',
    status: 'unknown',
    detail: 'Click Inspect Webview.',
    source: 'native',
  },
]

export function mergeCapabilityResults(
  current: CapabilityResult[],
  incoming: CapabilityResult[],
): CapabilityResult[] {
  const byId = new Map(current.map((result) => [result.id, result]))
  for (const result of incoming) {
    byId.set(result.id, result)
  }
  return current.map((result) => byId.get(result.id) ?? result)
}

export function getConfiguredExtensionDirs(): string[] {
  const raw = globalThis.process?.env?.CELLS_NW_EXTENSION_DIRS ?? ''
  return raw
    .split(globalThis.process?.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
