import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArchiveRestore,
  ArrowUp,
  ArrowUpRight,
  Ban,
  Check,
  ChevronRight,
  Circle,
  Clock,
  Copy,
  FastForward,
  FileText,
  GitBranch,
  GitBranchPlus,
  GripVertical,
  HelpCircle,
  History,
  ListTodo,
  Loader2,
  MessageSquare,
  MousePointer2,
  Paperclip,
  Pencil,
  Reply,
  RotateCcw,
  ShieldCheck,
  Square,
  X,
  Zap,
} from 'lucide-react'
import type {
  AgentContextLength,
  AgentPermissionMode,
  AgentReplyReference,
  AgentSessionMessage,
  AgentSessionSnapshot,
  AgentThinkingLevel,
  AgentWindowNode,
  AgentWindowStatus,
  CodexPlanSnapshot,
  PendingAgentApproval,
  PendingQuestion,
  QueuedAgentMessage,
  RecentAgentSessionSummary,
} from '@/types'
import { useStore } from '@/lib/store'
import { AgentIcon } from '@/components/agent-icon'
import { AgentEmptyStateHint } from './agent-empty-state-hint'
import { AgentMarkdown } from './agent-markdown'
import { AgentAuthCard } from './agent-auth-card'
import {
  ContextUsageIndicator,
  ModelPicker,
  PERMISSION_MODE_OPTIONS,
  PermissionPicker,
  THINKING_LEVEL_LABEL_MAP,
  ThinkingPicker,
  cycleAgentModel,
  cyclePermissionMode,
  cycleThinkingLevel,
  getDefaultPermissionMode,
  prettifyModelId,
  resolveAgentPickerModelId,
  resolveThinkingLevelForModel,
} from './agent-composer-toolbar'
import { AgentTurnCard } from './agent-turn-card'
import { LoadingIndicator } from './agent-loading-indicator'
import { SessionDiffsPanel } from './session-diffs-panel'
import { InlineMentionMenu, useInlineMention } from './inline-mention-menu'
import { sumDiffStats, hasDiffStats } from '@/lib/tool-diff-stats'
import {
  deriveAgentSessionWindowStatus,
  getInFlightAgentMessages,
} from '@/lib/agent-session-activity'
import {
  getAltModifierLabel,
  getPrimaryModifierLabel,
  hasPrimaryModifier,
} from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'
import { computeStableList, createEmptyStableListState } from '@/lib/stable-list'
import { getVerticalScrollFadeMask, useVerticalScrollFades } from '@/lib/use-scroll-fades'
import {
  appendBrowserElementSelectionToDraft,
  copyBrowserElementSelectionToClipboard,
  parseBrowserElementSelectionPreview,
  splitBrowserElementSelectionDraft,
} from '@/lib/browser-element-selection'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Kbd } from '@/components/ui/kbd'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { showToast } from '@/components/toast'
import { WorktreeManager } from '@/components/worktree-manager'
import { LegendList, type LegendListRef } from '@legendapp/list/react'

interface AgentChatPanelProps {
  agentWindow: AgentWindowNode
}

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/apps/electron/src/renderer/pages/ChatPage.tsx
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx
// ../craft-agents-oss/packages/ui/src/components/chat/UserMessageBubble.tsx

const EASE_OUT = [0.25, 0.46, 0.45, 0.94] as const
// ease-out-quart for height-based expand/collapse — the tail settles gently
// instead of clipping. Paired with a faster opacity fade so content is
// legible while the container is still growing.
const EASE_EXPAND = [0.22, 1, 0.36, 1] as const
const EXPAND_TRANSITION = {
  height: { duration: 0.28, ease: EASE_EXPAND },
  opacity: { duration: 0.18, ease: EASE_EXPAND },
} as const
const BRANCH_IMPORT_MAX_CHARS = 80_000
const BROWSER_ELEMENT_PICKER_RETRY_DELAYS_MS = [80, 140, 180, 240, 320, 420] as const

function getComposerPlaceholder(agent: AgentWindowNode['agent']) {
  return agent === 'claude' ? 'Message Claude Code…' : 'Message Codex…'
}

function getAgentDisplayName(agent: AgentWindowNode['agent']) {
  return agent === 'claude' ? 'Claude Code' : 'Codex'
}

function getSourceSessionLabel(snapshot: AgentSessionSnapshot, sourceWindow: AgentWindowNode) {
  if (snapshot.agent === 'claude') {
    return snapshot.claudeSessionId
      ? `Claude Code session ${snapshot.claudeSessionId}`
      : `Claude Code window ${sourceWindow.id}`
  }
  return snapshot.codexThreadId
    ? `Codex thread ${snapshot.codexThreadId}`
    : `Codex window ${sourceWindow.id}`
}

function formatImportedMessage(message: AgentSessionMessage) {
  const roleLabel =
    message.role === 'user'
      ? 'User'
      : message.role === 'assistant'
        ? 'Assistant'
        : message.role === 'reasoning'
          ? 'Reasoning'
          : message.role === 'tool'
            ? `Tool${message.title ? `: ${message.title}` : ''}`
            : message.role === 'error'
              ? 'Error'
              : message.role === 'compaction'
                ? 'Compaction'
                : 'System'
  const text = message.text?.trim()
  const attachments =
    message.attachments && message.attachments.length > 0
      ? `\nAttachments:\n${message.attachments.map((path) => `- ${path}`).join('\n')}`
      : ''
  if (!text && !attachments) return ''
  return `### ${roleLabel}\n${text || '(no text)'}${attachments}`
}

function buildBranchImportPrompt({
  sourceWindow,
  snapshot,
  targetAgent,
  continuation,
  continuationAttachments,
}: {
  sourceWindow: AgentWindowNode
  snapshot: AgentSessionSnapshot
  targetAgent: AgentWindowNode['agent']
  continuation: string
  continuationAttachments: string[]
}) {
  const sourceAgent = getAgentDisplayName(snapshot.agent)
  const targetName = getAgentDisplayName(targetAgent)
  const sourceLabel = getSourceSessionLabel(snapshot, sourceWindow)
  const cwd = snapshot.cwd ?? sourceWindow.cwd ?? null
  const exportedAt = new Date().toISOString()
  const renderedMessages = snapshot.messages
    .map(formatImportedMessage)
    .filter((entry) => entry.trim().length > 0)
  let transcript = renderedMessages.join('\n\n')
  if (transcript.length > BRANCH_IMPORT_MAX_CHARS) {
    transcript = transcript.slice(transcript.length - BRANCH_IMPORT_MAX_CHARS)
    transcript = `[Earlier transcript omitted to keep the import within context.]\n\n${transcript}`
  }
  const attachmentBlock =
    continuationAttachments.length > 0
      ? `\n\nContinuation attachments:\n${continuationAttachments.map((path) => `- ${path}`).join('\n')}`
      : ''
  const continuationBlock = continuation.trim()
    ? `\n\n## Continue From Here\n${continuation.trim()}${attachmentBlock}`
    : attachmentBlock
      ? `\n\n## Continue From Here${attachmentBlock}`
      : '\n\n## Continue From Here\nConfirm you understand the imported context and wait for the next instruction.'

  return [
    `This is an imported handoff from ${sourceAgent} into ${targetName}.`,
    `Source: ${sourceLabel}`,
    `Imported at: ${exportedAt}`,
    cwd ? `Working directory: ${cwd}` : null,
    '',
    'The transcript below is portable context, not native provider state. Continue from it without assuming hidden session memory, pending approvals, or provider-specific tool IDs were preserved.',
    '',
    '## Imported Transcript',
    transcript || '(No transcript messages were available.)',
    continuationBlock,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

function getDraftSessionTitle(agent: AgentWindowNode['agent'], value: string) {
  const candidate = value.replace(/\s+/g, ' ').trim()
  if (!candidate) return getAgentDisplayName(agent)
  return candidate.length <= 50 ? candidate : `${candidate.slice(0, 47).trimEnd()}...`
}

function truncateCwd(cwd: string | null | undefined) {
  if (!cwd) return null
  const home = '/Users/raj'
  if (cwd.startsWith(home)) return '~' + cwd.slice(home.length)
  return cwd
}

function formatRelativeTime(timestamp: number) {
  const deltaMs = Math.max(0, Date.now() - timestamp)
  const deltaMinutes = Math.floor(deltaMs / 60_000)
  if (deltaMinutes < 1) return 'just now'
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`
  const deltaHours = Math.floor(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours}h ago`
  const deltaDays = Math.floor(deltaHours / 24)
  if (deltaDays < 7) return `${deltaDays}d ago`
  return new Date(timestamp).toLocaleDateString()
}

function formatElapsedMs(startedAt: number | null | undefined) {
  if (!startedAt) return null
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const elapsedSeconds = Math.floor(elapsedMs / 1000)
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Unwraps shell wrappers Codex emits, e.g. `/bin/zsh -lc "…"` or `bash -c '…'`,
// and strips leading `export FOO=bar;` / `FOO=bar` env assignments so the
// activity preview shows the real command (not a `CONVEX_DEPLOY_KEY=secret …`
// prefix that both leaks the key and pushes the real command past the
// 160-char truncation).
function cleanShellCommand(raw: string): string {
  let cmd = raw.trim()
  const wrapperMatch = cmd.match(
    /^(?:\/[^\s]+\/)?(?:sh|bash|zsh|dash|ksh)\s+(?:-[a-zA-Z]*c|-c)\s+(.*)$/s,
  )
  if (wrapperMatch) {
    const inner = wrapperMatch[1].trim()
    const quote = inner.startsWith('"') ? '"' : inner.startsWith("'") ? "'" : null
    if (quote && inner.endsWith(quote) && inner.length >= 2) {
      cmd = inner.slice(1, -1)
    } else {
      cmd = inner
    }
  }
  // Drop leading `export FOO=…;` / `FOO=…` assignments, including ones joined
  // with `;` or `&&`. Regex handles quoted/unquoted values.
  const envPattern =
    /^\s*(?:export\s+)?[A-Z_][A-Z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S*)\s*(?:;|&&)\s*/
  while (envPattern.test(cmd)) {
    cmd = cmd.replace(envPattern, '')
  }
  return cmd.trim() || raw.trim()
}

function getActivityPreview(message: AgentSessionMessage) {
  const metadata = parseJsonObject(message.metadata)
  const textObject = parseJsonObject(message.text)
  const command =
    typeof metadata?.command === 'string'
      ? metadata.command
      : typeof textObject?.command === 'string'
        ? textObject.command
        : null
  const description =
    typeof metadata?.description === 'string'
      ? metadata.description
      : typeof textObject?.description === 'string'
        ? textObject.description
        : null
  const cwd =
    typeof metadata?.cwd === 'string'
      ? metadata.cwd
      : typeof textObject?.cwd === 'string'
        ? textObject.cwd
        : typeof message.metadata === 'string' && message.metadata.startsWith('/')
          ? message.metadata
          : null
  const rawPreviewSource =
    description ||
    command ||
    message.text.split('\n').find((line) => line.trim().length > 0) ||
    message.title ||
    'Working'
  // Only attempt to unwrap when the source was a command (description is
  // already human-prose from the agent, and we don't want to mangle it).
  const previewSource =
    !description && command ? cleanShellCommand(rawPreviewSource) : rawPreviewSource
  return {
    preview: previewSource.length > 160 ? `${previewSource.slice(0, 160)}…` : previewSource,
    cwd,
  }
}

function normalizeFsPath(value: string | null | undefined) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

function isPathWithin(
  candidatePath: string | null | undefined,
  rootPath: string | null | undefined,
) {
  const candidate = normalizeFsPath(candidatePath)
  const root = normalizeFsPath(rootPath)
  if (!candidate || !root) return false
  return candidate === root || candidate.startsWith(`${root}/`)
}

function filterRecentSessionsForProject(
  sessions: RecentAgentSessionSummary[],
  projectPath: string | null | undefined,
  worktrees: Array<{ path: string; isBare?: boolean }>,
) {
  const roots = Array.from(
    new Set(
      [
        normalizeFsPath(projectPath),
        ...worktrees
          .filter((worktree) => !worktree.isBare)
          .map((worktree) => normalizeFsPath(worktree.path)),
      ].filter((value): value is string => Boolean(value)),
    ),
  )
  if (roots.length === 0) return sessions
  return sessions.filter((session) => roots.some((root) => isPathWithin(session.cwd, root)))
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

function isImagePath(p: string): boolean {
  const i = p.lastIndexOf('.')
  if (i < 0) return false
  return IMAGE_EXTENSIONS.has(p.slice(i).toLowerCase())
}

function sanitizeComposerAttachments(paths: string[] | null | undefined): string[] {
  return Array.from(
    new Set(
      (paths ?? []).filter(
        (path): path is string => typeof path === 'string' && path.trim().length > 0,
      ),
    ),
  )
}

const IMAGE_ATTACHMENT_TOKEN_RE = /\[Image\s+\d+\]\s*/gi
const IMAGE_ATTACHMENT_TOKEN_CAPTURE_RE = /\[Image\s+(\d+)\]/gi
const IMAGE_ATTACHMENT_TOKEN_AT_START_RE = /^\s*\[Image\s+\d+\]/i
const IMAGE_ATTACHMENT_TOKEN_AT_END_RE = /\[Image\s+\d+\]\s*$/i
const USER_IMAGE_TOKEN_CHIP_CLASS =
  'mx-0.5 inline-flex h-6 max-w-full items-center gap-1.5 rounded-[6px] border border-border/35 bg-background/45 py-0.5 pl-1 text-[12px] font-medium text-foreground/85 shadow-minimal'
const USER_IMAGE_TOKEN_THUMB_CLASS = 'size-4 shrink-0 rounded-[3px] bg-foreground/10 object-cover'
const BROWSER_SELECTION_TOKEN_CHIP_CLASS =
  'my-1 inline-flex max-w-full items-center gap-2 rounded-[7px] border border-cyan-300/20 bg-cyan-400/10 px-2.5 py-1.5 text-[12px] text-cyan-50/90 shadow-minimal'

function imageAttachmentToken(index: number) {
  return `[Image ${index + 1}]`
}

function stripImageAttachmentTokens(input: string) {
  return input.replace(IMAGE_ATTACHMENT_TOKEN_RE, '')
}

function getSingleLineImageTokenEdges(input: string) {
  const trimmed = input.trim()
  const isSingleLine = trimmed.length > 0 && !/[\r\n]/.test(trimmed)
  return {
    startsWithImageToken: isSingleLine && IMAGE_ATTACHMENT_TOKEN_AT_START_RE.test(trimmed),
    endsWithImageToken: isSingleLine && IMAGE_ATTACHMENT_TOKEN_AT_END_RE.test(trimmed),
  }
}

function getImageTokenInsertResult(
  value: string,
  offset: number,
  currentAttachments: string[],
  paths: string[],
) {
  const nextAttachments = sanitizeComposerAttachments([...currentAttachments, ...paths])
  const tokens = paths
    .filter(isImagePath)
    .map((path) => nextAttachments.filter(isImagePath).indexOf(path))
    .filter((index) => index >= 0)
    .map(imageAttachmentToken)
  if (tokens.length === 0) return { value, offset }
  const insertion = `${tokens.join(' ')} `
  const safeOffset = Math.max(0, Math.min(offset, value.length))
  return {
    value: insertTextAtOffset(value, safeOffset, insertion),
    offset: safeOffset + insertion.length,
  }
}

function insertTextAtOffset(value: string, offset: number, insertion: string) {
  const safeOffset = Math.max(0, Math.min(offset, value.length))
  return `${value.slice(0, safeOffset)}${insertion}${value.slice(safeOffset)}`
}

function removeImageTokenForPath(value: string, path: string, currentAttachments: string[]) {
  const imageIndex = currentAttachments.filter(isImagePath).indexOf(path)
  if (imageIndex < 0) return value
  let removed = false
  return value.replace(IMAGE_ATTACHMENT_TOKEN_CAPTURE_RE, (match, rawIndex: string) => {
    const tokenIndex = Number.parseInt(rawIndex, 10) - 1
    if (tokenIndex === imageIndex && !removed) {
      removed = true
      return ''
    }
    if (tokenIndex > imageIndex) return imageAttachmentToken(tokenIndex - 1)
    return match
  })
}

function createImageChipElement(index: number, thumbnailUrl?: string | null) {
  const chip = document.createElement('span')
  chip.contentEditable = 'false'
  chip.dataset.imageChipIndex = String(index)
  chip.className = `${USER_IMAGE_TOKEN_CHIP_CLASS} pr-1 align-[-0.18em]`

  const thumb = thumbnailUrl ? document.createElement('img') : document.createElement('span')
  thumb.className = USER_IMAGE_TOKEN_THUMB_CLASS
  if (thumbnailUrl) {
    thumb.setAttribute('src', thumbnailUrl)
    thumb.setAttribute('alt', '')
  }
  chip.appendChild(thumb)

  const label = document.createElement('span')
  label.className = 'truncate'
  label.textContent = `Image ${index + 1}`
  chip.appendChild(label)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.dataset.removeImageChipIndex = String(index)
  remove.setAttribute('aria-label', `Remove Image ${index + 1}`)
  remove.className =
    'ml-0.5 rounded p-0.5 text-muted-foreground/65 transition-colors hover:bg-foreground/10 hover:text-foreground'
  remove.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
  chip.appendChild(remove)
  return chip
}

function createBrowserSelectionChipElement(raw: string) {
  const preview = parseBrowserElementSelectionPreview(raw)
  const chip = document.createElement('span')
  chip.contentEditable = 'false'
  chip.dataset.browserSelectionValue = raw
  chip.className = BROWSER_SELECTION_TOKEN_CHIP_CLASS
  chip.title = preview?.selector || preview?.url || 'Browser selection'

  const icon = document.createElement('span')
  icon.className = 'shrink-0 text-cyan-100/80'
  icon.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/></svg>'
  chip.appendChild(icon)

  const text = document.createElement('span')
  text.className = 'flex min-w-0 items-center gap-1.5'

  const element = document.createElement('span')
  element.className =
    'shrink-0 rounded-[5px] bg-cyan-200/12 px-1.5 py-0.5 font-mono text-[10.5px] text-cyan-50/90'
  element.textContent = preview?.element || '<element>'
  text.appendChild(element)

  const label = document.createElement('span')
  label.className = 'min-w-0 truncate font-medium'
  label.textContent = preview?.title || 'Browser selection'
  text.appendChild(label)

  chip.appendChild(text)
  return chip
}

function updateImageChipThumbnail(chip: HTMLElement, thumbnailUrl: string | null | undefined) {
  const currentThumb = chip.firstElementChild
  if (!thumbnailUrl) return
  if (currentThumb instanceof HTMLImageElement) {
    if (currentThumb.src !== thumbnailUrl) currentThumb.src = thumbnailUrl
    return
  }
  if (!currentThumb) return
  const thumb = document.createElement('img')
  thumb.className = USER_IMAGE_TOKEN_THUMB_CLASS
  thumb.src = thumbnailUrl
  thumb.alt = ''
  chip.replaceChild(thumb, currentThumb)
}

function updateComposerImageChipThumbnails(
  root: HTMLElement | null,
  imageAttachments: string[],
  thumbnailUrls: Record<string, string | null>,
) {
  if (!root) return
  root.querySelectorAll<HTMLElement>('[data-image-chip-index]').forEach((chip) => {
    const index = Number.parseInt(chip.dataset.imageChipIndex ?? '', 10)
    const path = imageAttachments[index]
    if (path) updateImageChipThumbnail(chip, thumbnailUrls[path])
  })
}

function renderComposerValueInto(
  root: HTMLElement,
  value: string,
  imageAttachments: string[],
  thumbnailUrls: Record<string, string | null>,
) {
  root.textContent = ''
  const appendTextWithImageChips = (text: string) => {
    let cursor = 0
    let match: RegExpExecArray | null
    IMAGE_ATTACHMENT_TOKEN_CAPTURE_RE.lastIndex = 0
    while ((match = IMAGE_ATTACHMENT_TOKEN_CAPTURE_RE.exec(text))) {
      if (match.index > cursor) {
        root.appendChild(document.createTextNode(text.slice(cursor, match.index)))
      }
      const index = Number.parseInt(match[1] ?? '', 10) - 1
      if (index >= 0 && index < imageAttachments.length) {
        const path = imageAttachments[index]
        root.appendChild(createImageChipElement(index, thumbnailUrls[path]))
      }
      cursor = match.index + match[0].length
    }
    if (cursor < text.length) {
      root.appendChild(document.createTextNode(text.slice(cursor)))
    }
  }

  for (const part of splitBrowserElementSelectionDraft(value)) {
    if (typeof part === 'string') {
      appendTextWithImageChips(part)
    } else {
      root.appendChild(createBrowserSelectionChipElement(part.raw))
    }
  }
}

function serializeComposerNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  const rawIndex = node.dataset.imageChipIndex
  if (rawIndex !== undefined) {
    const index = Number.parseInt(rawIndex, 10)
    return Number.isFinite(index) ? imageAttachmentToken(index) : ''
  }
  const browserSelectionValue = node.dataset.browserSelectionValue
  if (browserSelectionValue !== undefined) return browserSelectionValue
  if (node.tagName === 'BR') return '\n'
  let text = ''
  node.childNodes.forEach((child) => {
    text += serializeComposerNode(child)
  })
  if (node.tagName === 'DIV' || node.tagName === 'P') text += '\n'
  return text
}

function serializeComposerElement(root: HTMLElement | null) {
  if (!root) return ''
  let text = ''
  root.childNodes.forEach((child) => {
    text += serializeComposerNode(child)
  })
  return text.replace(/\n$/, '')
}

function getSerializedLength(node: Node): number {
  return serializeComposerNode(node).length
}

function getComposerSelectionOffset(root: HTMLElement | null) {
  if (!root) return 0
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return serializeComposerElement(root).length
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return serializeComposerElement(root).length

  let offset = 0
  let found = false
  const visit = (node: Node) => {
    if (found) return
    if (node === range.startContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += Math.min(range.startOffset, node.textContent?.length ?? 0)
      } else {
        const children = Array.from(node.childNodes).slice(0, range.startOffset)
        offset += children.reduce((sum, child) => sum + getSerializedLength(child), 0)
      }
      found = true
      return
    }
    if (
      node.nodeType === Node.TEXT_NODE ||
      (node instanceof HTMLElement &&
        (node.dataset.imageChipIndex !== undefined ||
          node.dataset.browserSelectionValue !== undefined))
    ) {
      offset += getSerializedLength(node)
      return
    }
    node.childNodes.forEach(visit)
  }
  root.childNodes.forEach(visit)
  return offset
}

function setComposerSelectionOffset(root: HTMLElement | null, targetOffset: number) {
  if (!root) return
  const selection = window.getSelection()
  if (!selection) return
  let remaining = Math.max(0, targetOffset)
  let targetNode: Node = root
  let targetNodeOffset = root.childNodes.length
  let found = false

  const visit = (node: Node) => {
    if (found) return
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        targetNode = node
        targetNodeOffset = remaining
        found = true
        return
      }
      remaining -= length
      return
    }
    if (
      node instanceof HTMLElement &&
      (node.dataset.imageChipIndex !== undefined ||
        node.dataset.browserSelectionValue !== undefined)
    ) {
      const length = getSerializedLength(node)
      if (remaining <= length) {
        const parent = node.parentNode ?? root
        targetNode = parent
        targetNodeOffset = Array.from(parent.childNodes).indexOf(node) + 1
        found = true
        return
      }
      remaining -= length
      return
    }
    node.childNodes.forEach(visit)
  }

  root.childNodes.forEach(visit)
  const range = document.createRange()
  range.setStart(targetNode, targetNodeOffset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

function insertPlainTextIntoComposer(root: HTMLElement | null, text: string) {
  if (!root || text.length === 0) return false
  root.focus()

  const selection = window.getSelection()
  if (!selection) return false
  let range: Range
  if (selection.rangeCount > 0 && root.contains(selection.getRangeAt(0).commonAncestorContainer)) {
    range = selection.getRangeAt(0)
  } else {
    range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
  }

  range.deleteContents()
  const textNode = document.createTextNode(text)
  range.insertNode(textNode)
  range.setStartAfter(textNode)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

function useFileThumbnail(path: string, enabled = true, maxHeight = 96) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    window.cells.app
      .fileThumbnail(path, maxHeight)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, maxHeight, path])

  return enabled ? url : null
}

