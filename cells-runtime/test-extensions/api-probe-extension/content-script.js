const marker = 'CELLS_NW_PROBE:'

function report(results, detail) {
  window.postMessage({ source: 'cells-nw-probe', kind: 'content-script-results', results, detail }, '*')
  console.log(marker + JSON.stringify({ source: 'cells-nw-probe', kind: 'content-script-results', results, detail }))
}

const status = document.getElementById('content-script-status')
if (status) {
  status.textContent = 'Content script injected by Cells NW API Probe.'
  status.dataset.cellsNwContentScript = 'true'
}

if (location.href.includes('login.html')) {
  const username = document.querySelector('input[autocomplete="username"], input[type="email"]')
  const password = document.querySelector('input[autocomplete="current-password"], input[type="password"]')
  const markerElement = document.getElementById('password-manager-probe')
  if (username && password && markerElement) {
    username.value = 'prototype@example.com'
    password.value = 'prototype-password'
    markerElement.textContent = 'Password-manager-style content script found and filled login fields.'
  }
}

window.addEventListener('message', (event) => {
  if (event.data?.source !== 'cells-nw-shell' || event.data?.kind !== 'run-api-probe') return
  chrome.runtime.sendMessage({ kind: 'run-api-probe' }, (response) => {
    const results = [
      {
        id: 'content-scripts',
        label: 'Content scripts',
        status: 'pass',
        detail: 'Content script received shell message and called chrome.runtime.sendMessage.',
        source: 'probe',
      },
      ...(response?.results ?? []),
    ]
    report(results, 'API probe completed from content script.')
  })
})
