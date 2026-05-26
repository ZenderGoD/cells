const marker = document.createElement('div')
marker.id = 'cells-nw-content-script-probe'
marker.textContent = 'Cells NW content-script probe injected.'
marker.style.cssText =
  'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:#0f766e;color:white;padding:6px 8px;border-radius:6px;font:12px system-ui'
document.documentElement.appendChild(marker)

const loginStatus = document.getElementById('password-manager-probe')
const user = document.querySelector('input[autocomplete="username"], input[type="email"]')
const pass = document.querySelector('input[autocomplete="current-password"], input[type="password"]')
if (loginStatus && user && pass) {
  user.value = 'content-probe@example.com'
  pass.value = 'content-probe-password'
  loginStatus.textContent = 'Content-script probe detected and filled login fields.'
}

console.log(
  'CELLS_NW_PROBE:' +
    JSON.stringify({
      source: 'cells-nw-probe',
      kind: 'content-script',
      results: [
        {
          id: 'content-scripts',
          label: 'Content scripts',
          status: 'pass',
          detail: 'Minimal content-script probe injected a page marker.',
          source: 'probe',
        },
      ],
    }),
)