function isDirectImageUrl(path: string | null | undefined) {
  return Boolean(path && /^(?:https?:|data:|blob:|file:)/i.test(path))
}

async function copyAttachmentToClipboard(path: string) {
  try {
    const result = await window.cells.app.copyAttachmentToClipboard(path)
    showToast(
      result.kind === 'image' ? 'Copied image to clipboard' : 'Copied attachment path',
      'info',
    )
  } catch {
    showToast('Could not copy attachment')
  }
}

function AttachmentThumbnail({ path, onPreview }: { path: string; onPreview: () => void }) {
  const url = useFileThumbnail(path)
  const name = path.split('/').pop() || path
  if (!url) {
    return (
      <button
        type="button"
        onClick={onPreview}
        title={`Open ${path}`}
        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[8px] bg-foreground/10 text-[10px] text-muted-foreground/70 transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
      >
        <Paperclip className="size-3.5" />
      </button>
    )
  }
  return (
    <div className="group/attachment relative shrink-0">
      <button
        type="button"
        onClick={onPreview}
        title={`Open ${path}`}
        className="rounded-[8px] transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
      >
        <img
          src={url}
          alt={name}
          className="h-16 w-16 rounded-[8px] border border-border/30 object-cover"
        />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          void copyAttachmentToClipboard(path)
        }}
        aria-label={`Copy ${name}`}
        title="Copy to clipboard"
        className="absolute right-1 top-1 rounded-md border border-black/20 bg-black/55 p-1 text-white/80 opacity-0 backdrop-blur transition-opacity hover:bg-black/75 hover:text-white group-hover/attachment:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <Copy className="size-3" />
      </button>
    </div>
  )
}

function AttachmentPill({ path }: { path: string }) {
  const name = path.split('/').pop() || path
  return (
    <span className="inline-flex items-center gap-1 rounded-[6px] bg-foreground/5 py-0.5 pl-2 pr-1 text-[11px] text-muted-foreground/90">
      <button
        type="button"
        onClick={() => void window.cells.app.revealPath(path).catch(() => {})}
        className="inline-flex min-w-0 items-center gap-1 rounded-[5px] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
        title={path}
      >
        <Paperclip className="size-3 shrink-0" />
        <span className="max-w-[180px] truncate font-mono">{name}</span>
      </button>
      <button
        type="button"
        onClick={() => void copyAttachmentToClipboard(path)}
        aria-label={`Copy ${name}`}
        title="Copy to clipboard"
        className="rounded p-0.5 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
      >
        <Copy className="size-3" />
      </button>
    </span>
  )
}

