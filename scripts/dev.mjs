import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const FILTERED_MACOS_LINES = [
  /ERROR:gpu_process_host\.cc\(\d+\)\] GPU process exited unexpectedly: exit_code=15/,
  /ERROR:network_service_instance_impl\.cc\(\d+\)\] Network service crashed, restarting service\./,
]

const shouldFilterStartupNoise = process.platform === 'darwin'
const env = {
  ...process.env,
  CELLS_DEV_ROOT: process.env.CELLS_DEV_ROOT ?? path.join(os.homedir(), '.cells-dev'),
}

function shouldDropLine(line) {
  return shouldFilterStartupNoise && FILTERED_MACOS_LINES.some((pattern) => pattern.test(line))
}

function forwardStream(stream, write) {
  let buffer = ''

  const flush = (force = false) => {
    const lines = buffer.split('\n')
    if (!force) {
      buffer = lines.pop() ?? ''
    } else {
      buffer = ''
    }

    for (const line of lines) {
      if (!shouldDropLine(line)) {
        write(`${line}\n`)
      }
    }

    if (force && buffer && !shouldDropLine(buffer)) {
      write(buffer)
    }
  }

  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    flush()
  })
  stream.on('close', () => flush(true))
}

const child = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'vite', ...process.argv.slice(2)],
  {
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  },
)

forwardStream(child.stdout, (chunk) => process.stdout.write(chunk))
forwardStream(child.stderr, (chunk) => process.stderr.write(chunk))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal)
    }
  })
}

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
