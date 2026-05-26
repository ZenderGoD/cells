document.getElementById('run').addEventListener('click', () => {
  chrome.runtime.sendMessage({ kind: 'run-api-probe' }, (response) => {
    document.getElementById('output').textContent = JSON.stringify(response, null, 2)
  })
})