function splitImageTokenText(text: string): Array<string | { imageIndex: number; token: string }> {
  const parts: Array<string | { imageIndex: number; token: string }> = []
  let cursor = 0
  let match: RegExpExecArray | null
  IMAGE_ATTACHMENT_TOKEN_CAPTURE_RE.lastIndex = 0
  while ((match = IMAGE_ATTACHMENT_TOKEN_CAPTURE_RE.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    const imageIndex = Number.parseInt(match[1] ?? '', 10) - 1
    parts.push({ imageIndex, token: match[0] })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function UserImageTokenChip({
  imageIndex,
  path,
  onPreview,
}: {
  imageIndex: number
  path: string | undefined
  onPreview: () => void
}) {
  const url = useFileThumbnail(path ?? '', Boolean(path), 48)
  const label = `Image ${imageIndex + 1}`
  return (
    <button
      type="button"
      onClick={onPreview}
      disabled={!path}
      className={`${USER_IMAGE_TOKEN_CHIP_CLASS} pr-2 align-[-0.18em] transition-colors hover:bg-background/65 disabled:pointer-events-none disabled:opacity-70`}
      title={path ?? label}
    >
      {url ? (
        <img src={url} alt="" className={USER_IMAGE_TOKEN_THUMB_CLASS} />
      ) : (
        <span className={USER_IMAGE_TOKEN_THUMB_CLASS} />
      )}
      <span className="truncate">{label}</span>
    </button>
  )
}

function BrowserElementSelectionChip({
  preview,
}: {
  preview: NonNullable<ReturnType<typeof parseBrowserElementSelectionPreview>>
}) {
  const title = preview.title || 'Browser selection'
  const detail = preview.selector || preview.text || preview.url || 'Selected browser element'

  return (
    <div
      className="inline-flex max-w-full items-center gap-2 rounded-[7px] border border-cyan-300/20 bg-cyan-400/10 px-2.5 py-1.5 text-[12px] leading-none text-cyan-50/90 shadow-minimal"
      title={detail}
      aria-label={`Browser selection: ${title}`}
    >
      <MousePointer2 className="size-3.5 shrink-0 text-cyan-100/80" />
      <span className="shrink-0 rounded-[5px] bg-cyan-200/12 px-1.5 py-0.5 font-mono text-[10.5px] text-cyan-50/90">
        {preview.element || '<element>'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground/90">{title}</div>
        <div className="mt-1 truncate font-mono text-[10.5px] leading-3 text-muted-foreground/70">
          {detail}
        </div>
      </div>
    </div>
  )
}

function UserMessageText({
  images,
  visiblePlainText,
  onPreview,
}: {
  images: string[]
  visiblePlainText: string
  onPreview: (path: string) => void
}) {
  const displayText = visiblePlainText
  const browserSelectionPreview = useMemo(
    () => parseBrowserElementSelectionPreview(displayText),
    [displayText],
  )
  const parts = useMemo(() => splitImageTokenText(displayText), [displayText])
  const hasTokenParts = parts.some((part) => typeof part !== 'string')

  if (browserSelectionPreview && !hasTokenParts) {
    return (
      <div className="space-y-2">
        {browserSelectionPreview.before ? (
          <pre className="m-0 max-w-full whitespace-pre-wrap break-words font-sans leading-[1.45] [overflow-wrap:anywhere]">
            {browserSelectionPreview.before}
          </pre>
        ) : null}
        <BrowserElementSelectionChip preview={browserSelectionPreview} />
      </div>
    )
  }

  if (!hasTokenParts) {
    return (
      <pre className="m-0 max-w-full whitespace-pre-wrap break-words font-sans leading-[1.45] [overflow-wrap:anywhere]">
        {displayText}
      </pre>
    )
  }

  return (
    <div className="whitespace-pre-wrap">
      {parts.map((part, index) => {
        if (typeof part === 'string') {
          if (!part) return null
          return <span key={index}>{part}</span>
        }
        const path = images[part.imageIndex]
        return (
          <UserImageTokenChip
            key={`${part.token}-${index}`}
            imageIndex={part.imageIndex}
            path={path}
            onPreview={() => {
              if (path) onPreview(path)
            }}
          />
        )
      })}
    </div>
  )
}

// Tiny inline thumbnail used inside queued-message rows where horizontal
// space is at a premium. Shows a 16px image preview for image attachments
// and a paperclip icon for anything else.
function QueueAttachmentThumb({ path }: { path: string }) {
  const name = path.split('/').pop() || path
  const isImage = isImagePath(path)
  const url = useFileThumbnail(path, isImage)
  if (isImage && url) {
    return (
      <img
        src={url}
        alt=""
        title={name}
        className="size-4 shrink-0 rounded-[3px] border border-border/40 object-cover"
      />
    )
  }
  return (
    <span
      title={name}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] border border-border/40 bg-foreground/5 text-muted-foreground/80"
    >
      <Paperclip className="size-2.5" />
    </span>
  )
}

function ComposerImagePreviewDialog({
  path,
  onClose,
}: {
  path: string | null
  onClose: () => void
}) {
  const name = path?.split('/').pop() || path || ''
  const url = useFileThumbnail(path ?? '', Boolean(path), 1400)

  return (
    <Dialog
      open={Boolean(path)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        showCloseButton
        className="max-h-[calc(100vh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-[1280px] overflow-hidden border border-border/40 bg-[oklch(0.12_0.004_285)] p-0"
      >
        <DialogTitle className="sr-only">{name || 'Image preview'}</DialogTitle>
        <div className="flex min-h-0 max-h-[calc(100vh-1.5rem)] flex-col">
          <div className="flex shrink-0 items-center gap-2 px-2 py-1.5 pr-9">
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/80">
              {name}
            </span>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center bg-black/60 p-1">
            {url ? (
              <img
                src={url}
                alt={name}
                className="max-h-[calc(100vh-6rem)] max-w-full rounded-[8px] object-contain shadow-2xl"
              />
            ) : (
              <div className="flex h-40 w-40 items-center justify-center rounded-[8px] border border-border/30 bg-background/30 text-muted-foreground/70">
                <Paperclip className="size-7" />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function UserAttachmentPreviewDialog({
  path,
  onClose,
}: {
  path: string | null
  onClose: () => void
}) {
  const name = path?.split('/').pop() || path || ''
  const isImage = Boolean(path && isImagePath(path))
  const directUrl = isDirectImageUrl(path) ? path : null
  const thumbnailUrl = useFileThumbnail(path ?? '', Boolean(path && !directUrl && isImage), 1400)
  const url = directUrl ?? thumbnailUrl

  return (
    <Dialog
      open={Boolean(path)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        showCloseButton
        className="max-h-[calc(100vh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-[1280px] overflow-hidden border border-border/40 bg-[oklch(0.12_0.004_285)] p-0"
      >
        <DialogTitle className="sr-only">{name || 'Attachment preview'}</DialogTitle>
        <div className="flex min-h-0 max-h-[calc(100vh-1.5rem)] flex-col">
          <div className="flex shrink-0 items-center gap-2 px-2 py-1.5 pr-9">
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/80">
              {name}
            </span>
            {path ? (
              <button
                type="button"
                onClick={() => void copyAttachmentToClipboard(path)}
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-2 text-[11px] text-muted-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
              >
                <Copy className="size-3" />
                Copy
              </button>
            ) : null}
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center bg-black/60 p-1">
            {url ? (
              <img
                src={url}
                alt={name}
                className="max-h-[calc(100vh-6rem)] max-w-full rounded-[8px] object-contain shadow-2xl"
              />
            ) : (
              <div className="flex h-40 w-40 flex-col items-center justify-center gap-2 rounded-[8px] border border-border/30 bg-background/30 text-muted-foreground/70">
                <Paperclip className="size-7" />
                <span className="max-w-36 truncate text-[11px]">{name}</span>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ComposerImageAttachment({
  path,
  onPreview,
  onRemove,
}: {
  path: string
  onPreview: () => void
  onRemove: () => void
}) {
  const name = path.split('/').pop() || path
  const url = useFileThumbnail(path, true, 192)

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={onPreview}
        title={`Preview ${name}`}
        className="group/image relative overflow-hidden rounded-[4px] border border-border/35 bg-foreground/5 transition-colors hover:border-border/60 hover:bg-foreground/8 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
      >
        {url ? (
          <img src={url} alt={name} className="h-20 w-20 object-cover" />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center text-muted-foreground/70">
            <Paperclip className="size-5" />
          </div>
        )}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
        aria-label={`Remove ${name}`}
        className="absolute right-1 top-1 rounded-full border border-black/20 bg-black/55 p-1 text-white/80 backdrop-blur transition-colors hover:bg-black/75 hover:text-white"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function ComposerRichEditor({
  editorRef,
  value,
  imageAttachments,
  placeholder,
  selectionOffset,
  onSelectionOffsetApplied,
  onChange,
  onKeyDown,
  onPasteImages,
  onRemoveImage,
}: {
  editorRef: RefObject<HTMLDivElement | null>
  value: string
  imageAttachments: string[]
  placeholder: string
  selectionOffset: number | null
  onSelectionOffsetApplied: () => void
  onChange: (value: string, cursorPosition: number) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onPasteImages: (files: File[], insertOffset: number) => void
  onRemoveImage: (path: string) => void
}) {
  const renderedValueRef = useRef<string | null>(null)
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string | null>>({})
  const empty = stripImageAttachmentTokens(value).length === 0 && imageAttachments.length === 0

  useEffect(() => {
    const imagePaths = imageAttachments
    if (imagePaths.length === 0) {
      const frame = window.requestAnimationFrame(() => {
        setThumbnailUrls({})
      })
      return () => window.cancelAnimationFrame(frame)
    }
    let cancelled = false
    Promise.all(
      imagePaths.map(async (path) => {
        try {
          return [path, await window.cells.app.fileThumbnail(path, 48)] as const
        } catch {
          return [path, null] as const
        }
      }),
    ).then((entries) => {
      if (cancelled) return
      setThumbnailUrls(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [imageAttachments])

  useEffect(() => {
    updateComposerImageChipThumbnails(editorRef.current, imageAttachments, thumbnailUrls)
  }, [editorRef, imageAttachments, thumbnailUrls])

  useEffect(() => {
    const root = editorRef.current
    if (!root) return
    const current = serializeComposerElement(root)
    if (current !== value || renderedValueRef.current !== value) {
      renderComposerValueInto(root, value, imageAttachments, thumbnailUrls)
      renderedValueRef.current = value
    }
    if (selectionOffset !== null) {
      setComposerSelectionOffset(root, selectionOffset)
      onSelectionOffsetApplied()
    }
  }, [editorRef, imageAttachments, onSelectionOffsetApplied, selectionOffset, thumbnailUrls, value])

  const emitChange = useCallback(() => {
    const root = editorRef.current
    const next = serializeComposerElement(root)
    renderedValueRef.current = next
    onChange(next, getComposerSelectionOffset(root))
  }, [editorRef, onChange])

  const pastePlainText = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!insertPlainTextIntoComposer(editorRef.current, text)) return
      emitChange()
    } catch (err) {
      console.error('[agent-chat] paste plain text failed', err)
    }
  }, [editorRef, emitChange])

  return (
    <div className="relative min-h-[72px] px-4 pt-3.5 pb-2">
      {empty ? (
        <div className="pointer-events-none absolute left-4 top-3.5 text-[14px] leading-6 text-muted-foreground/55">
          {placeholder}
        </div>
      ) : null}
      <div
        ref={editorRef}
        contentEditable
        role="textbox"
        aria-multiline="true"
        spellCheck={false}
        suppressContentEditableWarning
        onInput={emitChange}
        onKeyDown={(event) => {
          if (
            event.key.toLowerCase() === 'v' &&
            event.shiftKey &&
            !event.altKey &&
            hasPrimaryModifier(event.nativeEvent)
          ) {
            event.preventDefault()
            event.stopPropagation()
            void pastePlainText()
            return
          }
          onKeyDown(event)
        }}
        onClick={(event) => {
          const target = event.target as HTMLElement
          const button = target.closest<HTMLButtonElement>('[data-remove-image-chip-index]')
          if (!button) return
          event.preventDefault()
          event.stopPropagation()
          const index = Number.parseInt(button.dataset.removeImageChipIndex ?? '', 10)
          const path = imageAttachments[index]
          if (path) onRemoveImage(path)
        }}
        onPaste={(event) => {
          const items = Array.from(event.clipboardData?.items ?? [])
          const imageFiles = items
            .filter((item) => item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file))
          if (imageFiles.length > 0) {
            event.preventDefault()
            onPasteImages(imageFiles, getComposerSelectionOffset(editorRef.current))
            return
          }

          const plainText = event.clipboardData?.getData('text/plain') ?? ''
          if (!plainText) return
          event.preventDefault()
          if (insertPlainTextIntoComposer(editorRef.current, plainText)) emitChange()
        }}
        className="scrollbar-hover min-h-[72px] max-h-[min(38vh,260px)] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-[14px] leading-6 text-foreground outline-none [overflow-wrap:anywhere] [&_[data-image-chip-index]]:mx-0.5"
      />
    </div>
  )
}

// Non-image composer attachments stay compact and text-first. Image attachments
// use the larger preview tiles above instead.
function ComposerAttachmentChip({ path, onRemove }: { path: string; onRemove: () => void }) {
  const name = path.split('/').pop() || path
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[6px] bg-foreground/5 py-0.5 pl-1 pr-1 text-[11px] text-muted-foreground/90"
      title={path}
    >
      <Paperclip className="ml-1 size-3" />
      <span className="max-w-[180px] truncate font-mono">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="ml-0.5 rounded p-0.5 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function ReplyPreview({
  replyTo,
  onClear,
  compact = false,
}: {
  replyTo: AgentReplyReference
  onClear?: () => void
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-[8px] bg-background/45 text-left shadow-minimal',
        compact ? 'px-2 py-1' : 'px-2.5 py-1.5',
      )}
    >
      <Reply className="size-3.5 shrink-0 text-cyan-200/80" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-cyan-100/90">{replyTo.label}</div>
        <div className="truncate text-[11.5px] text-muted-foreground/75">
          {replyTo.preview || 'No preview'}
        </div>
      </div>
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear reply"
          className="rounded p-1 text-muted-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  )
}

const USER_BUBBLE_MAX_HEIGHT = 540
const USER_BUBBLE_MARKDOWN_LIMIT = 12000
const USER_BUBBLE_TEXT_PREVIEW_LIMIT = 24000

const UserBubble = memo(function UserBubble({ message }: { message: AgentSessionMessage }) {
  const text = message.text
  const attachments = message.attachments
  const images = useMemo(() => (attachments ?? []).filter(isImagePath), [attachments])
  const others = useMemo(() => (attachments ?? []).filter((p) => !isImagePath(p)), [attachments])
  const hasText = text.length > 0 && /\S/.test(text)
  const isLargeText = text.length > USER_BUBBLE_MARKDOWN_LIMIT
  const canPreviewText = text.length > USER_BUBBLE_TEXT_PREVIEW_LIMIT
  const reduceMotion = useReducedMotion()
  const animateEntry = !reduceMotion && !isLargeText
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [renderLargeMarkdown, setRenderLargeMarkdown] = useState(false)
  const [showFullLargeText, setShowFullLargeText] = useState(false)
  const [setUserScrollElement, userFade] = useVerticalScrollFades(
    `${text.length}:${renderLargeMarkdown}:${showFullLargeText}`,
  )
  const userMask = getVerticalScrollFadeMask(userFade, 14, 14)
  const renderAsPlainText = isLargeText && !renderLargeMarkdown
  const previewingPlainText = renderAsPlainText && canPreviewText && !showFullLargeText
  const visiblePlainText = previewingPlainText
    ? `${text.slice(0, USER_BUBBLE_TEXT_PREVIEW_LIMIT)}\n\n...`
    : text
  const { startsWithImageToken, endsWithImageToken } = useMemo(
    () => getSingleLineImageTokenEdges(text),
    [text],
  )

  return (
    <div className="mt-8 flex w-full justify-end">
      <motion.div
        initial={animateEntry ? { opacity: 0, filter: 'blur(8px)', y: 4 } : false}
        animate={animateEntry ? { opacity: 1, filter: 'blur(0px)', y: 0 } : undefined}
        transition={{ duration: 0.28, ease: EASE_OUT }}
        className="group flex max-w-[78%] min-w-0 flex-col items-end gap-1.5 select-text"
      >
        <UserAttachmentPreviewDialog path={previewPath} onClose={() => setPreviewPath(null)} />
        {images.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((p) => (
              <AttachmentThumbnail key={p} path={p} onPreview={() => setPreviewPath(p)} />
            ))}
          </div>
        ) : null}
        {hasText ? (
          <div className="max-w-full overflow-hidden rounded-[12px] bg-foreground/5 shadow-minimal">
            {message.replyTo ? (
              <div className="px-2.5 pt-2">
                <ReplyPreview replyTo={message.replyTo} compact />
              </div>
            ) : null}
            <div
              ref={setUserScrollElement}
              className={cn(
                'scrollbar-hover max-w-full overflow-x-hidden overflow-y-auto overscroll-contain break-words py-2 text-[13px] leading-[1.45] text-foreground [overflow-wrap:anywhere]',
                startsWithImageToken ? 'pl-2' : 'pl-3.5',
                endsWithImageToken ? 'pr-2' : 'pr-3.5',
              )}
              style={{
                maxHeight: USER_BUBBLE_MAX_HEIGHT,
                maskImage: userMask,
                WebkitMaskImage: userMask,
                contentVisibility: 'auto',
                containIntrinsicSize: '0 180px',
              }}
            >
              <UserMessageText
                images={images}
                visiblePlainText={visiblePlainText}
                onPreview={setPreviewPath}
              />
            </div>
            {isLargeText ? (
              <div className="flex items-center justify-between gap-3 border-t border-border/30 px-3.5 py-1.5 text-[11px] text-muted-foreground/70">
                <span>{text.length.toLocaleString()} chars</span>
                <div className="flex items-center gap-1">
                  {renderAsPlainText && canPreviewText ? (
                    <button
                      type="button"
                      onClick={() => setShowFullLargeText((value) => !value)}
                      className="rounded-[5px] px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                    >
                      {showFullLargeText ? 'Preview' : 'Show full'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setRenderLargeMarkdown((value) => !value)}
                    className="rounded-[5px] px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                  >
                    {renderLargeMarkdown ? 'Plain text' : 'Render markdown'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {others.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1">
            {others.map((p) => (
              <AttachmentPill key={p} path={p} />
            ))}
          </div>
        ) : null}
      </motion.div>
    </div>
  )
})

function SystemLine({ message }: { message: AgentSessionMessage }) {
  return (
    <div className="flex items-center gap-2 px-3 py-0.5 text-[12px] text-muted-foreground select-none">
      <span className="h-px flex-1 bg-border/40" />
      <span className="shrink-0">{message.text}</span>
      <span className="h-px flex-1 bg-border/40" />
    </div>
  )
}

function CompactionLine({ message }: { message: AgentSessionMessage }) {
  const isRunning = message.status === 'in_progress'
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[12px] text-muted-foreground/55 select-none">
      <span className="h-px flex-1 bg-border/30" />
      <span className="flex shrink-0 items-center gap-1.5">
        {isRunning ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground/40" />
        ) : (
          <ArchiveRestore className="size-3 text-muted-foreground/40" />
        )}
        <span>{message.text}</span>
      </span>
      <span className="h-px flex-1 bg-border/30" />
    </div>
  )
}

function getReconnectStatus(text: string | null | undefined): {
  attempt: number | null
  total: number | null
} | null {
  const trimmed = text?.trim() ?? ''
  if (!trimmed) return null
  const match = trimmed.match(/^reconnecting(?:\.{3}|…)?\s*(?:(\d+)\s*\/\s*(\d+))?$/i)
  if (!match) return null
  const attempt = match[1] ? Number(match[1]) : null
  const total = match[2] ? Number(match[2]) : null
  return {
    attempt: Number.isFinite(attempt) ? attempt : null,
    total: Number.isFinite(total) ? total : null,
  }
}

function ErrorBubble({ message }: { message: AgentSessionMessage }) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[92%] rounded-[10px] border border-red-500/25 bg-red-500/8 px-4 py-3 text-[12.5px] text-red-300 select-text">
        <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-red-400/85">
          {message.title || 'Error'}
        </div>
        <div className="whitespace-pre-wrap break-words">{message.text}</div>
      </div>
    </div>
  )
}

type UsageLimitInfo = {
  agentLabel: string
  resetLabel: string | null
  url: string | null
}

// Pulls "You've hit your usage limit. Visit <url> to purchase more credits or
// try again at <date>." apart so the banner can show the reset time as a pill
// and the settings URL as a button instead of one truncated blob of text.
function parseUsageLimit(error: string, agent: AgentWindowNode['agent']): UsageLimitInfo | null {
  if (!/usage limit/i.test(error)) return null
  const urlMatch = error.match(/https?:\/\/\S+?(?=[\s.,)]|$)/)
  const resetMatch = error.match(/try again at\s+([^.]+?)(?:\.\s*$|$)/i)
  return {
    agentLabel: getAgentDisplayName(agent),
    resetLabel: resetMatch ? resetMatch[1].trim() : null,
    url: urlMatch ? urlMatch[0] : null,
  }
}

function SessionErrorBanner({
  error,
  agent,
  onRetry,
}: {
  error: string
  agent: AgentWindowNode['agent']
  onRetry: (() => void) | null
}) {
  const reconnect = getReconnectStatus(error)
  if (reconnect) {
    const attemptLabel =
      reconnect.attempt != null && reconnect.total != null
        ? `${reconnect.attempt}/${reconnect.total}`
        : null
    return (
      <div className="mb-2 flex items-center gap-2 rounded-[10px] bg-background/60 px-2.5 py-1.5 text-[12px] text-foreground/85 shadow-minimal backdrop-blur-md">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground/90">
          {getAgentDisplayName(agent)} reconnecting
        </span>
        {attemptLabel ? (
          <span className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground/80 shadow-minimal">
            {attemptLabel}
          </span>
        ) : null}
      </div>
    )
  }

  const usageLimit = parseUsageLimit(error, agent)
  if (usageLimit) {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-[10px] bg-background/60 px-2.5 py-1.5 text-[12px] text-foreground/85 shadow-minimal backdrop-blur-md">
        <Ban className="size-3.5 shrink-0 text-rose-300/85" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground/90">{usageLimit.agentLabel} usage limit reached</span>
          {usageLimit.resetLabel ? (
            <span className="text-muted-foreground/75"> · resets {usageLimit.resetLabel}</span>
          ) : null}
        </span>
        {usageLimit.url ? (
          <button
            type="button"
            onClick={() => void window.cells.app.openExternal(usageLimit.url as string)}
            className="inline-flex shrink-0 items-center gap-1 rounded-[6px] bg-foreground/8 px-2 py-0.5 text-[11px] font-medium text-foreground/85 transition-colors hover:bg-foreground/12"
            title={usageLimit.url}
          >
            Settings
            <ArrowUpRight className="size-3" />
          </button>
        ) : null}
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex shrink-0 items-center gap-1 rounded-[6px] bg-foreground/8 px-2 py-0.5 text-[11px] font-medium text-foreground/85 transition-colors hover:bg-foreground/12"
            title="Resend last message"
          >
            <RotateCcw className="size-3" />
            Retry
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mb-2 flex items-center gap-2 rounded-[10px] border border-red-500/20 bg-red-500/7 px-2.5 py-1.5 text-[12px] text-red-300 shadow-minimal backdrop-blur-md">
      <X className="size-3.5 shrink-0 text-red-300/80" />
      <span className="min-w-0 flex-1 truncate">{error}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1 rounded-[6px] bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-200 transition-colors hover:bg-red-500/25"
          title="Resend last message"
        >
          <RotateCcw className="size-3" />
          Retry
        </button>
      ) : null}
    </div>
  )
}

type QueuedMessage = QueuedAgentMessage
type QueuedMessageSettings = Pick<QueuedMessage, 'model' | 'thinkingLevel' | 'permissionMode'>
const ATTACHMENTS_ONLY_TEXT = '(attached files)'

function createQueuedMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function sanitizeQueuedMessages(messages: QueuedMessage[]): QueuedMessage[] {
  // Backfill ids for entries persisted before the id field existed so React
  // keys and Framer layoutIds stay unique even when two messages have
  // identical text/attachments/mode.
  return messages
    .filter((message) => message.mode !== 'stop')
    .map((message) => (message.id ? message : { ...message, id: createQueuedMessageId() }))
}

function getQueuedComposerText(message: QueuedMessage) {
  return message.attachments.length > 0 && message.text === ATTACHMENTS_ONLY_TEXT
    ? ''
    : message.text
}

function getQueuedStoredText(text: string, attachments: string[]) {
  const trimmed = text.trim()
  if (trimmed) return trimmed
  return attachments.length > 0 ? ATTACHMENTS_ONLY_TEXT : ''
}

function formatModifiedEnter(modifierLabel: string) {
  return modifierLabel.length === 1 ? `${modifierLabel}↩` : `${modifierLabel}+↩`
}

function isBranchComposerEnter(input: { altKey: boolean; shiftKey: boolean }, hasPrimary: boolean) {
  return hasPrimary && input.altKey && !input.shiftKey
}

function isViewportFitEnter(input: { altKey: boolean; shiftKey: boolean }, hasPrimary: boolean) {
  return hasPrimary && input.shiftKey && !input.altKey
}

function getQueueModeMeta(): Record<
  QueuedMessage['mode'],
  { Icon: typeof Zap; tint: string; shortcut: string; hint: string; label: string }
> {
  return {
    stop: {
      Icon: Zap,
      tint: 'text-rose-400/90',
      shortcut: formatModifiedEnter(getPrimaryModifierLabel()),
      label: 'Interrupt',
      hint: 'Interrupt the agent now and send this next.',
    },
    'after-tool': {
      Icon: FastForward,
      tint: 'text-violet-400/90',
      shortcut: formatModifiedEnter(getAltModifierLabel()),
      label: 'After next tool',
      hint: 'Send as soon as the next tool call finishes — don’t cut off a running tool.',
    },
    'after-turn': {
      Icon: Clock,
      tint: 'text-amber-400/90',
      shortcut: '↩',
      label: 'After this turn',
      hint: 'Send after the current turn finishes naturally.',
    },
  }
}

type ChatGroup =
  | { kind: 'user'; key: string; message: AgentSessionMessage }
  | {
      kind: 'turn'
      key: string
      activities: AgentSessionMessage[]
      responses: AgentSessionMessage[]
      changedFilesActivities?: AgentSessionMessage[]
      // Interim assistant text that preceded this turn's tool calls. When the
      // agent emits prose between tool groups, we demote that prose from its
      // own ResponseCard into the next turn's header line — it reads as the
      // intent behind the upcoming activity instead of a separate bubble.
      leadText?: string
      leadResponses?: AgentSessionMessage[]
    }
  | { kind: 'error'; key: string; message: AgentSessionMessage }
  | { kind: 'auth'; key: string; message: AgentSessionMessage }
  | { kind: 'system'; key: string; message: AgentSessionMessage }
  | { kind: 'compaction'; key: string; message: AgentSessionMessage }

function areStringArraysEqual(previous: string[] | undefined, next: string[] | undefined): boolean {
  if (previous === next) return true
  if (!previous || !next) return !previous && !next
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false
  }
  return true
}

function areReplyReferencesEqual(
  previous: AgentReplyReference | null | undefined,
  next: AgentReplyReference | null | undefined,
) {
  if (previous === next) return true
  if (!previous || !next) return !previous && !next
  return (
    previous.id === next.id &&
    previous.role === next.role &&
    previous.label === next.label &&
    previous.preview === next.preview &&
    previous.title === next.title
  )
}

function isAgentSessionMessageUnchanged(
  previous: AgentSessionMessage,
  next: AgentSessionMessage,
): boolean {
  return (
    previous.id === next.id &&
    previous.role === next.role &&
    previous.text === next.text &&
    previous.title === next.title &&
    previous.metadata === next.metadata &&
    previous.status === next.status &&
    previous.startedAt === next.startedAt &&
    previous.updatedAt === next.updatedAt &&
    previous.authLoginUrl === next.authLoginUrl &&
    previous.parentToolUseId === next.parentToolUseId &&
    previous.toolUseId === next.toolUseId &&
    areReplyReferencesEqual(previous.replyTo, next.replyTo) &&
    areStringArraysEqual(previous.attachments, next.attachments)
  )
}

function areMessageRefsEqual(
  previous: AgentSessionMessage[],
  next: AgentSessionMessage[],
): boolean {
  if (previous === next) return true
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false
  }
  return true
}

function isChatGroupUnchanged(previous: ChatGroup, next: ChatGroup): boolean {
  if (previous.kind !== next.kind || previous.key !== next.key) return false
  switch (previous.kind) {
    case 'user':
    case 'error':
    case 'auth':
    case 'system':
    case 'compaction':
      return previous.message === (next as typeof previous).message
    case 'turn': {
      const nextTurn = next as typeof previous
      return (
        areMessageRefsEqual(
          previous.changedFilesActivities ?? [],
          nextTurn.changedFilesActivities ?? [],
        ) &&
        previous.leadText === nextTurn.leadText &&
        areMessageRefsEqual(previous.leadResponses ?? [], nextTurn.leadResponses ?? []) &&
        areMessageRefsEqual(previous.activities, nextTurn.activities) &&
        areMessageRefsEqual(previous.responses, nextTurn.responses)
      )
    }
    default:
      return false
  }
}

/**
 * Group messages into Craft-style turns:
 *   - Each user message stands alone.
 *   - Consecutive non-user messages collapse into a single "turn" whose
 *     assistant messages become the response and whose reasoning / tool /
 *     system messages become the activities stripe.
 *   - Errors and auth prompts are lifted out of the group so they render
 *     as their own cards (matches Craft).
 */
function chatGroupKey(group: ChatGroup): string {
  return group.key
}

function turnHasVisibleResponse(group: Extract<ChatGroup, { kind: 'turn' }>) {
  return group.responses.some((response) => response.text.trim().length > 0)
}

function finalizeTurnGroups(groups: ChatGroup[]): ChatGroup[] {
  const nextGroups = groups.slice()
  let runStart = 0

  const finalizeRun = (start: number, endExclusive: number) => {
    if (start >= endExclusive) return
    let anchorIndex = -1
    let lastActivityIndex = -1
    const aggregatedActivities: AgentSessionMessage[] = []

    for (let index = start; index < endExclusive; index += 1) {
      const group = nextGroups[index]
      if (group.kind !== 'turn') return
      aggregatedActivities.push(...group.activities)
      if (group.activities.length > 0) lastActivityIndex = index
    }

    if (lastActivityIndex >= start) {
      for (let index = lastActivityIndex; index < endExclusive; index += 1) {
        const group = nextGroups[index]
        if (group.kind === 'turn' && turnHasVisibleResponse(group)) anchorIndex = index
      }
    }

    for (let index = start; index < endExclusive; index += 1) {
      const group = nextGroups[index]
      if (group.kind !== 'turn') continue
      const changedFilesActivities = index === anchorIndex ? aggregatedActivities : undefined
      if (areMessageRefsEqual(group.changedFilesActivities ?? [], changedFilesActivities ?? []))
        continue
      nextGroups[index] = { ...group, changedFilesActivities }
    }
  }

  for (let index = 0; index <= nextGroups.length; index += 1) {
    const group = nextGroups[index]
    if (group?.kind === 'turn') continue
    finalizeRun(runStart, index)
    runStart = index + 1
  }

  return nextGroups
}

function groupMessages(messages: AgentSessionMessage[]): ChatGroup[] {
  const groups: ChatGroup[] = []
  let pending: { activities: AgentSessionMessage[]; responses: AgentSessionMessage[] } | null = null
  let turnIndex = 0

  const flushPending = () => {
    if (!pending) return
    if (pending.activities.length === 0 && pending.responses.length === 0) {
      pending = null
      return
    }
    groups.push({
      kind: 'turn',
      key: `turn-${turnIndex++}`,
      activities: pending.activities,
      responses: pending.responses,
    })
    pending = null
  }

  for (const message of messages) {
    if (message.role === 'error' && getReconnectStatus(message.text)) continue
    // Subagent traffic (anything with a parentToolUseId) belongs INSIDE the
    // Task tool row, not as its own group. The parent Task row renders it
    // hierarchically via AgentTurnCard. We still push those messages into the
    // pending activities so the TurnCard can look them up — user bubbles from
    // subagents are dropped entirely since they're system-prompt noise.
    if (message.parentToolUseId) {
      if (message.role === 'user') continue
      if (!pending) pending = { activities: [], responses: [] }
      // Assistant text from a subagent still lives in the activities stripe
      // (rendered as a child of the Task row), not as the top-level response.
      pending.activities.push(message)
      continue
    }

    switch (message.role) {
      case 'user':
        flushPending()
        groups.push({ kind: 'user', key: message.id, message })
        break
      case 'error':
        flushPending()
        groups.push({ kind: 'error', key: message.id, message })
        break
      case 'auth_request':
        flushPending()
        groups.push({ kind: 'auth', key: message.id, message })
        break
      case 'compaction':
        flushPending()
        groups.push({ kind: 'compaction', key: message.id, message })
        break
      case 'assistant':
      case 'reasoning':
      case 'tool':
      case 'system': {
        // Preserve chronological order of assistant text vs tool activity.
        // Whenever a non-assistant message (tool / reasoning / system) arrives
        // after any assistant response has already landed in the current turn,
        // close that turn and open a new one. Without this, a sequence like
        // [tool, tool, text, tool, tool] would collapse both tool pairs into
        // a single activities stripe above one response — the second pair
        // needs to render BELOW the text, not merged with the first pair.
        if (message.role !== 'assistant' && pending && pending.responses.length > 0) {
          flushPending()
        }
        if (!pending) pending = { activities: [], responses: [] }
        if (message.role === 'assistant') pending.responses.push(message)
        else pending.activities.push(message)
        break
      }
      default:
        break
    }
  }
  flushPending()
  return finalizeTurnGroups(demoteInterimResponses(groups))
}

// Walks the grouped output and moves any "interim" assistant responses
// (responses in a turn that is immediately followed by another turn) into
// the next turn's `leadText`. The current turn keeps only its activities;
// if it had no activities either, it is dropped entirely.
//
// Example: [tool_a, tool_b, text, tool_c, tool_d] groups as
//   turn1(acts=[a,b], resp=[text]) + turn2(acts=[c,d])
// After demotion:
//   turn1(acts=[a,b]) + turn2(acts=[c,d], leadText=text)
function demoteInterimResponses(groups: ChatGroup[]): ChatGroup[] {
  const working: ChatGroup[] = groups.slice()
  const result: ChatGroup[] = []
  for (let i = 0; i < working.length; i++) {
    const g = working[i]
    if (g.kind === 'turn' && g.responses.length > 0) {
      const next = working[i + 1]
      if (next && next.kind === 'turn' && next.activities.length > 0) {
        const leadText = g.responses
          .map((r) => r.text)
          .join('\n\n')
          .trim()
        working[i + 1] = {
          ...next,
          // If the previous turn was only this assistant text, keep its row
          // identity while it becomes the next turn's lead text. Otherwise the
          // same response remounts and replays the row entrance animation.
          key: g.activities.length > 0 ? next.key : g.key,
          leadText: leadText || next.leadText,
          leadResponses: g.responses,
        }
        if (g.activities.length > 0) {
          result.push({
            kind: 'turn',
            key: g.key,
            activities: g.activities,
            responses: [],
            leadText: g.leadText,
            leadResponses: g.leadResponses,
          })
        }
        continue
      }
    }
    result.push(g)
  }
  return result
}

// Craft-style "working" pill shown while the agent is running but hasn't
// produced a turn yet. Matches the ⋮⋮ Zipping… 4s row under the user bubble.
function PendingTurnIndicator({ agent }: { agent: AgentWindowNode['agent'] }) {
  return (
    <LoadingIndicator
      label={`${agent === 'claude' ? 'Claude Code' : 'Codex'} is thinking`}
      showElapsed
      className="py-1.5 pl-1.5 pr-2.5 text-[12px] text-muted-foreground"
    />
  )
}

function SkeletonBlock({ className }: { className: string }) {
  return <div className={cn('animate-pulse rounded-[6px] bg-foreground/6', className)} />
}

function ChatLoadingSkeleton() {
  return (
    <div className="space-y-5 px-2 pt-2" aria-hidden>
      <div className="mt-8 flex w-full justify-end">
        <div className="flex max-w-[78%] min-w-0 flex-col items-end gap-1.5">
          <div className="w-[min(420px,62vw)] max-w-full rounded-[12px] bg-foreground/5 px-3.5 py-2 shadow-minimal">
            <SkeletonBlock className="h-3.5 w-[86%]" />
            <SkeletonBlock className="mt-2 h-3.5 w-[58%]" />
          </div>
        </div>
      </div>

      <div className="w-full space-y-1">
        <div className="flex w-full items-center gap-2 overflow-hidden rounded-[8px] py-1.5 pl-2.5 pr-2.5">
          <SkeletonBlock className="h-[18px] w-5 shrink-0 rounded-[4px]" />
          <SkeletonBlock className="h-3.5 w-[42%]" />
          <SkeletonBlock className="ml-auto h-3 w-3 rounded-full" />
        </div>
        <div className="relative overflow-hidden rounded-[12px] bg-[var(--elevated-surface)] shadow-minimal">
          <div className="px-4 py-3">
            <SkeletonBlock className="h-3.5 w-[82%]" />
            <SkeletonBlock className="mt-2 h-3.5 w-[70%]" />
            <SkeletonBlock className="mt-2 h-3.5 w-[92%]" />
            <SkeletonBlock className="mt-2 h-3.5 w-[46%]" />
          </div>
          <div className="border-t border-border/30 px-4 py-2">
            <SkeletonBlock className="h-3 w-24" />
          </div>
        </div>
      </div>

      <div className="flex w-full justify-end">
        <div className="flex max-w-[78%] min-w-0 flex-col items-end gap-1.5">
          <div className="w-[min(340px,54vw)] max-w-full rounded-[12px] bg-foreground/5 px-3.5 py-2 shadow-minimal">
            <SkeletonBlock className="h-3.5 w-[72%]" />
          </div>
        </div>
      </div>

      <div className="w-full space-y-1">
        <div className="flex w-full items-center gap-2 overflow-hidden rounded-[8px] py-1.5 pl-2.5 pr-2.5">
          <SkeletonBlock className="h-[18px] w-5 shrink-0 rounded-[4px]" />
          <SkeletonBlock className="h-3.5 w-[35%]" />
          <SkeletonBlock className="ml-auto h-3.5 w-16" />
          <SkeletonBlock className="h-3 w-3 rounded-full" />
        </div>
        <div className="ml-[18px] border-l-2 border-border/40 py-0.5 pl-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 rounded-[6px] px-1 py-0.5">
              <SkeletonBlock className="h-3 w-3 shrink-0 rounded-full" />
              <SkeletonBlock className="h-3.5 w-[48%]" />
            </div>
            <div className="flex items-center gap-2 rounded-[6px] px-1 py-0.5">
              <SkeletonBlock className="h-3 w-3 shrink-0 rounded-full" />
              <SkeletonBlock className="h-3.5 w-[38%]" />
              <SkeletonBlock className="h-4 w-12 rounded-[4px]" />
            </div>
          </div>
        </div>
        <div className="relative overflow-hidden rounded-[12px] bg-[var(--elevated-surface)] shadow-minimal">
          <div className="px-4 py-3">
            <SkeletonBlock className="h-3.5 w-[76%]" />
            <SkeletonBlock className="mt-2 h-3.5 w-[88%]" />
            <SkeletonBlock className="mt-2 h-3.5 w-[52%]" />
          </div>
          <div className="border-t border-border/30 px-4 py-2">
            <SkeletonBlock className="h-3 w-32" />
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-2 pt-1 text-[12px] text-muted-foreground/55">
          <SkeletonBlock className="h-3 w-3 rounded-[3px]" />
          <SkeletonBlock className="h-3 w-28" />
          <SkeletonBlock className="h-3 w-14" />
        </div>
      </div>
    </div>
  )
}

// Banner shown above the composer while Claude has called ExitPlanMode and
// is waiting on the user's decision. Mirrors the Claude Code CLI's three
// prompt options verbatim: auto-accept, manually approve, or keep planning.
function CodexPlanBanner({ plan }: { plan: CodexPlanSnapshot }) {
  const [collapsed, setCollapsed] = useState(false)
  const reduceMotion = useReducedMotion()
  const total = plan.items.length
  const done = plan.items.filter((item) => item.completed).length
  const currentItem = plan.items.find((item) => !item.completed)
  if (total === 0) return null
  const headerLabel = collapsed && currentItem ? currentItem.text : 'Plan'
  return (
    <div className="mb-2 overflow-hidden rounded-[12px] bg-background/55 backdrop-blur-md select-none">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        title={collapsed ? 'Show plan' : 'Hide plan'}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/[0.04] focus:outline-none"
      >
        <span className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums shadow-minimal">
          {done}/{total}
        </span>
        <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          {headerLabel}
        </span>
        <ChevronRight
          className={cn(
            'ml-auto size-3.5 shrink-0 text-muted-foreground/70 transition-transform',
            !collapsed && 'rotate-90',
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            key="plan-items"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0 }}
            transition={EXPAND_TRANSITION}
            style={{ overflow: 'hidden' }}
          >
            <ul className="flex flex-col gap-px p-1">
              {plan.items.map((item, idx) => (
                <li
                  key={`${idx}-${item.text}`}
                  className="flex items-start gap-2 rounded-[8px] px-2 py-1.5 text-[12px] text-foreground/85 hover:bg-foreground/[0.03]"
                >
                  {item.completed ? (
                    <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
                  ) : (
                    <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 break-words leading-[1.45]',
                      item.completed && 'text-muted-foreground/55 line-through',
                    )}
                  >
                    {item.text}
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function AgentApprovalBanner({
  windowId,
  approval,
}: {
  windowId: string
  approval: PendingAgentApproval
}) {
  const [busy, setBusy] = useState<'accept' | 'acceptForSession' | 'decline' | null>(null)
  const respond = useCallback(
    async (decision: 'accept' | 'acceptForSession' | 'decline') => {
      if (busy) return
      setBusy(decision)
      try {
        await window.cells.agentSession.respondApproval(windowId, decision)
      } catch (err) {
        console.error('[agent-chat] respondApproval failed', err)
      } finally {
        setBusy(null)
      }
    },
    [busy, windowId],
  )

  return (
    <div className="mb-2 overflow-hidden rounded-[12px] bg-background/55 p-2.5 backdrop-blur-md">
      <div className="mb-1.5 flex items-center gap-2 px-0.5">
        <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          {approval.title}
        </span>
      </div>
      <div className="space-y-1">
        {approval.detail ? (
          <div className="rounded-[8px] bg-background/60 px-2.5 py-2 text-[12px] leading-[1.45] text-foreground/90 shadow-minimal">
            {approval.detail}
          </div>
        ) : null}
        {approval.reason ? (
          <div className="px-0.5 text-[11px] leading-[1.45] text-muted-foreground/80">
            Reason: {approval.reason}
          </div>
        ) : null}
        {approval.cwd ? (
          <div className="px-0.5 text-[11px] leading-[1.45] text-muted-foreground/80">
            Cwd: {truncateCwd(approval.cwd)}
          </div>
        ) : null}
        {approval.grantRoot ? (
          <div className="px-0.5 text-[11px] leading-[1.45] text-muted-foreground/80">
            Grant root: {truncateCwd(approval.grantRoot)}
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void respond('decline')}
          className="rounded-[8px] px-2 py-1 text-[12px] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </button>
        {approval.canApproveForSession ? (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void respond('acceptForSession')}
            className="rounded-[8px] bg-background/60 px-2.5 py-1 text-[12px] text-foreground/90 shadow-minimal transition-colors hover:bg-background/80 disabled:cursor-wait disabled:opacity-60"
          >
            {busy === 'acceptForSession' ? 'Approving…' : 'Allow for session'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void respond('accept')}
          className="rounded-[8px] bg-foreground/90 px-2.5 py-1 text-[12px] font-medium text-background shadow-minimal transition-colors hover:bg-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {busy === 'accept' ? 'Approving…' : 'Allow once'}
        </button>
      </div>
    </div>
  )
}

function PlanApprovalBanner({
  windowId,
  agent,
  onOpenPlan,
  planOpen,
}: {
  windowId: string
  agent: AgentWindowNode['agent']
  onOpenPlan: () => void
  planOpen: boolean
}) {
  const [busy, setBusy] = useState<'auto-accept' | 'ask' | 'reject' | null>(null)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  const agentName = getAgentDisplayName(agent)
  const respond = useCallback(
    async (decision: 'auto-accept' | 'ask' | 'reject', note?: string) => {
      if (busy) return
      setBusy(decision)
      try {
        await window.cells.agentSession.respondPlan(windowId, decision, note)
        // Backend flipped its own permission mode — mirror that into the
        // zustand store so the PermissionPicker chip updates immediately
        // instead of drifting out of sync until the user touches it.
        if (decision === 'auto-accept') {
          useStore.getState().syncAgentWindow(windowId, { permissionMode: 'bypass' })
        } else if (decision === 'ask') {
          useStore.getState().syncAgentWindow(windowId, { permissionMode: 'ask' })
        }
      } catch (err) {
        console.error('[agent-chat] respondPlan failed', err)
      } finally {
        setBusy(null)
      }
    },
    [busy, windowId],
  )
  const optionClass =
    'flex w-full items-start gap-2 rounded-[10px] px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-foreground/[0.04] disabled:cursor-wait disabled:opacity-60'
  return (
    <div className="mb-2 overflow-hidden rounded-[12px] bg-background/55 p-2.5 backdrop-blur-md">
      <div className="mb-1.5 flex items-center gap-2 px-0.5">
        <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          {agentName} proposed a plan
        </span>
        <button
          type="button"
          onClick={onOpenPlan}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] transition-colors',
            planOpen
              ? 'bg-foreground/10 text-foreground/90'
              : 'text-muted-foreground/80 hover:bg-foreground/5 hover:text-foreground',
          )}
          title={planOpen ? 'Hide plan' : 'View plan'}
        >
          <FileText className="size-3" />
          {planOpen ? 'Hide plan' : 'View plan'}
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void respond('auto-accept')}
          className={optionClass}
        >
          <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium text-foreground/80">
            1
          </span>
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="font-medium text-foreground">
              {busy === 'auto-accept' ? 'Starting…' : 'Implement — auto-accept edits'}
            </span>
            <span className="text-[11px] text-muted-foreground/80">
              Switch to Yolo — {agentName} runs tools without asking.
            </span>
          </span>
          <Zap className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void respond('ask')}
          className={optionClass}
        >
          <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium text-foreground/80">
            2
          </span>
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="font-medium text-foreground">
              {busy === 'ask' ? 'Starting…' : 'Implement — approve each edit'}
            </span>
            <span className="text-[11px] text-muted-foreground/80">
              Switch to Ask — approve each write / bash individually.
            </span>
          </span>
          <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => setShowFeedback((v) => !v)}
          className={optionClass}
        >
          <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium text-foreground/80">
            3
          </span>
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="font-medium text-foreground">Keep refining</span>
            <span className="text-[11px] text-muted-foreground/80">
              Stay in Plan mode
              {showFeedback ? ' — add feedback below' : ' — optionally add feedback'}.
            </span>
          </span>
          <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
      </div>
      {showFeedback ? (
        <div className="mt-2 space-y-1.5 px-0.5">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder={`What should ${agentName} change about the plan? (optional)`}
            className="block w-full resize-none rounded-[8px] bg-foreground/5 px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 outline-none focus:bg-foreground/[0.07]"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => {
                setShowFeedback(false)
                setFeedback('')
              }}
              className="rounded-[6px] px-2 py-1 text-[11.5px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void respond('reject', feedback)}
              className="rounded-[8px] bg-foreground/90 px-2.5 py-1 text-[12px] font-medium text-background transition-colors hover:bg-foreground disabled:cursor-wait disabled:opacity-60"
            >
              {busy === 'reject' ? 'Sending…' : feedback.trim() ? 'Send feedback' : 'Keep refining'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// Default width used by the animated side-panel wrapper. We pin to a concrete
// value so framer-motion's `width: 0 → N → 0` transition has stable endpoints
// and the panel doesn't wobble during the expand.
const SIDE_PANEL_DEFAULT_WIDTH = 440
const SIDE_PANEL_MIN_WIDTH = 320
const SIDE_PANEL_MAX_WIDTH = 900
const SIDE_PANEL_WIDTH_STORAGE_KEY = 'agent-chat.sidePanelWidth'

// Right-side side-panel that renders the full proposed plan as markdown.
// Opened from the PlanApprovalBanner's "View plan" button. The markdown is
// rendered flush inside the panel (no inner card) so it reads as the primary
// content of the surface, not a tooltip. A 4px drag handle on the left edge
// resizes the panel; the chosen width persists to localStorage across reopens.
function PlanPreviewPanel({
  agent,
  plan,
  width,
  onClose,
  onResizeStart,
}: {
  agent: AgentWindowNode['agent']
  plan: string
  width: number
  onClose: () => void
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  const [copied, setCopied] = useState(false)
  const agentName = getAgentDisplayName(agent)
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(plan)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard blocked — ignore */
    }
  }, [plan])
  return (
    <div
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-border/50 bg-background"
      style={{ width }}
    >
      {/* Resize handle — sits flush on the left edge, invisible until hover /
          active drag. Pointer events are handled via onPointerDown so the drag
          continues even if the cursor escapes the 4px strip. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
        className="group/resize absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize"
      >
        <div className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover/resize:bg-primary/40 group-active/resize:bg-primary/60" />
      </div>
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {agentName}'s proposed plan
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            'inline-flex items-center gap-1 rounded-[6px] px-1.5 py-1 text-[11.5px] transition-colors',
            copied
              ? 'bg-foreground/10 text-foreground/90'
              : 'text-muted-foreground/80 hover:bg-foreground/5 hover:text-foreground',
          )}
          title="Copy plan markdown"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[6px] p-1 text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
          title="Hide plan"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="select-text text-sm text-foreground/90">
          <AgentMarkdown>{plan}</AgentMarkdown>
        </div>
      </div>
    </div>
  )
}

// Banner shown above the composer while Claude has called AskUserQuestion and
// is waiting on the user's answers. One group per question, rendered as radio
// (single-select) or checkbox (multi-select) lists. Submitting sends the
// answers back through canUseTool; Dismiss tells the agent to proceed
// without the input.
function QuestionBanner({
  windowId,
  agent,
  questions,
}: {
  windowId: string
  agent: AgentWindowNode['agent']
  questions: PendingQuestion[]
}) {
  const questionKey = useCallback((q: PendingQuestion) => q.id || q.question, [])
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    for (const q of questions) init[questionKey(q)] = []
    return init
  })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'submit' | 'cancel' | null>(null)

  const toggle = useCallback((q: PendingQuestion, label: string) => {
    const key = q.id || q.question
    setSelections((prev) => {
      const current = prev[key] ?? []
      if (q.multiSelect) {
        const has = current.includes(label)
        const next = has ? current.filter((x) => x !== label) : [...current, label]
        return { ...prev, [key]: next }
      }
      return { ...prev, [key]: [label] }
    })
  }, [])

  const trimmedNote = note.trim()
  const hasAllSelections = questions.every((q) => (selections[questionKey(q)]?.length ?? 0) > 0)
  const hasAnySelection = questions.some((q) => (selections[questionKey(q)]?.length ?? 0) > 0)
  const canSubmit = hasAllSelections || trimmedNote.length > 0 || hasAnySelection

  const submit = useCallback(async () => {
    if (busy || !canSubmit) return
    setBusy('submit')
    try {
      const payload = hasAnySelection || hasAllSelections ? selections : null
      await window.cells.agentSession.respondQuestion(windowId, payload, trimmedNote || null)
    } catch (err) {
      console.error('[agent-chat] respondQuestion failed', err)
    } finally {
      setBusy(null)
    }
  }, [busy, canSubmit, hasAllSelections, hasAnySelection, selections, trimmedNote, windowId])

  const cancel = useCallback(async () => {
    if (busy) return
    setBusy('cancel')
    try {
      await window.cells.agentSession.respondQuestion(windowId, null, trimmedNote || null)
    } catch (err) {
      console.error('[agent-chat] respondQuestion cancel failed', err)
    } finally {
      setBusy(null)
    }
  }, [busy, trimmedNote, windowId])

  return (
    <div className="mb-2 overflow-hidden rounded-[12px] bg-background/55 p-2.5 backdrop-blur-md">
      <div className="mb-2 flex items-center gap-2 px-2">
        <HelpCircle className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          {questions.length === 1
            ? `${getAgentDisplayName(agent)} needs an answer`
            : `${getAgentDisplayName(agent)} needs ${questions.length} answers`}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {questions.map((q) => {
          const selected = selections[questionKey(q)] ?? []
          return (
            <div key={questionKey(q)} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-2">
                {q.header ? (
                  <span className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/70 shadow-minimal">
                    {q.header}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 text-[12.5px] text-foreground/90">
                  {q.question}
                </span>
                {q.multiSelect ? (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    Multi-select
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-px">
                {q.options.map((opt) => {
                  const isSelected = selected.includes(opt.label)
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={!!busy}
                      aria-pressed={isSelected}
                      onClick={() => toggle(q, opt.label)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] transition-colors disabled:cursor-wait disabled:opacity-60',
                        isSelected ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.03]',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center transition-colors',
                          q.multiSelect ? 'rounded-[3px]' : 'rounded-full',
                          isSelected ? 'bg-foreground text-background' : 'bg-foreground/[0.08]',
                        )}
                      >
                        {isSelected ? <Check className="size-2.5" strokeWidth={3} /> : null}
                      </span>
                      <span className="flex flex-1 flex-col gap-0.5">
                        <span className="text-foreground/90">{opt.label}</span>
                        {opt.description ? (
                          <span className="text-[11px] leading-[1.45] text-muted-foreground/75">
                            {opt.description}
                          </span>
                        ) : null}
                        {opt.preview ? (
                          <pre className="mt-1 max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-background/60 px-2 py-1 font-mono text-[11px] leading-[1.45] text-foreground/75 shadow-minimal">
                            {opt.preview}
                          </pre>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-2">
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && hasPrimaryModifier(event)) {
              event.preventDefault()
              void submit()
            }
          }}
          disabled={!!busy}
          rows={1}
          placeholder="Add a note or type a custom answer…"
          className="block w-full resize-none rounded-[8px] bg-background/60 px-2.5 py-1.5 text-[12px] leading-[1.45] text-foreground/90 shadow-minimal outline-none placeholder:text-muted-foreground/55 focus:bg-background/80 disabled:cursor-wait disabled:opacity-60"
        />
      </div>
      <div className="mt-2 flex items-center justify-end gap-1">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void cancel()}
          className="rounded-[8px] px-2 py-1 text-[12px] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {busy === 'cancel' ? 'Skipping…' : 'Skip'}
        </button>
        <button
          type="button"
          disabled={!!busy || !canSubmit}
          onClick={() => void submit()}
          className="rounded-[8px] bg-foreground/90 px-2.5 py-1 text-[12px] font-medium text-background shadow-minimal transition-colors hover:bg-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === 'submit'
            ? 'Sending…'
            : hasAllSelections || hasAnySelection
              ? 'Send answer'
              : 'Send note'}
        </button>
      </div>
    </div>
  )
}

function BackgroundActivityBanner({
  agent,
  activities,
  onStop,
}: {
  agent: AgentWindowNode['agent']
  activities: AgentSessionMessage[]
  onStop: () => void
}) {
  const oldestStartedAt = activities.reduce<number | null>((oldest, activity) => {
    const startedAt = activity.startedAt ?? activity.updatedAt ?? null
    if (!startedAt) return oldest
    return oldest == null ? startedAt : Math.min(oldest, startedAt)
  }, null)
  const elapsed = formatElapsedMs(oldestStartedAt)
  const agentName = getAgentDisplayName(agent)

  return (
    <div className="mb-2 min-w-0 select-none">
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/70" />
        <div className="min-w-0 flex-1">
          <span className="truncate text-[12px] font-medium text-foreground/90">
            {activities.length === 1
              ? `${agentName} is still running in the background`
              : `${agentName} still has ${activities.length} background tasks running`}
          </span>
          {elapsed ? (
            <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground/60">
              {elapsed}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onStop}
          className="inline-flex shrink-0 items-center gap-1 rounded-[8px] bg-foreground px-2.5 py-1 text-[11.5px] font-medium text-background shadow-minimal transition-colors hover:bg-foreground/90"
        >
          <Square className="size-3 fill-current" />
          Stop
        </button>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        {activities.slice(0, 3).map((activity) => {
          const details = getActivityPreview(activity)
          const started = activity.startedAt ? formatElapsedMs(activity.startedAt) : null
          return (
            <div
              key={activity.id}
              className="flex min-w-0 items-center gap-2 overflow-hidden rounded-[10px] bg-foreground/5 px-2.5 py-1.5 text-[12px] text-foreground/85"
            >
              <Clock className="size-3.5 shrink-0 text-muted-foreground/60" />
              <span className="max-w-[28%] shrink-0 truncate font-medium text-foreground/90">
                {activity.title || 'Activity'}
              </span>
              {details.preview ? (
                <span
                  className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground/75"
                  title={details.preview}
                >
                  {details.preview}
                </span>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              {started ? (
                <span className="shrink-0 tabular-nums text-[10.5px] text-muted-foreground/60">
                  {started}
                </span>
              ) : null}
            </div>
          )
        })}
        {activities.length > 3 ? (
          <div className="px-2 pt-0.5 text-[10.5px] text-muted-foreground/60">
            +{activities.length - 3} more active {activities.length - 3 === 1 ? 'task' : 'tasks'}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function GroupRenderer({
  group,
  cwd,
  agent,
  isStreamingLastTurn,
  onReply,
}: {
  group: ChatGroup
  cwd?: string | null
  agent: AgentWindowNode['agent']
  isStreamingLastTurn: boolean
  onReply: (replyTo: AgentReplyReference) => void
}) {
  switch (group.kind) {
    case 'user':
      return <UserBubble message={group.message} />
    case 'turn':
      return (
        <AgentTurnCard
          activities={group.activities}
          responses={group.responses}
          changedFilesActivities={group.changedFilesActivities}
          leadText={group.leadText}
          leadResponses={group.leadResponses}
          cwd={cwd}
          agent={agent}
          isStreaming={isStreamingLastTurn}
          onReply={onReply}
        />
      )
    case 'error':
      return <ErrorBubble message={group.message} />
    case 'auth':
      return <AgentAuthCard message={group.message} agent={agent} />
    case 'system':
      return <SystemLine message={group.message} />
    case 'compaction':
      return <CompactionLine message={group.message} />
    default:
      return null
  }
}

const MessageGroupRow = memo(
  function MessageGroupRow({
    group,
    cwd,
    agent,
    isStreamingLastTurn,
    onReply,
  }: {
    group: ChatGroup
    cwd?: string | null
    agent: AgentWindowNode['agent']
    isStreamingLastTurn: boolean
    onReply: (replyTo: AgentReplyReference) => void
  }) {
    const reduceMotion = useReducedMotion()
    return (
      <motion.div
        className="min-w-0 p-[1px]"
        style={{ contain: 'layout style' }}
        initial={reduceMotion || isStreamingLastTurn ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18, ease: EASE_OUT }}
      >
        <GroupRenderer
          group={group}
          cwd={cwd}
          agent={agent}
          isStreamingLastTurn={isStreamingLastTurn}
          onReply={onReply}
        />
      </motion.div>
    )
  },
  (previous, next) =>
    previous.group === next.group &&
    previous.cwd === next.cwd &&
    previous.agent === next.agent &&
    previous.isStreamingLastTurn === next.isStreamingLastTurn &&
    previous.onReply === next.onReply,
)

export function AgentChatPanel({ agentWindow }: AgentChatPanelProps) {
  const reduceMotion = useReducedMotion()
  const [snapshot, setSnapshot] = useState<AgentSessionSnapshot | null>(null)
  const [messages, setMessages] = useState<AgentSessionMessage[]>([])
  const [groups, setGroups] = useState<ChatGroup[]>([])
  const [input, setInput] = useState(() => agentWindow.composerDraft ?? '')
  const [attachments, setAttachments] = useState<string[]>(() =>
    sanitizeComposerAttachments(agentWindow.composerAttachments ?? []),
  )
  const [replyTo, setReplyTo] = useState<AgentReplyReference | null>(
    () => agentWindow.composerReplyTo ?? null,
  )
  const [composerPreviewPath, setComposerPreviewPath] = useState<string | null>(null)
  const [composerShortcutMode, setComposerShortcutMode] = useState<
    'branch' | 'interrupt' | 'after-tool' | null
  >(null)
  const [selectingBrowserElement, setSelectingBrowserElement] = useState(false)
  const activeProjectPath = useStore(
    (state) => state.projects.find((project) => project.id === state.activeProjectId)?.path ?? null,
  )
  const browserPickTargetId = useStore((state) => {
    const focusedBrowser = state.focusedBrowserId
      ? state.browsers.find((browser) => browser.id === state.focusedBrowserId)
      : null
    return (
      focusedBrowser?.id ??
      [...state.focusHistory]
        .reverse()
        .find((id) => state.browsers.some((browser) => browser.id === id)) ??
      state.browsers[0]?.id ??
      null
    )
  })
  const browserPickTargetLabel = useStore((state) => {
    const browser = browserPickTargetId
      ? state.browsers.find((candidate) => candidate.id === browserPickTargetId)
      : null
    return browser?.title || browser?.url || 'Browser'
  })
  const focusedAgentWindowId = useStore((state) => state.focusedAgentWindowId)
  const worktrees = useStore((state) => state.worktrees)
  const queueModeMeta = useMemo(() => getQueueModeMeta(), [])
  // Queue is persisted on the AgentWindowNode so it survives app restart.
  // Read straight from the prop (zustand re-renders this component whenever
  // the window patches) and write through `syncAgentWindow` so the change
  // flows out to disk via the debounced projects-state persister.
  const queuedMessages = useMemo<QueuedMessage[]>(
    () => sanitizeQueuedMessages(agentWindow.queuedMessages ?? []),
    [agentWindow.queuedMessages],
  )
  const setQueuedMessages = useCallback(
    (updater: (prev: QueuedMessage[]) => QueuedMessage[]) => {
      const prev = sanitizeQueuedMessages(
        useStore.getState().agentWindows.find((w) => w.id === agentWindow.id)?.queuedMessages ?? [],
      )
      const next = sanitizeQueuedMessages(updater(prev))
      useStore.getState().syncAgentWindow(agentWindow.id, { queuedMessages: next })
    },
    [agentWindow.id],
  )
  const getQueuedMessagesSnapshot = useCallback(
    () =>
      sanitizeQueuedMessages(
        useStore.getState().agentWindows.find((w) => w.id === agentWindow.id)?.queuedMessages ?? [],
      ),
    [agentWindow.id],
  )
  const inputRef = useRef(input)
  const attachmentsRef = useRef(attachments)
  const replyToRef = useRef(replyTo)
  const snapshotRef = useRef(snapshot)
  const windowIdRef = useRef(agentWindow.id)
  const activeElementPickerBrowserIdRef = useRef<string | null>(null)
  useEffect(() => {
    inputRef.current = input
  }, [input])
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => {
    replyToRef.current = replyTo
  }, [replyTo])
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])
  useEffect(() => {
    windowIdRef.current = agentWindow.id
  }, [agentWindow.id])
  useEffect(() => {
    return () => {
      const browserId = activeElementPickerBrowserIdRef.current
      if (browserId) window.cells.browser.cancelElementPicker(browserId)
    }
  }, [])
  useEffect(() => {
    const raw = agentWindow.queuedMessages ?? []
    const sanitized = sanitizeQueuedMessages(raw)
    if (sanitized.length !== raw.length) {
      useStore.getState().syncAgentWindow(agentWindow.id, { queuedMessages: sanitized })
    }
  }, [agentWindow.id, agentWindow.queuedMessages])
  useEffect(() => {
    const raw = agentWindow.composerAttachments ?? []
    const sanitized = sanitizeComposerAttachments(raw)
    if (!areStringArraysEqual(raw, sanitized)) {
      useStore.getState().syncAgentWindow(agentWindow.id, {
        composerAttachments: sanitized,
      })
    }
    const nextDraft = agentWindow.composerDraft ?? ''
    let draftFrame: number | null = null
    let replyFrame: number | null = null
    if (nextDraft !== inputRef.current) {
      inputRef.current = nextDraft
      draftFrame = window.requestAnimationFrame(() => {
        setInput(nextDraft)
      })
    }
    const nextReplyTo = agentWindow.composerReplyTo ?? null
    if (!areReplyReferencesEqual(nextReplyTo, replyToRef.current)) {
      replyToRef.current = nextReplyTo
      replyFrame = window.requestAnimationFrame(() => {
        setReplyTo(nextReplyTo)
      })
    }
    return () => {
      if (draftFrame !== null) window.cancelAnimationFrame(draftFrame)
      if (replyFrame !== null) window.cancelAnimationFrame(replyFrame)
    }
  }, [
    agentWindow.composerAttachments,
    agentWindow.composerDraft,
    agentWindow.composerReplyTo,
    agentWindow.id,
  ])
  // Only gate resume when the session was actually reconstructed from the
  // persisted snapshot after Cells restarted. Project/window remounts within
  // the same app session should not show the "Continue" banner.
  const [resumeGated, setResumeGated] = useState(false)
  // Separately track mid-turn resumes: the session had an outstanding user
  // turn when the app was closed (last message is a user message with no
  // completed assistant response). Surfaces the Continue banner even when
  // the queue is empty so the user can decide whether to resume.
  const [midTurnDetected, setMidTurnDetected] = useState(false)
  const midTurnAppliedRef = useRef(false)
  const [recentSessions, setRecentSessions] = useState<RecentAgentSessionSummary[]>([])
  const [recentSessionsFade, setRecentSessionsFade] = useState({ top: false, bottom: false })
  // Queue list collapses by default — the header already shows count + a
  // preview of the next message, mirroring AgentTurnCard's activities stripe.
  const [queueCollapsed, setQueueCollapsed] = useState(true)
  // ESC-to-stop is a two-step confirmation so a stray keystroke can't kill
  // a live turn. First press arms the hint; second press within 2s stops.
  const [stopConfirmArmed, setStopConfirmArmed] = useState(false)
  const stopConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [queuedEditSettings, setQueuedEditSettings] = useState<QueuedMessageSettings | null>(null)
  // Active drag state for queue reorder — `dragIndex` is the row being dragged,
  // `dragOverIndex` is the row currently under the pointer. Both reset on
  // drop or drag-end.
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  // Edge-fade state for the queue scroll area. `top` = content above the
  // viewport, `bottom` = content below. We fade each edge only when there's
  // something hidden on that side so the fade itself stays honest.
  const queueScrollRef = useRef<HTMLDivElement | null>(null)
  const [queueScrollFade, setQueueScrollFade] = useState<{ top: boolean; bottom: boolean }>({
    top: false,
    bottom: false,
  })
  const updateQueueScrollFade = useCallback(() => {
    const el = queueScrollRef.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    const atTop = scrollTop <= 1
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1
    const isScrollable = scrollHeight > clientHeight + 1
    setQueueScrollFade((prev) => {
      const next = {
        top: isScrollable && !atTop,
        bottom: isScrollable && !atBottom,
      }
      if (prev.top === next.top && prev.bottom === next.bottom) return prev
      return next
    })
  }, [])
  useEffect(() => {
    updateQueueScrollFade()
  }, [queuedMessages.length, queueCollapsed, updateQueueScrollFade])
  const interruptMessageRef = useRef<QueuedMessage | null>(null)
  const reorderQueue = useCallback(
    (from: number, to: number) => {
      if (from === to) return
      setQueuedMessages((prev) => {
        if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        return next
      })
    },
    [setQueuedMessages],
  )
  const getRememberedThinkingLevelForModel = useCallback(
    (modelId: string | null | undefined) => {
      const resolvedModelId = resolveAgentPickerModelId(agentWindow.agent, modelId)
      const remembered = resolvedModelId
        ? (useStore.getState().lastAgentSessionDefaults[agentWindow.agent]?.thinkingLevelsByModel?.[
            resolvedModelId
          ] ?? null)
        : null
      return resolveThinkingLevelForModel(agentWindow.agent, resolvedModelId, remembered)
    },
    [agentWindow.agent],
  )
  const rememberThinkingLevelForModel = useCallback(
    (modelId: string | null | undefined, level: AgentThinkingLevel | null) => {
      const resolvedModelId = resolveAgentPickerModelId(agentWindow.agent, modelId)
      if (!resolvedModelId || !level) return
      useStore.getState().setLastAgentSessionDefaults(agentWindow.agent, {
        thinkingLevel: level,
        thinkingLevelsByModel: { [resolvedModelId]: level },
      })
    },
    [agentWindow.agent],
  )
  const updateActiveComposerModel = useCallback(
    (modelId: string) => {
      const nextThinkingLevel = getRememberedThinkingLevelForModel(modelId)
      const previousModelId = resolveAgentPickerModelId(agentWindow.agent, agentWindow.model)
      const previousThinkingLevel = agentWindow.thinkingLevel ?? null
      const store = useStore.getState()
      store.syncAgentWindow(agentWindow.id, {
        model: modelId,
        thinkingLevel: nextThinkingLevel,
      })
      store.setLastAgentSessionDefaults(agentWindow.agent, {
        model: modelId,
        thinkingLevel: nextThinkingLevel,
        thinkingLevelsByModel: {
          ...(previousModelId && previousThinkingLevel
            ? { [previousModelId]: previousThinkingLevel }
            : {}),
          ...(nextThinkingLevel ? { [modelId]: nextThinkingLevel } : {}),
        },
      })
    },
    [
      agentWindow.agent,
      agentWindow.id,
      agentWindow.model,
      agentWindow.thinkingLevel,
      getRememberedThinkingLevelForModel,
    ],
  )
  const updateActiveComposerThinking = useCallback(
    (level: AgentThinkingLevel) => {
      const modelId = resolveAgentPickerModelId(agentWindow.agent, agentWindow.model)
      const store = useStore.getState()
      store.syncAgentWindow(agentWindow.id, { thinkingLevel: level })
      store.setLastAgentSessionDefaults(agentWindow.agent, {
        thinkingLevel: level,
        thinkingLevelsByModel: modelId ? { [modelId]: level } : {},
      })
    },
    [agentWindow.agent, agentWindow.id, agentWindow.model],
  )
  const updateQueuedEditModel = useCallback(
    (modelId: string) => {
      const nextThinkingLevel = getRememberedThinkingLevelForModel(modelId)
      setQueuedEditSettings((current) => ({
        model: modelId,
        thinkingLevel: nextThinkingLevel,
        permissionMode: current?.permissionMode ?? null,
      }))
    },
    [getRememberedThinkingLevelForModel],
  )
  const updateQueuedEditThinking = useCallback(
    (level: AgentThinkingLevel) => {
      const fallbackModelId = resolveAgentPickerModelId(
        agentWindow.agent,
        queuedEditSettings?.model,
      )
      rememberThinkingLevelForModel(fallbackModelId, level)
      setQueuedEditSettings((current) => {
        return {
          model: current?.model ?? fallbackModelId,
          thinkingLevel: level,
          permissionMode: current?.permissionMode ?? null,
        }
      })
    },
    [agentWindow.agent, queuedEditSettings?.model, rememberThinkingLevelForModel],
  )
  const updateQueuedEditPermission = useCallback((mode: AgentPermissionMode) => {
    setQueuedEditSettings((current) => ({
      model: current?.model ?? null,
      thinkingLevel: current?.thinkingLevel ?? null,
      permissionMode: mode,
    }))
  }, [])
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<LegendListRef>(null)
  const recentSessionsViewportRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLDivElement>(null)
  const sendScrollTargetRef = useRef<number | null>(null)
  const sendScrollFrameRef = useRef<number | null>(null)
  const focusComposer = useCallback((moveCursorToEnd = false) => {
    const editor = textareaRef.current
    if (!editor) return false
    editor.focus({ preventScroll: true })
    if (moveCursorToEnd) {
      setComposerSelectionOffset(editor, serializeComposerElement(editor).length)
    }
    return document.activeElement === editor
  }, [])
  // Returns the DOM scroll container backing the active LegendList so we can
  // read scroll position (to gate auto-scroll on "near bottom") and bypass the
  // list's maintainVisibleContentPosition by setting `scrollTop` directly.
  const getListScrollElement = useCallback((): HTMLElement | null => {
    const native = listRef.current?.getNativeScrollRef?.()
    return native instanceof HTMLElement ? native : null
  }, [])
  // "Near bottom" means within ~320px of the end, which covers the composer
  // overlay plus a comfortable reading margin above it. Users scrolled further
  // up are actively reading history — we don't yank them down on send.
  const isNearBottom = useCallback((pxThreshold = 320) => {
    const el = listRef.current?.getNativeScrollRef?.()
    if (!(el instanceof HTMLElement)) return true
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    return distance <= pxThreshold
  }, [])
  const scheduleScrollToBottom = useCallback(
    (frames = 4) => {
      if (sendScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(sendScrollFrameRef.current)
        sendScrollFrameRef.current = null
      }
      const forceScroll = () => {
        const el = getListScrollElement()
        if (el) {
          el.scrollTop = el.scrollHeight
        }
        void listRef.current?.scrollToEnd?.({ animated: false })
      }
      const tick = (remaining: number) => {
        sendScrollFrameRef.current = window.requestAnimationFrame(() => {
          forceScroll()
          if (remaining > 1) {
            tick(remaining - 1)
            return
          }
          sendScrollFrameRef.current = null
        })
      }
      tick(frames)
    },
    [getListScrollElement],
  )
  useEffect(
    () => () => {
      if (sendScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(sendScrollFrameRef.current)
      }
    },
    [],
  )
  useEffect(() => {
    sendScrollTargetRef.current = null
    if (sendScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(sendScrollFrameRef.current)
      sendScrollFrameRef.current = null
    }
  }, [agentWindow.id])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (focusedAgentWindowId !== agentWindow.id) return
      if (useStore.getState().overlayOpen) return
      if (event.defaultPrevented || event.key.toLowerCase() !== 'i') return
      if (!hasPrimaryModifier(event) || event.shiftKey || event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      focusComposer()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [agentWindow.id, focusComposer, focusedAgentWindowId])

  // Auto-focus the composer whenever this window becomes the focused one.
  // Skip when a modal/overlay is open so dialogs keep their own focus.
  useEffect(() => {
    if (focusedAgentWindowId !== agentWindow.id) return
    if (useStore.getState().overlayOpen) return
    let cancelled = false
    let frame: number | null = null

    const focusAfterLayout = (remainingFrames: number) => {
      frame = window.requestAnimationFrame(() => {
        if (cancelled || useStore.getState().overlayOpen) return
        const moveCursorToEnd = document.activeElement !== textareaRef.current
        const focused = focusComposer(moveCursorToEnd)
        if (!focused && remainingFrames > 1) {
          focusAfterLayout(remainingFrames - 1)
        }
      })
    }

    focusAfterLayout(3)
    return () => {
      cancelled = true
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [agentWindow.id, focusComposer, focusedAgentWindowId])
  // Ctrl+M cycles models, Ctrl+T cycles thinking effort, and holding Shift
  // reverses those cycles. Shift+Tab cycles permission mode. Scoped to textarea
  // focus so we don't steal Shift+Tab from real focus traversal elsewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (focusedAgentWindowId !== agentWindow.id) return
      if (useStore.getState().overlayOpen) return
      if (event.defaultPrevented) return
      if (document.activeElement !== textareaRef.current) return

      const isCtrlCycleShortcut = event.ctrlKey && !event.metaKey && !event.altKey
      const key = event.key.toLowerCase()
      const editingQueued = editingIndex !== null

      if (isCtrlCycleShortcut && key === 'm') {
        event.preventDefault()
        event.stopPropagation()
        const nextId = cycleAgentModel(
          agentWindow.agent,
          editingQueued ? queuedEditSettings?.model : agentWindow.model,
          event.shiftKey ? -1 : 1,
        )
        if (nextId) {
          if (editingQueued) updateQueuedEditModel(nextId)
          else updateActiveComposerModel(nextId)
        }
        return
      }

      if (isCtrlCycleShortcut && key === 't') {
        event.preventDefault()
        event.stopPropagation()
        const nextLevel = cycleThinkingLevel(
          agentWindow.agent,
          editingQueued ? queuedEditSettings?.model : agentWindow.model,
          editingQueued ? queuedEditSettings?.thinkingLevel : agentWindow.thinkingLevel,
          event.shiftKey ? -1 : 1,
        )
        if (nextLevel) {
          if (editingQueued) updateQueuedEditThinking(nextLevel)
          else updateActiveComposerThinking(nextLevel)
        }
        return
      }

      if (
        event.shiftKey &&
        event.key === 'Tab' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault()
        event.stopPropagation()
        const nextMode = cyclePermissionMode(
          (editingQueued ? queuedEditSettings?.permissionMode : agentWindow.permissionMode) ??
            getDefaultPermissionMode(),
        )
        if (editingQueued) {
          updateQueuedEditPermission(nextMode)
        } else {
          const store = useStore.getState()
          store.syncAgentWindow(agentWindow.id, { permissionMode: nextMode })
          store.setLastAgentSessionDefaults(agentWindow.agent, { permissionMode: nextMode })
          void window.cells.agentSession
            .updatePermissionMode(agentWindow.id, nextMode)
            .catch((err: unknown) => console.error('[agent-chat] updatePermissionMode failed', err))
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [
    agentWindow.agent,
    agentWindow.id,
    agentWindow.model,
    agentWindow.permissionMode,
    agentWindow.thinkingLevel,
    editingIndex,
    focusedAgentWindowId,
    queuedEditSettings,
    updateActiveComposerModel,
    updateActiveComposerThinking,
    updateQueuedEditModel,
    updateQueuedEditPermission,
    updateQueuedEditThinking,
  ])
  // Clear the "done-unviewed" flag the moment the user focuses this window —
  // they've now "checked on" the completed turn.
  useEffect(() => {
    if (focusedAgentWindowId !== agentWindow.id) return
    if (!agentWindow.hasUnviewedCompletion) return
    useStore.getState().syncAgentWindow(agentWindow.id, { hasUnviewedCompletion: false })
  }, [agentWindow.id, focusedAgentWindowId, agentWindow.hasUnviewedCompletion])
  // The composer overlays the bottom of the list so messages can scroll
  // "behind" it — we track its live height via ResizeObserver so the list's
  // bottom fade mask and footer spacer always line up with the composer's
  // current size (composer height swells when banners, queue rows, or the
  // textarea itself grows).
  const composerOverlayRef = useRef<HTMLDivElement>(null)
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0)
  // Tracks the prior overlay height so we only auto-scroll when it GROWS
  // (new queue row, plan banner, etc.). Shrinks leave the user where they
  // are — yanking the viewport on collapse would feel aggressive.
  const prevComposerOverlayHeightRef = useRef(0)
  useEffect(() => {
    const el = composerOverlayRef.current
    if (!el) return
    setComposerOverlayHeight(el.getBoundingClientRect().height)
    // Round to whole pixels and require >=2px deltas before propagating. The
    // composer's rendered height fluctuates sub-pixel during streaming (font
    // metrics, scrollbar auto/hide, banner fades), and threading every one of
    // those into React state cascades through the footer spacer, LegendList
    // re-layout, and scrollToEnd — the visible "jitter" the user saw.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const h = Math.round(entry.contentRect.height)
      setComposerOverlayHeight((prev) => (Math.abs(prev - h) < 2 ? prev : h))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // When the overlay grows meaningfully (queue row, plan banner, diff pill
  // appearing), re-anchor the transcript to the bottom so the composer
  // doesn't visually cover the last message. A non-animated scroll avoids
  // fighting the smooth maintainScrollAtEnd behavior during streaming; the
  // 8px gate keeps stream-induced micro-growth from triggering scrolls at all.
  useEffect(() => {
    const prev = prevComposerOverlayHeightRef.current
    prevComposerOverlayHeightRef.current = composerOverlayHeight
    if (composerOverlayHeight <= prev + 8) return
    const id = window.requestAnimationFrame(() => {
      listRef.current?.scrollToEnd?.({ animated: false })
    })
    return () => window.cancelAnimationFrame(id)
  }, [composerOverlayHeight])

  const messageStateRef = useRef(createEmptyStableListState<AgentSessionMessage>())
  const groupStateRef = useRef(createEmptyStableListState<ChatGroup>())
  const pendingSnapshotRef = useRef<AgentSessionSnapshot | null>(null)
  const pendingFrameRef = useRef<number | null>(null)
  // Remember the last derived status so we can detect the active→idle
  // transition — that's what flips a window into "done but unviewed" when
  // the user isn't currently looking at it.
  const prevDerivedStatusRef = useRef<AgentWindowStatus | null>(null)
  useEffect(() => {
    messageStateRef.current = createEmptyStableListState<AgentSessionMessage>()
    groupStateRef.current = createEmptyStableListState<ChatGroup>()
  }, [agentWindow.id])

  useEffect(() => {
    let cancelled = false

    const applySnapshot = (next: AgentSessionSnapshot) => {
      if (cancelled || next.windowId !== agentWindow.id) return
      const nextMessageState = computeStableList(next.messages ?? [], messageStateRef.current, {
        getId: (message) => message.id,
        isUnchanged: isAgentSessionMessageUnchanged,
      })
      messageStateRef.current = nextMessageState
      const nextGroupState = computeStableList(
        groupMessages(nextMessageState.result),
        groupStateRef.current,
        {
          getId: (group) => group.key,
          isUnchanged: isChatGroupUnchanged,
        },
      )
      groupStateRef.current = nextGroupState
      setSnapshot(next)
      setMessages(nextMessageState.result)
      setGroups(nextGroupState.result)
      // First snapshot after mount: detect recovered mid-turn resumes so the
      // drain effect stays gated until the user presses Continue. We only do
      // this for sessions restored from disk after an app restart — normal
      // remounts from project switching should not trigger the banner.
      if (!midTurnAppliedRef.current) {
        midTurnAppliedRef.current = true
        const msgs = next.messages
        const hasQueued = sanitizeQueuedMessages(agentWindow.queuedMessages ?? []).length > 0
        if (next.restoredFromPersist && (msgs.length > 0 || hasQueued)) {
          const tail = msgs[msgs.length - 1]
          const tailIsUser = tail?.role === 'user'
          const hasPending = msgs.some((m) => m.status === 'in_progress')
          if (tailIsUser || hasPending || hasQueued) {
            setMidTurnDetected(tailIsUser || hasPending)
            setResumeGated(true)
          }
        }
      }
      const shouldClearInitialPrompt =
        Boolean(agentWindow.initialPrompt) &&
        (next.messages.some((message) => message.role === 'user') ||
          next.status === 'running' ||
          Boolean(next.claudeSessionId) ||
          Boolean(next.codexThreadId))
      const derivedStatus = deriveAgentSessionWindowStatus(next)
      const prevStatus = prevDerivedStatusRef.current
      prevDerivedStatusRef.current = derivedStatus
      // Flip on "done but unviewed" the moment we transition from an active
      // state to idle while the user isn't looking at this window. The flag
      // is cleared by a focus effect below.
      const justCompleted = prevStatus !== null && prevStatus !== 'idle' && derivedStatus === 'idle'
      const storeState = useStore.getState()
      const isFocused = storeState.focusedAgentWindowId === agentWindow.id
      const patch: Partial<AgentWindowNode> = {
        title: next.title,
        cwd: next.cwd ?? agentWindow.cwd ?? null,
        status: derivedStatus,
        error: next.error ?? null,
        claudeSessionId: next.claudeSessionId ?? null,
        codexThreadId: next.codexThreadId ?? null,
        initialPrompt: shouldClearInitialPrompt ? null : (agentWindow.initialPrompt ?? null),
      }
      if (justCompleted && !isFocused) {
        patch.hasUnviewedCompletion = true
      }
      storeState.syncAgentWindow(agentWindow.id, patch)
    }

    const sync = (next: AgentSessionSnapshot) => {
      if (next.windowId !== agentWindow.id) return
      pendingSnapshotRef.current = next
      if (pendingFrameRef.current !== null) return
      pendingFrameRef.current = window.requestAnimationFrame(() => {
        pendingFrameRef.current = null
        const pending = pendingSnapshotRef.current
        pendingSnapshotRef.current = null
        if (pending) applySnapshot(pending)
      })
    }

    // Subscribe BEFORE calling ensure() so any snapshot the service emits
    // while ensure() is awaiting a slow dependency (e.g. the 10s model-catalog
    // spawn) still reaches us. Previously the subscribe happened after the
    // await, so those early updates were dropped and the UI stayed stuck on
    // the skeleton if the ensure() call itself failed silently.
    const unsubscribe = window.cells.agentSession.onUpdate(sync)

    const ensureArgs = {
      windowId: agentWindow.id,
      agent: agentWindow.agent,
      title: agentWindow.customTitle || agentWindow.title,
      cwd: agentWindow.cwd ?? null,
      initialPrompt: agentWindow.initialPrompt ?? null,
      claudeSessionId: agentWindow.claudeSessionId ?? null,
      codexThreadId: agentWindow.codexThreadId ?? null,
      model: agentWindow.model ?? null,
      permissionMode: agentWindow.permissionMode ?? null,
      thinkingLevel: agentWindow.thinkingLevel ?? null,
      contextLength: agentWindow.contextLength ?? null,
    }

    // Surface ensure() failures — silent rejections used to leave the skeleton
    // on screen forever. On failure we retry once after a short delay; if the
    // second attempt also fails, the error log is the user-visible signal.
    const callEnsure = (attempt: number): Promise<void> =>
      window.cells.agentSession
        .ensure(ensureArgs)
        .then((next) => {
          if (cancelled) return
          sync(next)
        })
        .catch((error) => {
          console.error('[agent-chat] ensure() failed', { attempt, error })
          if (cancelled || attempt >= 1) return
          window.setTimeout(() => {
            if (!cancelled) void callEnsure(attempt + 1)
          }, 500)
        })

    let subscribed = false
    void window.cells.agentSession
      .subscribeUpdates(agentWindow.id)
      .then(() => {
        subscribed = true
        if (cancelled) {
          void window.cells.agentSession.unsubscribeUpdates(agentWindow.id).catch(() => {})
          return
        }
        void callEnsure(0)
      })
      .catch((error) => {
        console.error('[agent-chat] subscribeUpdates failed', error)
        if (!cancelled) void callEnsure(0)
      })

    return () => {
      cancelled = true
      pendingSnapshotRef.current = null
      if (pendingFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingFrameRef.current)
        pendingFrameRef.current = null
      }
      unsubscribe()
      if (subscribed) {
        void window.cells.agentSession
          .unsubscribeUpdates(agentWindow.id)
          .catch((error) => console.error('[agent-chat] unsubscribeUpdates failed', error))
      }
    }
  }, [
    agentWindow.agent,
    agentWindow.claudeSessionId,
    agentWindow.codexThreadId,
    agentWindow.cwd,
    agentWindow.customTitle,
    agentWindow.id,
    agentWindow.initialPrompt,
    agentWindow.queuedMessages,
    agentWindow.title,
    agentWindow.model,
    agentWindow.permissionMode,
    agentWindow.thinkingLevel,
    agentWindow.contextLength,
  ])

  // Scroll-to-bottom is handled by <LegendList maintainScrollAtEnd /> in the
  // messages branch; the skeleton/empty branches don't need autoscroll.

  useEffect(() => {
    const id = window.setTimeout(() => {
      if (focusedAgentWindowId === agentWindow.id && !useStore.getState().overlayOpen) {
        focusComposer()
      }
    }, 50)
    return () => window.clearTimeout(id)
  }, [agentWindow.id, focusComposer, focusedAgentWindowId])

  const composerPlaceholder = useMemo(
    () => getComposerPlaceholder(agentWindow.agent),
    [agentWindow.agent],
  )
  const snapshotMatchesWindow = snapshot?.windowId === agentWindow.id
  const visibleSnapshot = useMemo(
    () => (snapshotMatchesWindow ? snapshot : null),
    [snapshot, snapshotMatchesWindow],
  )
  const visibleMessages = useMemo(
    () => (snapshotMatchesWindow ? messages : []),
    [messages, snapshotMatchesWindow],
  )
  const visibleGroups = useMemo(
    () => (snapshotMatchesWindow ? groups : []),
    [groups, snapshotMatchesWindow],
  )
  const visibleUserMessageCount = useMemo(
    () => visibleMessages.filter((message) => message.role === 'user').length,
    [visibleMessages],
  )
  const lastUserMessage = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const message = visibleMessages[i]
      if (
        message.role === 'user' &&
        (message.text.trim() || (message.attachments?.length ?? 0) > 0)
      ) {
        return message
      }
    }
    return null
  }, [visibleMessages])
  const inlineMention = useInlineMention({
    inputRef: textareaRef,
    cwd: visibleSnapshot?.cwd ?? agentWindow.cwd ?? null,
  })

  const cwdDisplay = truncateCwd(visibleSnapshot?.cwd || agentWindow.cwd)
  const backgroundActivities = useMemo(
    () => getInFlightAgentMessages(visibleMessages),
    [visibleMessages],
  )
  const hasMessages = visibleMessages.length > 0
  const isLoadingSnapshot = !visibleSnapshot
  const filteredRecentSessions = useMemo(
    () =>
      filterRecentSessionsForProject(
        recentSessions,
        activeProjectPath ?? visibleSnapshot?.cwd ?? agentWindow.cwd ?? null,
        worktrees,
      ),
    [activeProjectPath, agentWindow.cwd, recentSessions, visibleSnapshot?.cwd, worktrees],
  )
  useEffect(() => {
    const viewport = recentSessionsViewportRef.current
    if (!viewport) return

    let frame: number | null = null
    const update = () => {
      frame = null
      const maxScroll = viewport.scrollHeight - viewport.clientHeight
      const hasOverflow = maxScroll > 1
      const next = {
        top: hasOverflow && viewport.scrollTop > 1,
        bottom: hasOverflow && viewport.scrollTop < maxScroll - 1,
      }
      setRecentSessionsFade((prev) =>
        prev.top === next.top && prev.bottom === next.bottom ? prev : next,
      )
    }
    const scheduleUpdate = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(update)
    }

    scheduleUpdate()
    viewport.addEventListener('scroll', scheduleUpdate, { passive: true })

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleUpdate) : null
    observer?.observe(viewport)
    const content = viewport.firstElementChild
    if (content instanceof HTMLElement) observer?.observe(content)
    window.addEventListener('resize', scheduleUpdate)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', scheduleUpdate)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [filteredRecentSessions])
  useEffect(() => {
    const target = sendScrollTargetRef.current
    if (target === null) return
    if (visibleUserMessageCount < target) return
    sendScrollTargetRef.current = null
    scheduleScrollToBottom()
  }, [scheduleScrollToBottom, visibleUserMessageCount])
  const hasBackgroundActivity = backgroundActivities.length > 0
  const isRunning = deriveAgentSessionWindowStatus(visibleSnapshot) === 'running'
  const composerImageAttachments = useMemo(
    () => attachments.filter((path) => isImagePath(path)),
    [attachments],
  )
  const composerFileAttachments = useMemo(
    () => attachments.filter((path) => !isImagePath(path)),
    [attachments],
  )
  const visibleComposerPreviewPath =
    composerPreviewPath && attachments.includes(composerPreviewPath) ? composerPreviewPath : null
  const hasComposerText = Boolean(input.trim())
  const hasComposerPayload = Boolean(input.trim()) || attachments.length > 0
  const canSubmit = hasComposerPayload && !isRunning
  const isEditingQueuedMessage = editingIndex !== null
  const canSaveQueuedEdit = isEditingQueuedMessage && hasComposerPayload
  const shortcutStatusMode =
    !isEditingQueuedMessage && hasComposerPayload
      ? composerShortcutMode === 'branch' && hasComposerText
        ? 'branch'
        : composerShortcutMode === 'interrupt'
          ? 'interrupt'
          : composerShortcutMode === 'after-tool'
            ? 'after-tool'
            : null
      : null
  const branchShortcutActive = shortcutStatusMode === 'branch'
  const composerPermissionMode = isEditingQueuedMessage
    ? queuedEditSettings?.permissionMode
    : agentWindow.permissionMode
  const composerModel = isEditingQueuedMessage ? queuedEditSettings?.model : agentWindow.model
  const composerThinkingLevel = isEditingQueuedMessage
    ? queuedEditSettings?.thinkingLevel
    : agentWindow.thinkingLevel
  const branchTargets = useMemo(
    () =>
      (['claude', 'codex'] as const).map((agent) => ({
        agent,
        label: getAgentDisplayName(agent),
        isCurrent: agent === agentWindow.agent,
      })),
    [agentWindow.agent],
  )

  useEffect(() => {
    const updateComposerShortcut = (event: KeyboardEvent) => {
      if (focusedAgentWindowId !== agentWindow.id) {
        setComposerShortcutMode(null)
        return
      }
      const hasPrimary = hasPrimaryModifier(event)
      setComposerShortcutMode(
        isBranchComposerEnter(event, hasPrimary)
          ? 'branch'
          : hasPrimary
            ? 'interrupt'
            : event.altKey
              ? 'after-tool'
              : null,
      )
    }
    const clearComposerShortcut = () => setComposerShortcutMode(null)

    window.addEventListener('keydown', updateComposerShortcut, true)
    window.addEventListener('keyup', updateComposerShortcut, true)
    window.addEventListener('blur', clearComposerShortcut)
    document.addEventListener('visibilitychange', clearComposerShortcut)
    return () => {
      window.removeEventListener('keydown', updateComposerShortcut, true)
      window.removeEventListener('keyup', updateComposerShortcut, true)
      window.removeEventListener('blur', clearComposerShortcut)
      document.removeEventListener('visibilitychange', clearComposerShortcut)
    }
  }, [agentWindow.id, focusedAgentWindowId])

  const ensureSession = useCallback(async () => {
    await window.cells.agentSession.ensure({
      windowId: agentWindow.id,
      agent: agentWindow.agent,
      title: agentWindow.customTitle || agentWindow.title,
      cwd: agentWindow.cwd ?? null,
      initialPrompt: null,
      claudeSessionId: agentWindow.claudeSessionId ?? null,
      codexThreadId: agentWindow.codexThreadId ?? null,
      model: agentWindow.model ?? null,
      permissionMode: agentWindow.permissionMode ?? null,
      thinkingLevel: agentWindow.thinkingLevel ?? null,
    })
  }, [
    agentWindow.agent,
    agentWindow.claudeSessionId,
    agentWindow.codexThreadId,
    agentWindow.customTitle,
    agentWindow.cwd,
    agentWindow.id,
    agentWindow.model,
    agentWindow.permissionMode,
    agentWindow.thinkingLevel,
    agentWindow.title,
  ])

  const queuedEditRestoreRef = useRef<{
    input: string
    attachments: string[]
    replyTo: AgentReplyReference | null
  } | null>(null)
  const [pendingComposerSelectionOffset, setPendingComposerSelectionOffset] = useState<
    number | null
  >(null)

  const setComposerReplyTarget = useCallback(
    (nextReplyTo: AgentReplyReference | null) => {
      setReplyTo(nextReplyTo)
      replyToRef.current = nextReplyTo
      const storedWindow = useStore
        .getState()
        .agentWindows.find((entry) => entry.id === agentWindow.id)
      if (areReplyReferencesEqual(storedWindow?.composerReplyTo ?? null, nextReplyTo)) return
      useStore.getState().syncAgentWindow(agentWindow.id, {
        composerReplyTo: nextReplyTo,
      })
    },
    [agentWindow.id],
  )

  const beginReply = useCallback(
    (nextReplyTo: AgentReplyReference) => {
      setComposerReplyTarget(nextReplyTo)
      window.setTimeout(() => focusComposer(true), 0)
    },
    [focusComposer, setComposerReplyTarget],
  )

  const writeComposer = useCallback(
    (
      value: string,
      nextAttachments: string[],
      options?: {
        selectionOffset?: number | null
      },
    ) => {
      const sanitizedAttachments = sanitizeComposerAttachments(nextAttachments)
      const sanitizedValue = value
      setPendingComposerSelectionOffset(options?.selectionOffset ?? null)
      setInput(sanitizedValue)
      inputRef.current = sanitizedValue
      setAttachments(sanitizedAttachments)
      attachmentsRef.current = sanitizedAttachments
      const storedWindow = useStore
        .getState()
        .agentWindows.find((entry) => entry.id === agentWindow.id)
      const storedInput = storedWindow?.composerDraft ?? ''
      const storedAttachments = sanitizeComposerAttachments(storedWindow?.composerAttachments ?? [])
      if (
        storedInput === sanitizedValue &&
        areStringArraysEqual(storedAttachments, sanitizedAttachments)
      ) {
        return
      }
      useStore.getState().syncAgentWindow(agentWindow.id, {
        composerDraft: sanitizedValue || null,
        composerAttachments: sanitizedAttachments,
      })
    },
    [agentWindow.id],
  )

  const pickAttachments = useCallback(async () => {
    try {
      const picked = await window.cells.app.pickFiles()
      if (!picked || picked.length === 0) return
      const offset = getComposerSelectionOffset(textareaRef.current)
      const inserted = getImageTokenInsertResult(
        inputRef.current,
        offset,
        attachmentsRef.current,
        picked,
      )
      writeComposer(inserted.value, [...attachmentsRef.current, ...picked], {
        selectionOffset: inserted.offset,
      })
    } catch (err) {
      console.error('[agent-chat] pick files failed', err)
    }
  }, [writeComposer])

  const startBrowserElementPicker = useCallback(async () => {
    if (!browserPickTargetId) {
      showToast('Open a browser window first', 'error')
      return
    }

    if (selectingBrowserElement) {
      window.cells.browser.cancelElementPicker(
        activeElementPickerBrowserIdRef.current ?? browserPickTargetId,
      )
      activeElementPickerBrowserIdRef.current = null
      setSelectingBrowserElement(false)
      return
    }

    setSelectingBrowserElement(true)
    useStore.getState().snapToBrowser(browserPickTargetId)

    let started = false
    for (const delay of BROWSER_ELEMENT_PICKER_RETRY_DELAYS_MS) {
      await new Promise((resolve) => window.setTimeout(resolve, delay))
      try {
        started = await window.cells.browser.startElementPicker(browserPickTargetId, agentWindow.id)
      } catch (err) {
        console.error('[agent-chat] start element picker failed', err)
      }
      if (started) break
    }

    if (!started) {
      activeElementPickerBrowserIdRef.current = null
      setSelectingBrowserElement(false)
      showToast('Browser is still opening. Try again in a moment.', 'error')
      return
    }

    activeElementPickerBrowserIdRef.current = browserPickTargetId
    showToast(`Select an element in ${browserPickTargetLabel}`, 'info')
  }, [agentWindow.id, browserPickTargetId, browserPickTargetLabel, selectingBrowserElement])

  const removeAttachment = useCallback(
    (path: string) => {
      setComposerPreviewPath((current) => (current === path ? null : current))
      writeComposer(
        isImagePath(path)
          ? removeImageTokenForPath(inputRef.current, path, attachmentsRef.current)
          : inputRef.current,
        attachmentsRef.current.filter((candidate) => candidate !== path),
      )
    },
    [writeComposer],
  )

  const clearPendingComposerSelectionOffset = useCallback(() => {
    setPendingComposerSelectionOffset(null)
  }, [])

  // Actually ship one message to the agent. Separated from submit() so the
  // queue-flusher effect can call it too.
  const sendToAgent = useCallback(
    async (
      value: string,
      attachments: string[],
      overrides?: {
        model?: string | null
        thinkingLevel?: AgentThinkingLevel | null
        permissionMode?: AgentPermissionMode | null
      },
      replyTo?: AgentReplyReference | null,
    ) => {
      const trySend = () =>
        window.cells.agentSession.send(
          windowIdRef.current,
          value,
          attachments,
          overrides,
          replyTo ?? null,
        )
      try {
        await trySend()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/Missing agent session/i.test(msg)) {
          try {
            await ensureSession()
            await trySend()
            return
          } catch (retryErr) {
            console.error('[agent-chat] retry failed', retryErr)
          }
        }
        throw err
      }
    },
    [ensureSession],
  )

  const handleStop = useCallback(async () => {
    try {
      // v2 SDKSession has no interrupt; closing the session is the only way
      // to actually halt an in-flight turn.
      await window.cells.agentSession.close(windowIdRef.current)
    } catch (err) {
      console.error('[agent-chat] stop failed', err)
    }
  }, [])

  const branchToAgent = useCallback(
    async (targetAgent: AgentWindowNode['agent']) => {
      const currentSnapshot = snapshotRef.current
      if (!currentSnapshot || currentSnapshot.windowId !== agentWindow.id) return
      const continuation = inputRef.current.trim()
      const continuationAttachments = [...attachmentsRef.current]
      const currentReplyTo = replyToRef.current
      if (!continuation && continuationAttachments.length === 0) return
      const visibleValue = continuation || ATTACHMENTS_ONLY_TEXT
      const providerInput = buildBranchImportPrompt({
        sourceWindow: agentWindow,
        snapshot: currentSnapshot,
        targetAgent,
        continuation,
        continuationAttachments,
      })
      const titleSource =
        currentSnapshot.title || agentWindow.title || getAgentDisplayName(targetAgent)
      const targetModel = targetAgent === agentWindow.agent ? (agentWindow.model ?? null) : null
      const targetContextLength =
        targetAgent === 'claude' ? (agentWindow.contextLength ?? null) : null
      const store = useStore.getState()
      const targetWindow = store.addAgentWindow(targetAgent, {
        title: `${titleSource} (branch)`,
        cwd: currentSnapshot.cwd ?? agentWindow.cwd ?? null,
        initialPrompt: null,
        model: targetModel,
        permissionMode: agentWindow.permissionMode ?? null,
        thinkingLevel: agentWindow.thinkingLevel ?? null,
        contextLength: targetContextLength,
      })
      try {
        await window.cells.agentSession.branchFrom(
          agentWindow.id,
          {
            windowId: targetWindow.id,
            agent: targetWindow.agent,
            title: targetWindow.title,
            cwd: targetWindow.cwd ?? null,
            initialPrompt: null,
            claudeSessionId: null,
            codexThreadId: null,
            model: targetModel,
            permissionMode: agentWindow.permissionMode ?? null,
            thinkingLevel: agentWindow.thinkingLevel ?? null,
            contextLength: targetContextLength,
          },
          visibleValue,
          providerInput,
          continuationAttachments,
          {
            model: targetModel,
            thinkingLevel: agentWindow.thinkingLevel ?? null,
            permissionMode: agentWindow.permissionMode ?? null,
          },
          currentReplyTo,
        )
        writeComposer('', [])
        setComposerReplyTarget(null)
        showToast(`Branched into ${getAgentDisplayName(targetAgent)}`, 'info')
        window.setTimeout(() => {
          store.snapToAgentWindow(targetWindow.id)
        }, 0)
      } catch (err) {
        console.error('[agent-chat] branch target failed', err)
        store.removeAgentWindow(targetWindow.id)
        showToast('Failed to branch session', 'error')
      }
    },
    [agentWindow, setComposerReplyTarget, writeComposer],
  )

  const applyInlineMentionSelection = useCallback(
    (selection: { value: string; cursorPosition: number } | null) => {
      if (!selection) return false
      writeComposer(selection.value, attachmentsRef.current)
      window.setTimeout(() => {
        textareaRef.current?.focus()
        setComposerSelectionOffset(textareaRef.current, selection.cursorPosition)
      }, 0)
      return true
    },
    [writeComposer],
  )

  const submit = useCallback(
    async (intent: 'after-turn' | 'after-tool' | 'stop' = 'after-turn') => {
      const rawValue = inputRef.current.trim()
      const pinned = attachmentsRef.current
      const currentReplyTo = replyToRef.current
      if (!rawValue && pinned.length === 0) return
      // Attachments travel in a separate array — images become proper
      // multimodal content blocks downstream, non-image paths get `[path]`
      // injected into the agent's text for file-read tool use.
      const value = rawValue || ATTACHMENTS_ONLY_TEXT
      const running = snapshotRef.current?.status === 'running'

      // Drain the input optimistically so typing feels instant.
      writeComposer('', [])
      setComposerReplyTarget(null)
      inlineMention.close()

      const settings = {
        model: agentWindow.model ?? null,
        thinkingLevel: agentWindow.thinkingLevel ?? null,
        permissionMode: agentWindow.permissionMode ?? null,
      }

      // Cmd+Enter is an immediate interrupt/retry path, not a normal queued
      // follow-up. Keep it out of the persisted queue so it does not survive
      // project switches or restarts, and send it before any after-turn/tool
      // messages once the runtime flips back to idle.
      if (intent === 'stop' && running) {
        const entry: QueuedMessage = {
          id: createQueuedMessageId(),
          text: value,
          attachments: pinned,
          mode: 'stop',
          replyTo: currentReplyTo,
          ...settings,
        }
        interruptMessageRef.current = entry
        void handleStop()
        return
      }

      // Option+Enter (after-tool) and plain Enter (after-turn) both defer the
      // message, but after-tool needs priority: place it at the front so it
      // sends immediately after the next tool boundary instead of sitting
      // behind older after-turn entries.
      if ((intent === 'after-tool' || intent === 'after-turn') && running) {
        const entry: QueuedMessage = {
          id: createQueuedMessageId(),
          text: value,
          attachments: pinned,
          mode: intent,
          replyTo: currentReplyTo,
          ...settings,
        }
        const currentQueue = getQueuedMessagesSnapshot()
        const nextQueue =
          intent === 'after-tool' ? [entry, ...currentQueue] : [...currentQueue, entry]
        setQueuedMessages(() => nextQueue)
        return
      }

      // Only pull the viewport down when the user is already close to the end
      // — if they've scrolled up to reread, leave them there. The effect keyed
      // on visibleUserMessageCount will re-check the same threshold once the
      // optimistic bubble is rendered, so late-arriving content still scrolls.
      if (isNearBottom()) {
        sendScrollTargetRef.current = visibleUserMessageCount + 1
        scheduleScrollToBottom()
      } else {
        sendScrollTargetRef.current = null
      }

      try {
        await sendToAgent(value, pinned, undefined, currentReplyTo)
      } catch (err) {
        writeComposer(value, pinned)
        setComposerReplyTarget(currentReplyTo)
        console.error('[agent-chat] send failed', err)
      }
    },
    [
      sendToAgent,
      handleStop,
      getQueuedMessagesSnapshot,
      inlineMention,
      setQueuedMessages,
      writeComposer,
      setComposerReplyTarget,
      agentWindow.model,
      agentWindow.thinkingLevel,
      agentWindow.permissionMode,
      scheduleScrollToBottom,
      isNearBottom,
      visibleUserMessageCount,
    ],
  )

  useEffect(() => {
    const unsubscribeSelected = window.cells.browser.onElementSelected(
      (_browserId, targetAgentWindowId, selection) => {
        if (targetAgentWindowId !== agentWindow.id) return
        activeElementPickerBrowserIdRef.current = null
        setSelectingBrowserElement(false)
        void copyBrowserElementSelectionToClipboard(selection)
          .then(() => showToast('Copied element and added it to chat', 'info'))
          .catch((err) => {
            console.error('[agent-chat] copy browser element failed', err)
            showToast('Added element to chat', 'info')
          })
        const nextValue = appendBrowserElementSelectionToDraft(inputRef.current, selection)
        writeComposer(nextValue, attachmentsRef.current)
        setPendingComposerSelectionOffset(nextValue.length)
        window.setTimeout(() => {
          useStore.getState().snapToAgentWindow(agentWindow.id)
          focusComposer(true)
        }, 0)
      },
    )
    const unsubscribeCancelled = window.cells.browser.onElementPickerCancelled(
      (_browserId, targetAgentWindowId) => {
        if (targetAgentWindowId !== agentWindow.id) return
        activeElementPickerBrowserIdRef.current = null
        setSelectingBrowserElement(false)
      },
    )
    return () => {
      unsubscribeSelected()
      unsubscribeCancelled()
    }
  }, [agentWindow.id, focusComposer, writeComposer])

  const startNewSessionFromComposer = useCallback(async () => {
    const currentSnapshot = snapshotRef.current
    const draft = inputRef.current
    const rawValue = draft.trim()
    const pinned = [...attachmentsRef.current]
    const currentReplyTo = replyToRef.current
    if (!rawValue && pinned.length === 0) return

    const value = rawValue || ATTACHMENTS_ONLY_TEXT
    const nextDraft = ''
    const store = useStore.getState()
    if (currentSnapshot && currentSnapshot.windowId === agentWindow.id) {
      const titleSource =
        currentSnapshot.title || agentWindow.title || getAgentDisplayName(agentWindow.agent)
      const nextWindow = store.addAgentWindow(agentWindow.agent, {
        title: `${titleSource} (branch)`,
        cwd: currentSnapshot.cwd ?? agentWindow.cwd ?? store.getActiveProjectPath() ?? null,
        model: agentWindow.model ?? null,
        permissionMode: agentWindow.permissionMode ?? null,
        thinkingLevel: agentWindow.thinkingLevel ?? null,
        contextLength: agentWindow.contextLength ?? null,
      })
      try {
        await window.cells.agentSession.branchFrom(
          agentWindow.id,
          {
            windowId: nextWindow.id,
            agent: nextWindow.agent,
            title: nextWindow.title,
            cwd: nextWindow.cwd ?? null,
            initialPrompt: null,
            claudeSessionId: null,
            codexThreadId: null,
            model: nextWindow.model ?? null,
            permissionMode: nextWindow.permissionMode ?? null,
            thinkingLevel: nextWindow.thinkingLevel ?? null,
            contextLength: nextWindow.contextLength ?? null,
          },
          value,
          buildBranchImportPrompt({
            sourceWindow: agentWindow,
            snapshot: currentSnapshot,
            targetAgent: agentWindow.agent,
            continuation: rawValue,
            continuationAttachments: pinned,
          }),
          pinned,
          {
            model: agentWindow.model ?? null,
            thinkingLevel: agentWindow.thinkingLevel ?? null,
            permissionMode: agentWindow.permissionMode ?? null,
          },
          currentReplyTo,
        )
        writeComposer(nextDraft, [])
        setComposerReplyTarget(null)
        showToast('Branched current session', 'info')
        window.setTimeout(() => {
          store.snapToAgentWindow(nextWindow.id)
        }, 0)
      } catch (err) {
        console.error('[agent-chat] branch failed', err)
        store.removeAgentWindow(nextWindow.id)
        showToast('Failed to branch session', 'error')
      }
      return
    }

    const nextWindow = store.addAgentWindow(agentWindow.agent, {
      title: getDraftSessionTitle(agentWindow.agent, rawValue),
      cwd: visibleSnapshot?.cwd ?? agentWindow.cwd ?? store.getActiveProjectPath() ?? null,
      initialPrompt: pinned.length === 0 ? value : null,
      model: agentWindow.model ?? null,
      permissionMode: agentWindow.permissionMode ?? null,
      thinkingLevel: agentWindow.thinkingLevel ?? null,
      contextLength: agentWindow.contextLength ?? null,
    })

    if (pinned.length > 0) {
      store.syncAgentWindow(nextWindow.id, {
        queuedMessages: [
          {
            id: createQueuedMessageId(),
            text: value,
            attachments: pinned,
            replyTo: currentReplyTo,
            mode: 'after-turn',
            model: agentWindow.model ?? null,
            thinkingLevel: agentWindow.thinkingLevel ?? null,
            permissionMode: agentWindow.permissionMode ?? null,
          },
        ],
      })
    }
    writeComposer(nextDraft, [])
    setComposerReplyTarget(null)
    window.setTimeout(() => {
      store.snapToAgentWindow(nextWindow.id)
    }, 0)
  }, [agentWindow, setComposerReplyTarget, visibleSnapshot?.cwd, writeComposer])

  const unqueueMessage = useCallback(
    (index: number) => {
      if (editingIndex === index) {
        const restore = queuedEditRestoreRef.current
        queuedEditRestoreRef.current = null
        setEditingIndex(null)
        setQueuedEditSettings(null)
        writeComposer(restore?.input ?? '', restore?.attachments ?? [])
        setComposerReplyTarget(restore?.replyTo ?? null)
      }
      setQueuedMessages((q) => q.filter((_, i) => i !== index))
      setEditingIndex((current) => (current !== null && current > index ? current - 1 : current))
    },
    [editingIndex, setComposerReplyTarget, setQueuedMessages, writeComposer],
  )

  const beginEditQueued = useCallback(
    (index: number) => {
      const entry = queuedMessages[index]
      if (!entry) return
      if (editingIndex === null) {
        queuedEditRestoreRef.current = {
          input: inputRef.current,
          attachments: [...attachmentsRef.current],
          replyTo: replyToRef.current,
        }
      }
      setEditingIndex(index)
      setQueuedEditSettings({
        model: entry.model ?? null,
        thinkingLevel: entry.thinkingLevel ?? null,
        permissionMode: entry.permissionMode ?? null,
      })
      writeComposer(getQueuedComposerText(entry), [...entry.attachments])
      setComposerReplyTarget(entry.replyTo ?? null)
      setQueueCollapsed(false)
      window.setTimeout(() => textareaRef.current?.focus(), 0)
    },
    [editingIndex, queuedMessages, setComposerReplyTarget, writeComposer],
  )

  const commitEditQueued = useCallback(() => {
    if (editingIndex === null) return
    const nextText = getQueuedStoredText(inputRef.current, attachmentsRef.current)
    if (!nextText) return
    const nextAttachments = [...attachmentsRef.current]
    const nextSettings = queuedEditSettings
    setQueuedMessages((q) =>
      q.map((m, i) =>
        i === editingIndex
          ? {
              ...m,
              text: nextText,
              attachments: nextAttachments,
              replyTo: replyToRef.current,
              model: nextSettings?.model ?? null,
              thinkingLevel: nextSettings?.thinkingLevel ?? null,
              permissionMode: nextSettings?.permissionMode ?? null,
            }
          : m,
      ),
    )
    const restore = queuedEditRestoreRef.current
    queuedEditRestoreRef.current = null
    setEditingIndex(null)
    setQueuedEditSettings(null)
    writeComposer(restore?.input ?? '', restore?.attachments ?? [])
    setComposerReplyTarget(restore?.replyTo ?? null)
  }, [editingIndex, queuedEditSettings, setQueuedMessages, setComposerReplyTarget, writeComposer])

  const cancelEditQueued = useCallback(() => {
    const restore = queuedEditRestoreRef.current
    queuedEditRestoreRef.current = null
    setEditingIndex(null)
    setQueuedEditSettings(null)
    writeComposer(restore?.input ?? '', restore?.attachments ?? [])
    setComposerReplyTarget(restore?.replyTo ?? null)
  }, [setComposerReplyTarget, writeComposer])

  const sendQueuedImmediately = useCallback(
    (index: number) => {
      const entry = queuedMessages[index]
      if (!entry) return
      if (editingIndex === index) {
        const restore = queuedEditRestoreRef.current
        queuedEditRestoreRef.current = null
        setEditingIndex(null)
        setQueuedEditSettings(null)
        writeComposer(restore?.input ?? '', restore?.attachments ?? [])
        setComposerReplyTarget(restore?.replyTo ?? null)
      }
      interruptMessageRef.current = { ...entry, mode: 'stop' }
      setQueuedMessages((q) => q.filter((_, i) => i !== index))
      setResumeGated(false)
      setMidTurnDetected(false)
      if (snapshotRef.current?.status === 'running') void handleStop()
    },
    [
      editingIndex,
      handleStop,
      queuedMessages,
      setComposerReplyTarget,
      setQueuedMessages,
      writeComposer,
    ],
  )

  // Drain the queue whenever the agent flips back to idle. Pop the front
  // item OPTIMISTICALLY before dispatching — if sendToAgent throws we push
  // it back. Prior version removed-on-success but sendToAgent resolves after
  // the agent flips to `running`, which the user could read as "the queue
  // item is still there even though the agent already started it".
  //
  // `awaitingRunningRef` gates back-to-back sends: after we fire a queued
  // message, `sendToAgent()` can resolve before the backend emits the
  // `session_state_changed → running` event. Without this gate the effect
  // would re-fire on the next `queuedMessages` change while status is still
  // `idle`, shipping a second message before the first one's turn has even
  // started. We clear the gate once we actually observe the running signal.
  const sendingQueuedRef = useRef(false)
  const awaitingRunningRef = useRef(false)
  useEffect(() => {
    if (snapshot?.status === 'running') awaitingRunningRef.current = false
  }, [snapshot?.status])

  // after-tool watcher: when the front-of-queue entry is waiting for a tool
  // boundary, fire a stop the moment any tool message flips to completed
  // after it was enqueued. Track seen completed tool ids so a single tool
  // end doesn't fire stop twice; gate on `afterToolFiredRef` so we only
  // interrupt once per running-turn (reset when the turn ends).
  const seenCompletedToolsRef = useRef<Set<string>>(new Set())
  const afterToolFiredRef = useRef(false)
  const toggleQueuedMode = useCallback(
    (index: number) => {
      setQueuedMessages((q) =>
        q.map((entry, i) => {
          if (i !== index) return entry
          return {
            ...entry,
            mode: entry.mode === 'after-tool' ? 'after-turn' : 'after-tool',
          }
        }),
      )
    },
    [setQueuedMessages],
  )
  useEffect(() => {
    if (snapshot?.status !== 'running') afterToolFiredRef.current = false
  }, [snapshot?.status])
  useEffect(() => {
    const msgs = snapshot?.messages
    if (!msgs) return
    const nextSeen = new Set<string>()
    let hasNewCompletion = false
    for (const m of msgs) {
      if (m.role !== 'tool' || m.status !== 'completed') continue
      nextSeen.add(m.id)
      if (!seenCompletedToolsRef.current.has(m.id)) hasNewCompletion = true
    }
    seenCompletedToolsRef.current = nextSeen
    if (!hasNewCompletion) return
    if (snapshot?.status !== 'running') return
    if (afterToolFiredRef.current) return
    if (editingIndex === 0) return
    if (getQueuedMessagesSnapshot()[0]?.mode !== 'after-tool') return
    afterToolFiredRef.current = true
    void handleStop()
  }, [editingIndex, getQueuedMessagesSnapshot, snapshot?.messages, snapshot?.status, handleStop])
  useEffect(() => {
    if (snapshot?.status !== 'idle') return
    if (resumeGated) return
    if (sendingQueuedRef.current) return
    if (awaitingRunningRef.current) return
    if (editingIndex === 0 && !interruptMessageRef.current) return
    sendingQueuedRef.current = true
    awaitingRunningRef.current = true
    if (interruptMessageRef.current) {
      const next = interruptMessageRef.current
      interruptMessageRef.current = null
      void sendToAgent(
        next.text,
        next.attachments,
        {
          model: next.model,
          thinkingLevel: next.thinkingLevel,
          permissionMode: next.permissionMode,
        },
        next.replyTo ?? null,
      )
        .catch((err) => {
          console.error('[agent-chat] interrupt send failed', err)
          interruptMessageRef.current = next
          awaitingRunningRef.current = false
        })
        .finally(() => {
          sendingQueuedRef.current = false
        })
      return
    }
    if (queuedMessages.length === 0) {
      sendingQueuedRef.current = false
      awaitingRunningRef.current = false
      return
    }
    if (editingIndex === 0) {
      sendingQueuedRef.current = false
      awaitingRunningRef.current = false
      return
    }
    const sentBeforeEditedQueuedMessage = editingIndex !== null && editingIndex > 0
    const next = queuedMessages[0]
    setQueuedMessages((q) => q.slice(1))
    if (sentBeforeEditedQueuedMessage) {
      window.queueMicrotask(() => {
        setEditingIndex((current) => (current === null ? null : Math.max(0, current - 1)))
      })
    }
    window.cells.agentSession.notifyQueuedStart(agentWindow.id)
    void sendToAgent(
      next.text,
      next.attachments,
      {
        model: next.model,
        thinkingLevel: next.thinkingLevel,
        permissionMode: next.permissionMode,
      },
      next.replyTo ?? null,
    )
      .catch((err) => {
        console.error('[agent-chat] queued send failed', err)
        // Put it back at the front so the user can retry / see it.
        setQueuedMessages((q) => [next, ...q])
        if (sentBeforeEditedQueuedMessage) {
          setEditingIndex((current) => (current === null ? null : current + 1))
        }
        awaitingRunningRef.current = false
      })
      .finally(() => {
        sendingQueuedRef.current = false
      })
  }, [
    agentWindow.id,
    editingIndex,
    queuedMessages,
    resumeGated,
    sendToAgent,
    setQueuedMessages,
    snapshot?.status,
  ])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (inlineMention.open) {
        const mentionResult = inlineMention.handleKeyDown(event.nativeEvent)
        if (mentionResult) {
          if (mentionResult !== 'handled') applyInlineMentionSelection(mentionResult)
          event.stopPropagation()
          return
        }
      }
      if (event.key !== 'Enter') return
      const hasPrimary = hasPrimaryModifier(event.nativeEvent)
      if (event.shiftKey && !hasPrimary && !event.altKey) return // Shift+Enter → newline
      if (editingIndex !== null) {
        event.preventDefault()
        event.stopPropagation()
        commitEditQueued()
        return
      }
      if (isViewportFitEnter(event, hasPrimary)) return
      // Mod+Option+Enter branches the current session and sends the selected composer text there.
      if (isBranchComposerEnter(event, hasPrimary)) {
        event.preventDefault()
        event.stopPropagation()
        void startNewSessionFromComposer()
        return
      }
      // Mod+Enter: interrupt the running turn and send this message next.
      if (hasPrimary) {
        event.preventDefault()
        event.stopPropagation()
        void submit('stop')
        return
      }
      // Option+Enter: send after the next tool call completes.
      if (event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        void submit('after-tool')
        return
      }
      // Plain Enter (while running): queue until the turn finishes naturally.
      event.preventDefault()
      event.stopPropagation()
      void submit('after-turn')
    },
    [
      applyInlineMentionSelection,
      commitEditQueued,
      editingIndex,
      inlineMention,
      startNewSessionFromComposer,
      submit,
    ],
  )

  const absorbDroppedImages = useCallback(
    async (dataTransfer: DataTransfer) => {
      const files = Array.from(dataTransfer.files)
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (images.length === 0) return
      const saved: string[] = []
      for (const file of images) {
        // Finder / native drags: we already have a path on disk, no need to
        // copy into the temp dir.
        try {
          const existing = window.cells.app.getPathForFile(file)
          if (existing) {
            saved.push(existing)
            continue
          }
        } catch {
          // getPathForFile throws for cross-app / in-memory blobs — fall through
        }
        try {
          const buf = new Uint8Array(await file.arrayBuffer())
          const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
          const name = file.name && file.name.trim() ? file.name : `drop-${Date.now()}.${ext}`
          const stored = await window.cells.app.saveTempFile(buf, name)
          if (stored) saved.push(stored)
        } catch (err) {
          console.error('[agent-chat] save dropped image failed', err)
        }
      }
      if (saved.length > 0) {
        const offset = getComposerSelectionOffset(textareaRef.current)
        const inserted = getImageTokenInsertResult(
          inputRef.current,
          offset,
          attachmentsRef.current,
          saved,
        )
        writeComposer(inserted.value, [...attachmentsRef.current, ...saved], {
          selectionOffset: inserted.offset,
        })
      }
    },
    [writeComposer],
  )

  // Capture-phase fallback for ancestors that swallow keydown.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.activeElement !== textareaRef.current) return
      if (inlineMention.open) {
        const mentionResult = inlineMention.handleKeyDown(event)
        if (mentionResult) {
          if (mentionResult !== 'handled') applyInlineMentionSelection(mentionResult)
          event.stopPropagation()
          return
        }
      }
      if (event.key === 'Escape' && isRunning) {
        event.preventDefault()
        event.stopPropagation()
        if (stopConfirmArmed) {
          if (stopConfirmTimerRef.current) {
            clearTimeout(stopConfirmTimerRef.current)
            stopConfirmTimerRef.current = null
          }
          setStopConfirmArmed(false)
          void handleStop()
        } else {
          setStopConfirmArmed(true)
          if (stopConfirmTimerRef.current) clearTimeout(stopConfirmTimerRef.current)
          stopConfirmTimerRef.current = setTimeout(() => {
            setStopConfirmArmed(false)
            stopConfirmTimerRef.current = null
          }, 2000)
        }
        return
      }
      if (event.key !== 'Enter') return
      const hasPrimary = hasPrimaryModifier(event)
      if (event.shiftKey && !hasPrimary && !event.altKey) return
      if ((event as any).isComposing || event.keyCode === 229) return
      if (isViewportFitEnter(event, hasPrimary)) return
      event.preventDefault()
      event.stopPropagation()
      if (editingIndex !== null) {
        commitEditQueued()
      } else if (isBranchComposerEnter(event, hasPrimary)) {
        void startNewSessionFromComposer()
      } else if (hasPrimary) {
        void submit('stop')
      } else if (event.altKey) {
        void submit('after-tool')
      } else {
        void submit('after-turn')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [
    agentWindow.id,
    applyInlineMentionSelection,
    commitEditQueued,
    editingIndex,
    handleStop,
    inlineMention,
    isRunning,
    startNewSessionFromComposer,
    stopConfirmArmed,
    submit,
  ])

  // Disarm + clear the confirmation timer once the session is no longer
  // running, so the hint doesn't linger after the turn resolves on its own.
  useEffect(() => {
    if (isRunning) return
    if (stopConfirmTimerRef.current) {
      clearTimeout(stopConfirmTimerRef.current)
      stopConfirmTimerRef.current = null
    }
    if (!stopConfirmArmed) return
    const timeout = window.setTimeout(() => setStopConfirmArmed(false), 0)
    return () => window.clearTimeout(timeout)
  }, [isRunning, stopConfirmArmed])

  useEffect(
    () => () => {
      if (stopConfirmTimerRef.current) {
        clearTimeout(stopConfirmTimerRef.current)
        stopConfirmTimerRef.current = null
      }
    },
    [],
  )

  useEffect(() => {
    if (hasMessages) return
    let cancelled = false
    window.cells.agentSession
      .listRecentSessions(agentWindow.agent, 8)
      .then((sessions) => {
        if (!cancelled) setRecentSessions(sessions)
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[agent-chat] listRecentSessions failed', err)
          setRecentSessions([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [agentWindow.agent, hasMessages])

  const openRecentSession = useCallback(
    (session: RecentAgentSessionSummary) => {
      const store = useStore.getState()
      if (session.origin === 'cells' && session.windowId) {
        store.addAgentWindow(session.agent, {
          id: session.windowId,
          title: session.title,
          cwd: session.cwd ?? null,
          claudeSessionId: session.claudeSessionId ?? null,
          codexThreadId: session.codexThreadId ?? null,
          model: session.model ?? null,
        })
      } else {
        store.addAgentWindow(session.agent, {
          title: session.title,
          cwd: session.cwd ?? null,
          claudeSessionId: session.claudeSessionId ?? null,
          codexThreadId: session.codexThreadId ?? null,
          model: session.model ?? null,
        })
      }
      store.removeAgentWindow(agentWindow.id)
    },
    [agentWindow.id],
  )

  const sessionDiffStats = useMemo(() => sumDiffStats(visibleMessages), [visibleMessages])
  // Only one side panel can be open at a time — swap between 'diffs' and
  // 'plan' (and whatever else we add later) via a single slot. Rendered
  // through a shared AnimatePresence so opening / closing slides from the
  // right edge rather than popping in.
  const [sidePanel, setSidePanel] = useState<'diffs' | 'plan' | null>(null)
  const diffsPanelOpen = sidePanel === 'diffs'
  const planPanelOpen = sidePanel === 'plan'
  const pendingPlanApproval = visibleSnapshot?.pendingPlanApproval
  // Persist the plan panel width so the size the user picks carries across
  // sessions, window reopens, and app restarts.
  const [sidePanelWidth, setSidePanelWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return SIDE_PANEL_DEFAULT_WIDTH
    const raw = window.localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY)
    const parsed = raw ? Number.parseInt(raw, 10) : NaN
    if (!Number.isFinite(parsed)) return SIDE_PANEL_DEFAULT_WIDTH
    return Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, parsed))
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(sidePanelWidth))
  }, [sidePanelWidth])
  // Live-resize the panel as the user drags the left-edge handle. We attach
  // pointer listeners to window so the drag keeps tracking even when the
  // cursor leaves the 4px hot strip, and pointer-capture would fight the
  // AnimatePresence motion.div that wraps the panel.
  const handleSidePanelResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = sidePanelWidth
      const onMove = (ev: PointerEvent) => {
        const delta = startX - ev.clientX
        const next = Math.min(
          SIDE_PANEL_MAX_WIDTH,
          Math.max(SIDE_PANEL_MIN_WIDTH, startWidth + delta),
        )
        setSidePanelWidth(next)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidePanelWidth],
  )
  // Auto-open the plan panel each time a new proposed plan arrives so the
  // user sees it without hunting for the "View plan" button. We key on the
  // createdAt timestamp so re-opens / turn swaps re-trigger naturally, and
  // auto-close when the plan resolves so the panel doesn't linger empty.
  const lastAutoOpenedPlanAt = useRef<number | null>(null)
  useEffect(() => {
    let frame: number | null = null
    if (!pendingPlanApproval) {
      lastAutoOpenedPlanAt.current = null
      frame = window.requestAnimationFrame(() => {
        setSidePanel((prev) => (prev === 'plan' ? null : prev))
      })
    } else if (lastAutoOpenedPlanAt.current !== pendingPlanApproval.createdAt) {
      lastAutoOpenedPlanAt.current = pendingPlanApproval.createdAt
      frame = window.requestAnimationFrame(() => {
        setSidePanel('plan')
      })
    }
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [pendingPlanApproval])
  const streamingTurnKey = useMemo(() => {
    if (!isRunning) return null
    for (let i = visibleGroups.length - 1; i >= 0; i -= 1) {
      const group = visibleGroups[i]
      if (group.kind === 'turn') return group.key
    }
    return null
  }, [isRunning, visibleGroups])
  // Show the Craft-style "working" pill whenever the agent is running and the
  // last rendered group isn't a turn (= model hasn't emitted anything yet).
  const showPendingLoader =
    isRunning &&
    (visibleGroups.length === 0 || visibleGroups[visibleGroups.length - 1].kind !== 'turn')

  return (
    <div
      className="agent-chat-panel flex h-full min-h-0"
      data-focus-zone="chat"
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes('Files')) {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        void absorbDroppedImages(event.dataTransfer)
      }}
    >
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            className="min-h-0 flex-1"
            style={{
              // Preserve the 28px top fade and only add a slim 12px softener
              // just above the composer — we WANT content to stay visible
              // beneath the composer so the backdrop-blur has something to
              // blur. A full composer-height fade would erase content before
              // it reaches the overlay, defeating the "scroll behind" effect.
              maskImage:
                'linear-gradient(to bottom, transparent 0%, black 28px, black calc(100% - 12px), transparent 100%)',
              WebkitMaskImage:
                'linear-gradient(to bottom, transparent 0%, black 28px, black calc(100% - 12px), transparent 100%)',
            }}
          >
            {isLoadingSnapshot || !hasMessages ? (
              <ScrollArea
                className="h-full min-w-0"
                viewportRef={scrollViewportRef}
                viewportClassName="rounded-none"
              >
                <div
                  className="mx-auto min-h-full w-[calc(100%-2rem)] max-w-3xl py-6"
                  style={{ paddingBottom: composerOverlayHeight + 24 }}
                >
                  {isLoadingSnapshot ? (
                    <ChatLoadingSkeleton />
                  ) : (
                    <div className="flex min-h-[360px] flex-col items-center justify-center gap-4 py-8">
                      <div className="relative flex size-14 items-center justify-center rounded-[16px] border border-border/60 bg-background/85 shadow-middle">
                        <AgentIcon agent={agentWindow.agent} className="size-7" />
                        <span
                          className={cn(
                            'absolute -right-1 -bottom-1 size-3 rounded-full ring-2 ring-background',
                            isRunning
                              ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]'
                              : 'bg-muted-foreground/40',
                          )}
                        />
                      </div>
                      <div className="space-y-1.5 text-center">
                        <p className="text-[15px] font-semibold tracking-tight text-foreground">
                          New {getAgentDisplayName(agentWindow.agent)} session
                        </p>
                        {cwdDisplay ? (
                          <div className="flex justify-center">
                            <WorktreeManager agentWindowId={agentWindow.id} />
                          </div>
                        ) : (
                          <p className="text-[11.5px] text-muted-foreground/60">
                            No working directory
                          </p>
                        )}
                      </div>
                      <AgentEmptyStateHint />
                      <div className="flex w-full max-w-xl flex-wrap items-center justify-center gap-1.5 text-[11px] text-muted-foreground/70">
                        {(['stop', 'after-tool', 'after-turn'] as const).map((mode) => {
                          const meta = queueModeMeta[mode]
                          return (
                            <div
                              key={mode}
                              className="inline-flex items-center gap-1.5 rounded-[999px] bg-background/35 px-2.5 py-1"
                            >
                              <meta.Icon className={cn('size-3.5 shrink-0', meta.tint)} />
                              <span className="text-foreground/80">{meta.label}</span>
                              <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-foreground/6 px-1 text-[10px] text-muted-foreground/80">
                                {meta.shortcut}
                              </Kbd>
                            </div>
                          )
                        })}
                      </div>
                      {filteredRecentSessions.length > 0 ? (
                        <div className="w-full max-w-xl">
                          <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/65">
                            <History className="size-3.5" />
                            Recent Sessions
                          </div>
                          <div className="relative">
                            <div
                              ref={recentSessionsViewportRef}
                              className="max-h-[250px] w-full overflow-y-auto overscroll-contain pr-2"
                            >
                              <div className="flex flex-col gap-0.5 pb-2">
                                {filteredRecentSessions.map((session) => (
                                  <button
                                    key={`${session.origin}:${session.windowId ?? session.nativeId ?? session.title}`}
                                    type="button"
                                    onClick={() => openRecentSession(session)}
                                    className="flex w-full min-w-0 items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-foreground/5"
                                  >
                                    <AgentIcon agent={session.agent} className="size-4 shrink-0" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center gap-2">
                                        <span className="min-w-0 truncate text-[12.5px] font-medium text-foreground/90">
                                          {session.title}
                                        </span>
                                        <span className="shrink-0 rounded-[6px] border border-border/35 bg-background/50 px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
                                          {session.sourceLabel}
                                        </span>
                                      </div>
                                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/65">
                                        {session.cwd ? (
                                          <span className="truncate font-mono">
                                            {truncateCwd(session.cwd)}
                                          </span>
                                        ) : null}
                                        <span className="shrink-0">
                                          {formatRelativeTime(session.updatedAt)}
                                        </span>
                                      </div>
                                    </div>
                                    <span className="shrink-0 text-[11px] text-muted-foreground/70">
                                      {session.origin === 'cells' ? 'Open' : 'Import'}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </div>
                            {recentSessionsFade.top ? (
                              <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-background via-background/95 to-transparent" />
                            ) : null}
                            {recentSessionsFade.bottom ? (
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background via-background/95 to-transparent" />
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </ScrollArea>
            ) : (
              <LegendList<ChatGroup>
                key={agentWindow.id}
                ref={listRef}
                data={visibleGroups}
                // LegendList recycles row renders and only refreshes them when
                // the backing item or `extraData` changes. The row UI also
                // depends on which turn is currently streaming, so surface that
                // as extraData; otherwise an older turn can stay visually stuck
                // in the "Working..." state after a newer turn becomes active.
                extraData={streamingTurnKey || ''}
                keyExtractor={chatGroupKey}
                renderItem={({ item }) => (
                  <div className="mx-auto w-[calc(100%-2rem)] min-w-0 max-w-3xl">
                    <div className="pb-3">
                      <MessageGroupRow
                        group={item}
                        cwd={activeProjectPath ?? visibleSnapshot?.cwd ?? agentWindow.cwd ?? null}
                        agent={agentWindow.agent}
                        isStreamingLastTurn={item.kind === 'turn' && item.key === streamingTurnKey}
                        onReply={beginReply}
                      />
                    </div>
                  </div>
                )}
                estimatedItemSize={120}
                initialScrollAtEnd
                maintainScrollAtEnd={
                  streamingTurnKey && !reduceMotion
                    ? { animated: true, on: { dataChange: true, itemLayout: true, layout: true } }
                    : true
                }
                maintainScrollAtEndThreshold={0.1}
                maintainVisibleContentPosition
                className="h-full overscroll-y-contain"
                ListHeaderComponent={<div className="h-6" />}
                ListFooterComponent={
                  <div
                    className="mx-auto w-[calc(100%-2rem)] min-w-0 max-w-3xl"
                    style={{ paddingBottom: composerOverlayHeight + 24 }}
                  >
                    {showPendingLoader ? <PendingTurnIndicator agent={agentWindow.agent} /> : null}
                  </div>
                }
              />
            )}
          </div>

          <div
            ref={composerOverlayRef}
            // Short gradient fade at the top edge softens where content meets
            // the composer. pointer-events-none on the wrapper lets the empty
            // margins around the composer pass clicks through to the list;
            // the inner max-w-3xl re-enables events for the composer itself.
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-b from-background/0 via-background to-background px-4 pb-4 pt-3"
          >
            <div className="pointer-events-auto mx-auto max-w-3xl">
              {hasDiffStats(sessionDiffStats) ? (
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setSidePanel((v) => (v === 'diffs' ? null : 'diffs'))}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-[6px] bg-foreground/5 px-2 py-0.5 text-[11px] text-muted-foreground/80 backdrop-blur-sm transition-colors hover:bg-foreground/10',
                      diffsPanelOpen && 'bg-foreground/10 text-foreground/90',
                    )}
                    title="Show session diffs"
                  >
                    <span className="tabular-nums">
                      {sessionDiffStats.additions > 0 ? (
                        <span className="text-emerald-400/80">+{sessionDiffStats.additions}</span>
                      ) : null}
                      {sessionDiffStats.additions > 0 && sessionDiffStats.deletions > 0 ? ' ' : ''}
                      {sessionDiffStats.deletions > 0 ? (
                        <span className="text-rose-400/80">-{sessionDiffStats.deletions}</span>
                      ) : null}
                      {sessionDiffStats.additions === 0 &&
                      sessionDiffStats.deletions === 0 &&
                      (sessionDiffStats.changedFiles ?? 0) > 0 ? (
                        <span className="text-muted-foreground/85">
                          {sessionDiffStats.changedFiles} file
                          {sessionDiffStats.changedFiles === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </div>
              ) : null}
              {visibleSnapshot?.error ? (
                <SessionErrorBanner
                  error={visibleSnapshot.error}
                  agent={agentWindow.agent}
                  onRetry={
                    lastUserMessage
                      ? () =>
                          void sendToAgent(
                            lastUserMessage.text,
                            lastUserMessage.attachments ?? [],
                            {
                              model: agentWindow.model ?? null,
                              thinkingLevel: agentWindow.thinkingLevel ?? null,
                              permissionMode: agentWindow.permissionMode ?? null,
                            },
                            lastUserMessage.replyTo ?? null,
                          )
                      : null
                  }
                />
              ) : null}
              {visibleSnapshot?.pendingPlanApproval ? (
                <PlanApprovalBanner
                  key={visibleSnapshot.pendingPlanApproval.createdAt}
                  windowId={agentWindow.id}
                  agent={agentWindow.agent}
                  planOpen={planPanelOpen}
                  onOpenPlan={() => setSidePanel((v) => (v === 'plan' ? null : 'plan'))}
                />
              ) : null}
              {visibleSnapshot?.pendingApproval ? (
                <AgentApprovalBanner
                  key={visibleSnapshot.pendingApproval.createdAt}
                  windowId={agentWindow.id}
                  approval={visibleSnapshot.pendingApproval}
                />
              ) : null}
              {visibleSnapshot?.pendingQuestion ? (
                <QuestionBanner
                  key={visibleSnapshot.pendingQuestion.createdAt}
                  windowId={agentWindow.id}
                  agent={agentWindow.agent}
                  questions={visibleSnapshot.pendingQuestion.questions}
                />
              ) : null}
              {visibleSnapshot?.codexPlan ? (
                <CodexPlanBanner plan={visibleSnapshot.codexPlan} />
              ) : null}
              {resumeGated && (queuedMessages.length > 0 || midTurnDetected) ? (
                <div className="mb-2 flex items-center gap-2 rounded-[10px] border border-amber-400/25 bg-amber-400/5 px-2.5 py-1.5 text-[12px] text-foreground/90 shadow-minimal backdrop-blur-sm">
                  <Clock className="size-3.5 shrink-0 text-amber-400/90" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground/90">
                    {queuedMessages.length > 0
                      ? queuedMessages.length === 1
                        ? '1 message queued from your last session.'
                        : `${queuedMessages.length} messages queued from your last session.`
                      : 'Your last session ended mid-turn.'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setResumeGated(false)
                      setMidTurnDetected(false)
                      if (queuedMessages.length > 0) {
                        setQueueCollapsed(false)
                      } else {
                        void sendToAgent('Please continue where you left off.', [], {
                          model: agentWindow.model ?? null,
                          thinkingLevel: agentWindow.thinkingLevel ?? null,
                          permissionMode: agentWindow.permissionMode ?? null,
                        })
                      }
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-[8px] bg-amber-400/90 px-2.5 py-1 text-[11.5px] font-medium text-background transition-colors hover:bg-amber-400"
                  >
                    <ArrowUp className="size-3" />
                    Continue
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (queuedMessages.length > 0) setQueuedMessages(() => [])
                      setResumeGated(false)
                      setMidTurnDetected(false)
                    }}
                    aria-label={queuedMessages.length > 0 ? 'Discard queued messages' : 'Dismiss'}
                    className="shrink-0 rounded p-1 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground"
                    title={queuedMessages.length > 0 ? 'Discard queued messages' : 'Dismiss'}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : null}
              {queuedMessages.length > 0 ? (
                <div className="mb-2 select-none">
                  {(() => {
                    const forceQueueExpanded = queuedMessages.length === 1
                    const next = queuedMessages[0]
                    const meta = queueModeMeta[next.mode]
                    if (forceQueueExpanded) return null
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          setQueueCollapsed((v) => !v)
                        }}
                        // Backdrop-blur + translucent bg lets the chat content
                        // behind stay hinted-at instead of being covered by a
                        // hard fill. Kept subtle per Emil's "speed over
                        // delight" rule — blur is used as a readability
                        // affordance, not decoration.
                        className={cn(
                          'flex w-full items-center gap-2 rounded-[8px] bg-background/60 px-2 py-1 text-left shadow-minimal backdrop-blur-md transition-colors focus:outline-none',
                          'hover:bg-background/75',
                        )}
                        title={queueCollapsed ? 'Show queued messages' : 'Hide queued messages'}
                      >
                        <span className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums shadow-minimal">
                          {queuedMessages.length}
                        </span>
                        <meta.Icon
                          className={cn('size-3.5 shrink-0', meta.tint)}
                          aria-label={meta.label}
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                          {next.text.replace(/\n/g, ' ') || '(attached files)'}
                        </span>
                        <ChevronRight
                          className={cn(
                            'ml-auto size-3.5 shrink-0 text-muted-foreground/70 transition-transform',
                            !queueCollapsed && 'rotate-90',
                          )}
                        />
                      </button>
                    )
                  })()}
                  <AnimatePresence initial={false}>
                    {!queueCollapsed || queuedMessages.length === 1 ? (
                      <motion.div
                        key="queue-list"
                        initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={reduceMotion ? { opacity: 0 } : { height: 0 }}
                        transition={EXPAND_TRANSITION}
                        style={{ overflow: 'hidden' }}
                      >
                        <div
                          ref={queueScrollRef}
                          onScroll={updateQueueScrollFade}
                          // Mask-image creates a subtle fade at whichever edge has
                          // hidden content. Uses a narrow 10px band and fades to
                          // 78% (not full transparent) so the effect reads as a
                          // hint, not a cut. Only the active edge fades, so when
                          // you're at the top there's just a fade at the bottom
                          // and vice versa.
                          style={
                            queueScrollFade.top || queueScrollFade.bottom
                              ? {
                                  maskImage: `linear-gradient(to bottom, ${
                                    queueScrollFade.top ? 'rgba(0,0,0,0.78)' : 'black'
                                  } 0, black 10px, black calc(100% - 10px), ${
                                    queueScrollFade.bottom ? 'rgba(0,0,0,0.78)' : 'black'
                                  } 100%)`,
                                  WebkitMaskImage: `linear-gradient(to bottom, ${
                                    queueScrollFade.top ? 'rgba(0,0,0,0.78)' : 'black'
                                  } 0, black 10px, black calc(100% - 10px), ${
                                    queueScrollFade.bottom ? 'rgba(0,0,0,0.78)' : 'black'
                                  } 100%)`,
                                }
                              : undefined
                          }
                          className={cn(
                            'flex max-h-[108px] flex-col gap-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-0.5',
                            queuedMessages.length > 1 && 'mt-1',
                          )}
                        >
                          <AnimatePresence initial={false}>
                            {queuedMessages.map((entry, i) => {
                              const meta = queueModeMeta[entry.mode]
                              const modelLabel = entry.model
                                ? prettifyModelId(agentWindow.agent, entry.model)
                                : null
                              const thinkingLabel =
                                entry.thinkingLevel && entry.thinkingLevel !== 'off'
                                  ? THINKING_LEVEL_LABEL_MAP[entry.thinkingLevel]
                                  : null
                              const permissionOption = entry.permissionMode
                                ? PERMISSION_MODE_OPTIONS.find((o) => o.id === entry.permissionMode)
                                : null
                              const isEditing = editingIndex === i
                              const isDragging = dragIndex === i
                              const isDropTarget =
                                dragOverIndex === i && dragIndex !== null && dragIndex !== i
                              const queueKey = entry.id
                              return (
                                <motion.div
                                  key={queueKey}
                                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                                  transition={{ duration: 0.18, ease: EASE_OUT }}
                                  draggable={!isEditing}
                                  // motion.div retypes the drag event handlers for
                                  // its own gesture system (MouseEvent | TouchEvent |
                                  // PointerEvent). HTML5 drag-and-drop still fires
                                  // here at runtime — the events are real DragEvents,
                                  // we just have to cast back to access dataTransfer.
                                  onDragStart={(event) => {
                                    if (isEditing) return
                                    const e = event as unknown as React.DragEvent<HTMLDivElement>
                                    setDragIndex(i)
                                    e.dataTransfer.effectAllowed = 'move'
                                    try {
                                      e.dataTransfer.setData('text/plain', String(i))
                                    } catch {
                                      // Safari may throw if dataTransfer is locked; drag still works.
                                    }
                                  }}
                                  onDragOver={(event) => {
                                    if (dragIndex === null || dragIndex === i) return
                                    const e = event as unknown as React.DragEvent<HTMLDivElement>
                                    e.preventDefault()
                                    e.dataTransfer.dropEffect = 'move'
                                    if (dragOverIndex !== i) setDragOverIndex(i)
                                  }}
                                  onDragLeave={() => {
                                    setDragOverIndex((prev) => (prev === i ? null : prev))
                                  }}
                                  onDrop={(event) => {
                                    const e = event as unknown as React.DragEvent<HTMLDivElement>
                                    e.preventDefault()
                                    if (dragIndex !== null && dragIndex !== i) {
                                      reorderQueue(dragIndex, i)
                                    }
                                    setDragIndex(null)
                                    setDragOverIndex(null)
                                  }}
                                  onDragEnd={() => {
                                    setDragIndex(null)
                                    setDragOverIndex(null)
                                  }}
                                  className={cn(
                                    'group/queued flex gap-2 rounded-[10px] bg-foreground/5 px-2.5 py-1.5 text-[12px] text-foreground/85 transition-colors backdrop-blur-sm',
                                    entry.replyTo ? 'items-start' : 'items-center',
                                    isEditing && 'bg-cyan-500/10',
                                    isDragging && 'opacity-50',
                                    isDropTarget && 'bg-foreground/10',
                                  )}
                                  title={
                                    isEditing
                                      ? 'Editing in composer'
                                      : `${meta.shortcut} · ${meta.hint}`
                                  }
                                >
                                  <span
                                    className={cn(
                                      'flex size-3.5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/40 transition-colors hover:text-foreground/70 active:cursor-grabbing',
                                      isEditing && 'text-cyan-300/80',
                                    )}
                                    aria-label="Drag to reorder"
                                    title="Drag to reorder"
                                  >
                                    <GripVertical className="size-3" />
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => toggleQueuedMode(i)}
                                    aria-label={`Change queue mode from ${meta.label}`}
                                    title={`${meta.label} · click to switch queue mode`}
                                    className="shrink-0 rounded-[6px] p-0.5 hover:bg-foreground/10"
                                  >
                                    <meta.Icon className={cn('size-3.5 shrink-0', meta.tint)} />
                                  </button>
                                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    {entry.replyTo ? (
                                      <ReplyPreview replyTo={entry.replyTo} compact />
                                    ) : null}
                                    <div className="flex min-w-0 items-center gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => beginEditQueued(i)}
                                        className={cn(
                                          'min-w-0 flex-1 truncate text-left text-muted-foreground/90 hover:text-foreground',
                                          isEditing && 'text-cyan-100',
                                        )}
                                        title={
                                          isEditing ? 'Editing in composer' : 'Edit in composer'
                                        }
                                      >
                                        {entry.text.replace(/\n/g, ' ') ||
                                          (entry.attachments.length > 0
                                            ? ATTACHMENTS_ONLY_TEXT
                                            : '')}
                                      </button>
                                      {entry.attachments.length > 0 ? (
                                        <div className="flex shrink-0 items-center gap-1">
                                          {entry.attachments.slice(0, 4).map((p) => (
                                            <QueueAttachmentThumb key={p} path={p} />
                                          ))}
                                          {entry.attachments.length > 4 ? (
                                            <span className="text-[10px] tabular-nums text-muted-foreground/70">
                                              +{entry.attachments.length - 4}
                                            </span>
                                          ) : null}
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground/80">
                                    {modelLabel ? (
                                      <span
                                        className="rounded-[6px] bg-background/60 px-1.5 py-px"
                                        title={`Model: ${modelLabel}`}
                                      >
                                        {modelLabel}
                                      </span>
                                    ) : null}
                                    {thinkingLabel ? (
                                      <span
                                        className="rounded-[6px] bg-background/60 px-1.5 py-px"
                                        title={`Thinking: ${thinkingLabel}`}
                                      >
                                        {thinkingLabel}
                                      </span>
                                    ) : null}
                                    {permissionOption ? (
                                      <span
                                        className={cn(
                                          'inline-flex items-center gap-1 rounded-[6px] bg-background/60 px-1.5 py-px',
                                          permissionOption.tint,
                                        )}
                                        title={`Permission: ${permissionOption.label}`}
                                      >
                                        <permissionOption.Icon className="size-2.5" />
                                        {permissionOption.short}
                                      </span>
                                    ) : null}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => sendQueuedImmediately(i)}
                                    aria-label="Send queued message now"
                                    title="Send now"
                                    className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground"
                                  >
                                    <ArrowUp className="size-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => beginEditQueued(i)}
                                    aria-label="Edit queued message"
                                    title="Edit"
                                    className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground"
                                  >
                                    <Pencil className="size-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => unqueueMessage(i)}
                                    aria-label="Remove queued message"
                                    className="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:bg-foreground/10 hover:text-foreground"
                                  >
                                    <X className="size-3" />
                                  </button>
                                </motion.div>
                              )
                            })}
                          </AnimatePresence>
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              ) : null}
              {hasBackgroundActivity && visibleSnapshot?.status !== 'running' ? (
                <BackgroundActivityBanner
                  agent={agentWindow.agent}
                  activities={backgroundActivities}
                  onStop={() => {
                    void handleStop()
                  }}
                />
              ) : null}
              <div
                className="group/composer relative overflow-hidden rounded-[12px] shadow-minimal"
                style={{ backgroundColor: 'var(--elevated-surface)' }}
              >
                <AnimatePresence initial={false}>
                  {isEditingQueuedMessage ? (
                    <motion.div
                      key="editing-queued"
                      // Height animations trigger layout (skill's golden rule
                      // prefers transform/opacity), but the banner is a one-shot
                      // toggle so the cost is paid at most once per edit — a
                      // reasonable trade for the natural expand/collapse feel.
                      initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={reduceMotion ? { opacity: 0 } : { height: 0 }}
                      transition={EXPAND_TRANSITION}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="flex items-center justify-between gap-3 bg-cyan-500/6 px-3 py-2 text-[11.5px]">
                        <div className="min-w-0">
                          <span className="font-medium text-cyan-100">Editing queued message</span>
                          <span className="ml-1.5 text-muted-foreground/80">
                            Save updates back into the queue.
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={cancelEditQueued}
                          className="shrink-0 rounded-[6px] px-2 py-1 text-muted-foreground/75 transition-colors hover:bg-foreground/10 hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
                <InlineMentionMenu
                  open={inlineMention.open}
                  items={inlineMention.items}
                  query={inlineMention.query}
                  selectedIndex={inlineMention.selectedIndex}
                  onHover={inlineMention.setSelectedIndex}
                  onSelect={(item) => {
                    applyInlineMentionSelection(inlineMention.selectItem(item))
                  }}
                />
                {replyTo ? (
                  <div className="px-3 pt-3">
                    <ReplyPreview replyTo={replyTo} onClear={() => setComposerReplyTarget(null)} />
                  </div>
                ) : null}
                {attachments.length > 0 ? (
                  <div className={cn('space-y-2 px-3 pb-1', replyTo ? 'pt-2' : 'pt-3')}>
                    {composerImageAttachments.length > 0 ? (
                      <div className="flex flex-wrap gap-2.5">
                        {composerImageAttachments.map((path) => (
                          <ComposerImageAttachment
                            key={path}
                            path={path}
                            onPreview={() => setComposerPreviewPath(path)}
                            onRemove={() => removeAttachment(path)}
                          />
                        ))}
                      </div>
                    ) : null}
                    {composerFileAttachments.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {composerFileAttachments.map((path) => (
                          <ComposerAttachmentChip
                            key={path}
                            path={path}
                            onRemove={() => removeAttachment(path)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <ComposerRichEditor
                  editorRef={textareaRef}
                  value={input}
                  imageAttachments={composerImageAttachments}
                  placeholder={
                    isEditingQueuedMessage ? 'Edit queued message…' : composerPlaceholder
                  }
                  selectionOffset={pendingComposerSelectionOffset}
                  onSelectionOffsetApplied={clearPendingComposerSelectionOffset}
                  onChange={(nextValue, cursorPosition) => {
                    writeComposer(nextValue, attachmentsRef.current)
                    inlineMention.handleInputChange(nextValue, cursorPosition)
                  }}
                  onKeyDown={handleKeyDown}
                  onPasteImages={(files, insertOffset) => {
                    void (async () => {
                      const saved: string[] = []
                      for (const file of files) {
                        const buf = new Uint8Array(await file.arrayBuffer())
                        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
                        const name =
                          file.name && file.name.trim()
                            ? file.name
                            : `clipboard-${Date.now()}.${ext}`
                        try {
                          const stored = await window.cells.app.saveTempFile(buf, name)
                          if (stored) saved.push(stored)
                        } catch (err) {
                          console.error('[agent-chat] save pasted image failed', err)
                        }
                      }
                      if (saved.length > 0) {
                        const inserted = getImageTokenInsertResult(
                          inputRef.current,
                          insertOffset,
                          attachmentsRef.current,
                          saved,
                        )
                        writeComposer(inserted.value, [...attachmentsRef.current, ...saved], {
                          selectionOffset: inserted.offset,
                        })
                      }
                    })()
                  }}
                  onRemoveImage={removeAttachment}
                />
                <ComposerImagePreviewDialog
                  path={visibleComposerPreviewPath}
                  onClose={() => setComposerPreviewPath(null)}
                />
                <div className="flex items-center gap-1.5 px-2 pb-2 pt-0.5">
                  <button
                    type="button"
                    onClick={pickAttachments}
                    aria-label="Attach files"
                    className="inline-flex h-7 shrink-0 items-center justify-center rounded-[8px] bg-foreground/5 px-2 text-muted-foreground/85 transition-colors hover:bg-foreground/10 hover:text-foreground"
                    title="Attach files"
                  >
                    <Paperclip className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void startBrowserElementPicker()}
                    aria-label={
                      selectingBrowserElement
                        ? 'Cancel browser element selection'
                        : 'Select browser element'
                    }
                    className={cn(
                      'inline-flex h-7 shrink-0 items-center justify-center rounded-[8px] bg-foreground/5 px-2 text-muted-foreground/85 transition-colors hover:bg-foreground/10 hover:text-foreground',
                      selectingBrowserElement &&
                        'bg-cyan-400/14 text-cyan-100 ring-1 ring-cyan-300/20 hover:bg-cyan-400/18',
                    )}
                    title={
                      browserPickTargetId
                        ? selectingBrowserElement
                          ? 'Cancel browser element selection'
                          : `Select element from ${browserPickTargetLabel}`
                        : 'Open a browser window first'
                    }
                  >
                    <MousePointer2 className="size-3.5" />
                  </button>
                  <PermissionPicker
                    value={composerPermissionMode ?? getDefaultPermissionMode()}
                    onChange={(mode: AgentPermissionMode) => {
                      if (isEditingQueuedMessage) {
                        updateQueuedEditPermission(mode)
                        return
                      }
                      const store = useStore.getState()
                      store.syncAgentWindow(agentWindow.id, { permissionMode: mode })
                      store.setLastAgentSessionDefaults(agentWindow.agent, { permissionMode: mode })
                      // Live-update the running session so the agent picks up
                      // the new mode on the NEXT turn without needing a restart.
                      void window.cells.agentSession
                        .updatePermissionMode(agentWindow.id, mode)
                        .catch((err: unknown) =>
                          console.error('[agent-chat] updatePermissionMode failed', err),
                        )
                    }}
                  />
                  <ModelPicker
                    agent={agentWindow.agent}
                    value={composerModel}
                    contextLength={isEditingQueuedMessage ? null : agentWindow.contextLength}
                    onChange={(modelId) => {
                      if (isEditingQueuedMessage) updateQueuedEditModel(modelId)
                      else updateActiveComposerModel(modelId)
                    }}
                    onContextLengthChange={
                      isEditingQueuedMessage
                        ? undefined
                        : (length: AgentContextLength) => {
                            const store = useStore.getState()
                            store.syncAgentWindow(agentWindow.id, { contextLength: length })
                            store.setLastAgentSessionDefaults(agentWindow.agent, {
                              contextLength: length,
                            })
                            // Claude session has to be reopened to pick up / drop the
                            // context-1m beta flag — the backend handles that inside
                            // updateContextLength by closing the runtime.
                            void window.cells.agentSession
                              .updateContextLength(agentWindow.id, length)
                              .catch((err: unknown) =>
                                console.error('[agent-chat] updateContextLength failed', err),
                              )
                          }
                    }
                  />
                  <ThinkingPicker
                    agent={agentWindow.agent}
                    model={composerModel}
                    value={composerThinkingLevel}
                    onChange={(level) => {
                      if (isEditingQueuedMessage) updateQueuedEditThinking(level)
                      else updateActiveComposerThinking(level)
                    }}
                  />
                  <ContextUsageIndicator
                    usage={visibleSnapshot?.usage ?? null}
                    agent={agentWindow.agent}
                    contextLength={agentWindow.contextLength}
                  />
                  {hasMessages && visibleSnapshot && hasComposerText && !isEditingQueuedMessage ? (
                    <Popover>
                      <PopoverTrigger
                        className="ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground/55 transition-colors hover:bg-foreground/8 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                        disabled={isRunning}
                        title="Branch draft"
                        aria-label="Branch draft"
                      >
                        <GitBranch className="size-3.5" />
                      </PopoverTrigger>
                      <PopoverContent
                        align="center"
                        side="top"
                        sideOffset={6}
                        className="!w-auto min-w-0 gap-0 rounded-[10px] p-1"
                      >
                        <div className="flex items-center gap-0.5">
                          {branchTargets.map((target) => (
                            <button
                              key={target.agent}
                              type="button"
                              onClick={() => void branchToAgent(target.agent)}
                              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-muted-foreground/90 transition-colors hover:bg-foreground/8 hover:text-foreground"
                              title={`Branch into ${target.label}`}
                            >
                              <AgentIcon agent={target.agent} className="size-3.5" size={14} />
                              <span className="whitespace-nowrap">
                                {target.agent === 'claude' ? 'Claude' : 'Codex'}
                              </span>
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  ) : null}
                  <div className="flex-1" />
                  <AnimatePresence initial={false} mode="popLayout">
                    {!isEditingQueuedMessage && (shortcutStatusMode || !isRunning) ? (
                      <motion.span
                        key={shortcutStatusMode ?? 'send'}
                        initial={{ opacity: 0, x: shortcutStatusMode ? 4 : 0 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: shortcutStatusMode ? 4 : 0 }}
                        transition={{ duration: 0.14, ease: EASE_OUT }}
                        className={cn(
                          'hidden items-center gap-1 text-[10.5px] sm:inline-flex',
                          shortcutStatusMode === 'branch' && 'text-emerald-200/85',
                          shortcutStatusMode === 'interrupt' && 'text-rose-200/85',
                          shortcutStatusMode === 'after-tool' && 'text-violet-200/85',
                          !shortcutStatusMode && 'text-muted-foreground/60',
                        )}
                      >
                        {shortcutStatusMode === 'branch' ? (
                          <>
                            <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-emerald-400/14 px-1 text-[10px] text-emerald-100/90">
                              {getPrimaryModifierLabel()}
                            </Kbd>
                            <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-emerald-400/14 px-1 text-[10px] text-emerald-100/90">
                              {getAltModifierLabel()}
                            </Kbd>
                            <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-emerald-400/14 px-1 text-[10px] text-emerald-100/90">
                              ↵
                            </Kbd>
                            <span>branch with message</span>
                          </>
                        ) : shortcutStatusMode === 'interrupt' ? (
                          <>
                            <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-rose-400/14 px-1 text-[10px] text-rose-100/90">
                              {getPrimaryModifierLabel()}
                            </Kbd>
                            <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-rose-400/14 px-1 text-[10px] text-rose-100/90">
                              ↵
                            </Kbd>
                            <span>kill thread + send</span>
                          </>
                        ) : shortcutStatusMode === 'after-tool' ? (
                          <>
                            <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-violet-400/14 px-1 text-[10px] text-violet-100/90">
                              {getAltModifierLabel()}
                            </Kbd>
                            <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-violet-400/14 px-1 text-[10px] text-violet-100/90">
                              ↵
                            </Kbd>
                            <span>send after next tool</span>
                          </>
                        ) : (
                          <>
                            <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-foreground/6 px-1 text-[10px] text-muted-foreground/80">
                              ↵
                            </Kbd>
                            <span>send</span>
                          </>
                        )}
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                  <AnimatePresence initial={false}>
                    {isRunning && stopConfirmArmed ? (
                      <motion.span
                        key="stop-confirm-hint"
                        initial={{ opacity: 0, x: 4 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 4 }}
                        transition={{ duration: 0.14, ease: EASE_OUT }}
                        className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground/80"
                      >
                        <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-foreground/6 px-1 text-[10px] text-muted-foreground/80">
                          Esc
                        </Kbd>
                        <span>again to stop</span>
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                  {!isEditingQueuedMessage && hasComposerText ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => void startNewSessionFromComposer()}
                            aria-label="Branch current session from selection"
                            className={cn(
                              'inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors',
                              branchShortcutActive
                                ? 'bg-emerald-400/18 text-emerald-100 shadow-[0_0_0_1px_rgba(110,231,183,0.28),0_0_18px_rgba(16,185,129,0.18)]'
                                : 'bg-foreground/5 text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground',
                            )}
                          >
                            <GitBranchPlus className="size-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          Branch current session from selection
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : null}
                  {isEditingQueuedMessage ? (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={commitEditQueued}
                      disabled={!canSaveQueuedEdit}
                      aria-label="Save queued message"
                      className={cn(
                        'ml-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-2.5 text-[11.5px] font-medium transition-colors',
                        canSaveQueuedEdit
                          ? 'bg-cyan-400/90 text-background shadow-minimal hover:bg-cyan-400'
                          : 'cursor-not-allowed bg-foreground/10 text-muted-foreground/60',
                      )}
                    >
                      <Check className="size-3.5" />
                      Save
                    </button>
                  ) : (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (isRunning) void handleStop()
                        else void submit()
                      }}
                      disabled={!isRunning && !canSubmit}
                      aria-label={isRunning ? 'Stop agent' : 'Send message'}
                      className={cn(
                        'ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors',
                        isRunning
                          ? 'bg-foreground text-background shadow-minimal hover:bg-foreground/90'
                          : canSubmit
                            ? 'bg-foreground text-background shadow-minimal hover:bg-foreground/90'
                            : 'cursor-not-allowed bg-foreground/20 text-background/70',
                      )}
                    >
                      {isRunning ? (
                        <Square className="h-3 w-3 fill-current" />
                      ) : (
                        <ArrowUp className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {sidePanel === 'diffs' ? (
          <motion.div
            key="diffs"
            className="relative z-20 flex h-full shrink-0 overflow-hidden"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 'auto', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{
              width: { duration: 0.26, ease: EASE_EXPAND },
              opacity: { duration: 0.18, ease: EASE_EXPAND },
            }}
          >
            <SessionDiffsPanel messages={visibleMessages} onClose={() => setSidePanel(null)} />
          </motion.div>
        ) : null}
        {sidePanel === 'plan' && pendingPlanApproval ? (
          <motion.div
            key="plan"
            className="relative z-20 flex h-full shrink-0 overflow-hidden"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: sidePanelWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{
              width: { duration: 0.26, ease: EASE_EXPAND },
              opacity: { duration: 0.18, ease: EASE_EXPAND },
            }}
          >
            <PlanPreviewPanel
              agent={agentWindow.agent}
              plan={pendingPlanApproval.plan}
              width={sidePanelWidth}
              onClose={() => setSidePanel(null)}
              onResizeStart={handleSidePanelResizeStart}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
