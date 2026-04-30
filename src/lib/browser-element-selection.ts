import type { BrowserElementSelection } from '@/types'

const BROWSER_SELECTION_INTRO = 'I selected this element in the browser. Use it as context.'

function compactMultiline(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function fencedBlock(language: string, value: string) {
  const fence = value.includes('```') ? '~~~~' : '```'
  return `${fence}${language}\n${value}\n${fence}`
}

function formatAttributes(attributes: Record<string, string>) {
  const entries = Object.entries(attributes)
  if (entries.length === 0) return null
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n')
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function formatBrowserElementSelection(selection: BrowserElementSelection) {
  const lines = [
    BROWSER_SELECTION_INTRO,
    '',
    `Page: ${selection.title || '(untitled)'}`,
    `URL: ${selection.url || '(unknown)'}`,
    `Element: <${selection.tagName || 'element'}>`,
    selection.selector ? `Selector: ${selection.selector}` : null,
    selection.href ? `Link: ${selection.href}` : null,
    selection.src ? `Source: ${selection.src}` : null,
    selection.alt ? `Alt: ${selection.alt}` : null,
    selection.role ? `Role: ${selection.role}` : null,
  ].filter((line): line is string => line !== null)

  const sections = [lines.join('\n')]
  const text = compactMultiline(selection.text)
  if (text) {
    sections.push(`Text:\n${fencedBlock('text', text)}`)
  }

  const attributes = formatAttributes(selection.attributes)
  if (attributes) {
    sections.push(`Attributes:\n${fencedBlock('text', attributes)}`)
  }

  const html = compactMultiline(selection.outerHtml)
  if (html) {
    sections.push(`HTML:\n${fencedBlock('html', html)}`)
  }

  return sections.join('\n\n')
}

export function formatBrowserElementClipboardHtml(selection: BrowserElementSelection) {
  const title = escapeHtml(selection.title || selection.url || 'Browser element')
  const url = selection.url
    ? `<div><a href="${escapeHtml(selection.url)}">${escapeHtml(selection.url)}</a></div>`
    : ''
  const selector = selection.selector
    ? `<div><code>${escapeHtml(selection.selector)}</code></div>`
    : ''
  const html = compactMultiline(selection.outerHtml)
  const renderedSelection =
    html || `<${selection.tagName}>${escapeHtml(selection.text)}</${selection.tagName}>`
  return [
    '<section data-cells-browser-selection="true">',
    `<h3>${title}</h3>`,
    url,
    selector,
    renderedSelection,
    '</section>',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function copyBrowserElementSelectionToClipboard(
  selection: BrowserElementSelection,
): Promise<void> {
  const text = formatBrowserElementSelection(selection)
  const html = formatBrowserElementClipboardHtml(selection)
  try {
    await window.cells.app.copyRichTextToClipboard(text, html)
  } catch {
    await navigator.clipboard.writeText(text)
  }
}

export function appendBrowserElementSelectionToDraft(
  draft: string | null | undefined,
  selection: BrowserElementSelection,
) {
  const selectionText = formatBrowserElementSelection(selection)
  const current = (draft ?? '').trimEnd()
  return current ? `${current}\n\n${selectionText}` : selectionText
}

export interface BrowserElementSelectionPreview {
  before: string
  title: string
  url: string
  element: string
  selector: string
  text: string
  html: string
}

function readSelectionField(block: string, label: string) {
  const match = block.match(new RegExp(`^${label}:\\s*(.*)$`, 'm'))
  return match?.[1]?.trim() ?? ''
}

function readSelectionFence(block: string, label: string, language: string) {
  const match = block.match(
    new RegExp(`${label}:\\n(\`\`\`|~~~~)${language}\\n([\\s\\S]*?)\\n\\1`, 'm'),
  )
  return match?.[2]?.trim() ?? ''
}

export function parseBrowserElementSelectionPreview(
  value: string,
): BrowserElementSelectionPreview | null {
  const start = value.indexOf(BROWSER_SELECTION_INTRO)
  if (start < 0) return null
  const before = value.slice(0, start).trim()
  const block = value.slice(start)
  return {
    before,
    title: readSelectionField(block, 'Page'),
    url: readSelectionField(block, 'URL'),
    element: readSelectionField(block, 'Element'),
    selector: readSelectionField(block, 'Selector'),
    text: readSelectionFence(block, 'Text', 'text'),
    html: readSelectionFence(block, 'HTML', 'html'),
  }
}
