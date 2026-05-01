import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'
import os from 'os'
import { pathToFileURL } from 'url'

export interface LspPosition {
  line: number
  character: number
}

export interface EditorLspOpenRequest {
  filePath: string
  languageId: string
  content: string
  rootPath?: string | null
}

export interface EditorLspCompletionRequest {
  uri: string
  position: LspPosition
}

export interface EditorLspDiagnosticsPayload {
  uri: string
  diagnostics: unknown[]
}

interface LanguageServerSpec {
  languages: string[]
  command: string
  args: string[]
}

interface LspDocument {
  uri: string
  filePath: string
  languageId: string
  version: number
  server: LspServer
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 10_000

const LANGUAGE_SERVER_SPECS: LanguageServerSpec[] = [
  {
    languages: ['typescript', 'javascript'],
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  { languages: ['python'], command: 'pyright-langserver', args: ['--stdio'] },
  { languages: ['python'], command: 'pylsp', args: [] },
  { languages: ['go'], command: 'gopls', args: [] },
  { languages: ['rust'], command: 'rust-analyzer', args: [] },
  { languages: ['css', 'scss', 'less'], command: 'vscode-css-language-server', args: ['--stdio'] },
  { languages: ['html'], command: 'vscode-html-language-server', args: ['--stdio'] },
  { languages: ['json'], command: 'vscode-json-language-server', args: ['--stdio'] },
  { languages: ['yaml'], command: 'yaml-language-server', args: ['--stdio'] },
  { languages: ['shell'], command: 'bash-language-server', args: ['start'] },
  { languages: ['lua'], command: 'lua-language-server', args: [] },
  { languages: ['ruby'], command: 'ruby-lsp', args: [] },
  { languages: ['ruby'], command: 'solargraph', args: ['stdio'] },
  { languages: ['c', 'cpp'], command: 'clangd', args: [] },
  { languages: ['csharp'], command: 'csharp-ls', args: [] },
  { languages: ['swift'], command: 'sourcekit-lsp', args: [] },
  { languages: ['kotlin'], command: 'kotlin-language-server', args: [] },
  { languages: ['markdown'], command: 'marksman', args: ['server'] },
  { languages: ['toml'], command: 'taplo', args: ['lsp', 'stdio'] },
]

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildUserPathEnv() {
  const home = os.homedir()
  const entries = [
    process.env.PATH ?? '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    path.join(home, '.local/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, 'go/bin'),
  ]
  return Array.from(
    new Set(entries.flatMap((entry) => entry.split(path.delimiter)).filter(Boolean)),
  ).join(path.delimiter)
}

function resolveCommand(command: string): string | null {
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const output = execFileSync(shell, ['-lc', `command -v -- ${shellQuote(command)}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: buildUserPathEnv() },
      timeout: 1500,
    })
      .trim()
      .split('\n')[0]
    return output && path.isAbsolute(output) ? output : null
  } catch {
    return null
  }
}

function filePathToUri(filePath: string) {
  return pathToFileURL(path.resolve(filePath)).toString()
}

function rootPathFor(filePath: string, rootPath?: string | null) {
  return rootPath ? path.resolve(rootPath) : path.dirname(path.resolve(filePath))
}

function lspLanguageId(languageId: string, filePath: string) {
  const lower = filePath.toLowerCase()
  if (languageId === 'typescript' && lower.endsWith('.tsx')) return 'typescriptreact'
  if (languageId === 'javascript' && lower.endsWith('.jsx')) return 'javascriptreact'
  if (languageId === 'shell') return 'shellscript'
  return languageId
}

function specForLanguage(languageId: string) {
  return LANGUAGE_SERVER_SPECS.filter((spec) => spec.languages.includes(languageId))
}

class LspServer {
  private process: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private initialized = false
  readonly key: string

  constructor(
    private readonly commandPath: string,
    private readonly args: string[],
    private readonly rootPath: string,
    private readonly onDiagnostics: (payload: EditorLspDiagnosticsPayload) => void,
  ) {
    this.key = `${commandPath}\u241f${rootPath}`
    this.process = spawn(commandPath, args, {
      cwd: rootPath,
      env: { ...process.env, PATH: buildUserPathEnv() },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    this.process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) console.warn(`[editor-lsp] ${path.basename(commandPath)}: ${text}`)
    })
    this.process.on('exit', (code, signal) => {
      const error = new Error(`Language server exited (${code ?? signal ?? 'unknown'})`)
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
    })
  }

  async initialize() {
    if (this.initialized) return
    const rootUri = pathToFileURL(this.rootPath).toString()
    await this.request('initialize', {
      processId: process.pid,
      rootPath: this.rootPath,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) || this.rootPath }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: true },
          completion: {
            dynamicRegistration: false,
            completionItem: {
              snippetSupport: false,
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          hover: {
            dynamicRegistration: false,
            contentFormat: ['markdown', 'plaintext'],
          },
          definition: {
            dynamicRegistration: false,
            linkSupport: false,
          },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
        },
      },
      initializationOptions: {},
      trace: 'off',
    })
    this.notify('initialized', {})
    this.initialized = true
  }

  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
    return promise
  }

  stop() {
    try {
      this.notify('shutdown')
      this.notify('exit')
    } catch {}
    try {
      this.process.kill()
    } catch {}
  }

  private write(payload: unknown) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
    this.process.stdin.write(Buffer.concat([header, body]))
  }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.slice(0, headerEnd).toString('ascii')
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const messageStart = headerEnd + 4
      const messageEnd = messageStart + length
      if (this.buffer.length < messageEnd) return
      const raw = this.buffer.slice(messageStart, messageEnd).toString('utf8')
      this.buffer = this.buffer.slice(messageEnd)
      try {
        this.handleMessage(JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        console.warn('[editor-lsp] failed to parse message', error)
      }
    }
  }

  private handleMessage(message: Record<string, unknown>) {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: string; diagnostics?: unknown[] } | undefined
      if (params?.uri) {
        this.onDiagnostics({ uri: params.uri, diagnostics: params.diagnostics ?? [] })
      }
    }
  }
}

export class EditorLspManager {
  private servers = new Map<string, LspServer>()
  private docs = new Map<string, LspDocument>()
  private commandCache = new Map<string, string | null>()

  constructor(private readonly onDiagnostics: (payload: EditorLspDiagnosticsPayload) => void) {}

  async openDocument(request: EditorLspOpenRequest) {
    const languageId = request.languageId
    const server = await this.ensureServer(languageId, request.filePath, request.rootPath)
    if (!server) return { enabled: false }

    const uri = filePathToUri(request.filePath)
    const existing = this.docs.get(uri)
    if (existing) {
      existing.server = server
      existing.version += 1
      existing.languageId = languageId
      server.notify('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: request.content }],
      })
      return { enabled: true, uri }
    }

    const doc: LspDocument = {
      uri,
      filePath: request.filePath,
      languageId,
      version: 1,
      server,
    }
    this.docs.set(uri, doc)
    server.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: lspLanguageId(languageId, request.filePath),
        version: doc.version,
        text: request.content,
      },
    })
    return { enabled: true, uri }
  }

  changeDocument(uri: string, content: string, version?: number) {
    const doc = this.docs.get(uri)
    if (!doc) return { enabled: false }
    doc.version = typeof version === 'number' ? version : doc.version + 1
    doc.server.notify('textDocument/didChange', {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text: content }],
    })
    return { enabled: true }
  }

  closeDocument(uri: string) {
    const doc = this.docs.get(uri)
    if (!doc) return
    this.docs.delete(uri)
    doc.server.notify('textDocument/didClose', {
      textDocument: { uri },
    })
    this.onDiagnostics({ uri, diagnostics: [] })
  }

  async completion(request: EditorLspCompletionRequest) {
    const doc = this.docs.get(request.uri)
    if (!doc) return null
    return doc.server.request('textDocument/completion', {
      textDocument: { uri: request.uri },
      position: request.position,
    })
  }

  async hover(request: EditorLspCompletionRequest) {
    const doc = this.docs.get(request.uri)
    if (!doc) return null
    return doc.server.request('textDocument/hover', {
      textDocument: { uri: request.uri },
      position: request.position,
    })
  }

  async definition(request: EditorLspCompletionRequest) {
    const doc = this.docs.get(request.uri)
    if (!doc) return null
    return doc.server.request('textDocument/definition', {
      textDocument: { uri: request.uri },
      position: request.position,
    })
  }

  stop() {
    for (const server of this.servers.values()) server.stop()
    this.servers.clear()
    this.docs.clear()
  }

  private async ensureServer(languageId: string, filePath: string, rootPath?: string | null) {
    const specs = specForLanguage(languageId)
    if (specs.length === 0) return null
    const root = rootPathFor(filePath, rootPath)

    for (const spec of specs) {
      const commandPath = this.resolveCachedCommand(spec.command)
      if (!commandPath) continue
      const key = `${commandPath}\u241f${root}`
      const existing = this.servers.get(key)
      if (existing) return existing

      const server = new LspServer(commandPath, spec.args, root, this.onDiagnostics)
      try {
        await server.initialize()
        this.servers.set(key, server)
        return server
      } catch (error) {
        console.warn(`[editor-lsp] failed to initialize ${spec.command}`, error)
        server.stop()
      }
    }
    return null
  }

  private resolveCachedCommand(command: string) {
    if (!this.commandCache.has(command)) {
      this.commandCache.set(command, resolveCommand(command))
    }
    return this.commandCache.get(command) ?? null
  }
}
