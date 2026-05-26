const marker = 'CELLS_NW_PROBE:'

function result(id, label, ok, detail) {
  return {
    id,
    label,
    status: ok ? 'pass' : 'fail',
    detail,
    source: 'probe',
  }
}

async function probeApi() {
  const results = []

  results.push(
    result(
      'runtime',
      'chrome.runtime',
      Boolean(chrome.runtime?.getManifest?.()),
      chrome.runtime?.getManifest ? `manifest=${chrome.runtime.getManifest().name}` : 'missing',
    ),
  )

  try {
    await chrome.storage.local.set({ cellsNwStorageProbe: Date.now() })
    const stored = await chrome.storage.local.get('cellsNwStorageProbe')
    results.push(
      result(
        'storage',
        'chrome.storage',
        typeof stored.cellsNwStorageProbe === 'number',
        `stored=${String(stored.cellsNwStorageProbe)}`,
      ),
    )
  } catch (error) {
    results.push(result('storage', 'chrome.storage', false, String(error)))
  }

  try {
    const tabs = await chrome.tabs.query({})
    results.push(
      result('tabs', 'chrome.tabs / scripting', Array.isArray(tabs), `tabs=${tabs.length}`),
    )
  } catch (error) {
    results.push(result('tabs', 'chrome.tabs / scripting', false, String(error)))
  }

  try {
    const cookies = await chrome.cookies.getAll({})
    results.push(result('cookies', 'chrome.cookies', Array.isArray(cookies), `cookies=${cookies.length}`))
  } catch (error) {
    results.push(result('cookies', 'chrome.cookies', false, String(error)))
  }

  try {
    const hasWebRequest = Boolean(chrome.webRequest?.onBeforeRequest?.addListener)
    results.push(
      result(
        'web-request',
        'chrome.webRequest',
        hasWebRequest,
        hasWebRequest ? 'onBeforeRequest listener exists' : 'onBeforeRequest missing',
      ),
    )
  } catch (error) {
    results.push(result('web-request', 'chrome.webRequest', false, String(error)))
  }

  try {
    const hasDnr = Boolean(chrome.declarativeNetRequest?.updateDynamicRules)
    if (hasDnr) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1001],
        addRules: [
          {
            id: 1001,
            priority: 1,
            action: { type: 'block' },
            condition: {
              urlFilter: 'cells-runtime.invalid/blocked-by-dnr.js',
              resourceTypes: ['script'],
            },
          },
        ],
      })
      const rules = await chrome.declarativeNetRequest.getDynamicRules()
      results.push(
        result(
          'declarative-net-request',
          'chrome.declarativeNetRequest',
          rules.some((rule) => rule.id === 1001),
          `dynamicRules=${rules.length}`,
        ),
      )
    } else {
      results.push(
        result(
          'declarative-net-request',
          'chrome.declarativeNetRequest',
          false,
          'updateDynamicRules missing',
        ),
      )
    }
  } catch (error) {
    results.push(result('declarative-net-request', 'chrome.declarativeNetRequest', false, String(error)))
  }

  console.log(marker + JSON.stringify({ source: 'cells-nw-probe', kind: 'api-results', results }))
  return results
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind !== 'run-api-probe') return false
  probeApi().then((results) => sendResponse({ ok: true, results }))
  return true
})
