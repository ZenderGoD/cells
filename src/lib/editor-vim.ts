import type * as monaco from 'monaco-editor'
import { VimMode } from 'monaco-vim'

type VimApi = {
  map(lhs: string, rhs: string, ctx?: string): void
  noremap(lhs: string, rhs: string, ctx?: string): void
  unmap(lhs: string, ctx?: string): boolean
  mapclear(ctx?: string): void
  setOption(name: string, value: unknown): unknown
  defineEx(name: string, prefix: string, callback: (cm: unknown) => void): void
}

const vimApi = (VimMode as unknown as { Vim: VimApi }).Vim
const editorSaveHandlers = new WeakMap<monaco.editor.IStandaloneCodeEditor, () => void>()
let saveCommandsRegistered = false

function getVimEditor(cm: unknown) {
  return (cm as { editor?: monaco.editor.IStandaloneCodeEditor } | null)?.editor ?? null
}

function ensureVimSaveCommands() {
  if (saveCommandsRegistered) return
  saveCommandsRegistered = true
  const save = (cm: unknown) => {
    const editor = getVimEditor(cm)
    const handler = editor ? editorSaveHandlers.get(editor) : null
    handler?.()
  }
  vimApi.defineEx('write', 'w', save)
  vimApi.defineEx('wq', 'wq', save)
}

export function registerMonacoVimSaveCommand(
  editor: monaco.editor.IStandaloneCodeEditor,
  save: () => void,
) {
  ensureVimSaveCommands()
  editorSaveHandlers.set(editor, save)
  return () => editorSaveHandlers.delete(editor)
}

function stripInlineComment(line: string) {
  const commentIndex = line.search(/\s+"/)
  return commentIndex >= 0 ? line.slice(0, commentIndex).trim() : line.trim()
}

function normalizeMappingKey(value: string, leader: string) {
  return value.replace(/<leader>/gi, leader)
}

function parseLeader(line: string) {
  const match = line.match(/^let\s+mapleader\s*=\s*(.+)$/i)
  if (!match) return null
  const raw = match[1].trim()
  if (raw === '" "' || raw === "' '") return ' '
  const quoted = raw.match(/^["'](.+)["']$/)
  return quoted?.[1] ?? raw
}

function parseSet(line: string) {
  const body = line.replace(/^set\s+/i, '').trim()
  if (!body) return
  for (const token of body.split(/\s+/)) {
    if (!token) continue
    if (token.includes('=')) {
      const [name, rawValue] = token.split(/=(.*)/s)
      const numeric = Number(rawValue)
      vimApi.setOption(name, Number.isFinite(numeric) ? numeric : rawValue)
    } else if (token.startsWith('no') && token.length > 2) {
      vimApi.setOption(token.slice(2), false)
    } else {
      vimApi.setOption(token, true)
    }
  }
}

const MAP_COMMANDS: Record<string, { ctx?: string; recursive: boolean; unmap?: boolean }> = {
  map: { recursive: true },
  nmap: { ctx: 'normal', recursive: true },
  imap: { ctx: 'insert', recursive: true },
  vmap: { ctx: 'visual', recursive: true },
  noremap: { recursive: false },
  nnoremap: { ctx: 'normal', recursive: false },
  inoremap: { ctx: 'insert', recursive: false },
  vnoremap: { ctx: 'visual', recursive: false },
  unmap: { recursive: true, unmap: true },
  nunmap: { ctx: 'normal', recursive: true, unmap: true },
  iunmap: { ctx: 'insert', recursive: true, unmap: true },
  vunmap: { ctx: 'visual', recursive: true, unmap: true },
}

function applyMapping(line: string, leader: string) {
  const [command, ...parts] = line.split(/\s+/)
  const spec = MAP_COMMANDS[command.toLowerCase()]
  if (!spec) return false
  if (spec.unmap) {
    const lhs = parts[0]
    if (lhs) vimApi.unmap(normalizeMappingKey(lhs, leader), spec.ctx)
    return true
  }
  const lhs = parts[0]
  const rhs = parts.slice(1).join(' ')
  if (!lhs || !rhs) return true
  const normalizedLhs = normalizeMappingKey(lhs, leader)
  const normalizedRhs = normalizeMappingKey(rhs, leader)
  if (spec.recursive) vimApi.map(normalizedLhs, normalizedRhs, spec.ctx)
  else vimApi.noremap(normalizedLhs, normalizedRhs, spec.ctx)
  return true
}

export function applyMonacoVimConfig(config: string) {
  vimApi.mapclear()
  vimApi.mapclear('normal')
  vimApi.mapclear('insert')
  vimApi.mapclear('visual')

  let leader = '\\'
  for (const rawLine of config.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).replace(/^:/, '')
    if (!line || line.startsWith('"') || line.startsWith('#')) continue

    const nextLeader = parseLeader(line)
    if (nextLeader != null) {
      leader = nextLeader
      continue
    }

    try {
      if (/^set\s+/i.test(line)) {
        parseSet(line)
      } else {
        applyMapping(line, leader)
      }
    } catch (error) {
      console.warn('[editor-vim] Ignored vim config line:', line, error)
    }
  }
}
