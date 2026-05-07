#!/usr/bin/env node
/**
 * Cells MCP Server — exposes terminal and browser control tools to CLI agents.
 *
 * Agents (Claude Code, Codex, etc.) connect via stdio MCP transport.
 * This server connects to the Cells MCP bridge (Unix socket in the Electron
 * main process) to perform operations on the current project's windows.
 *
 * Project scoping: determined by CWD, matched against ~/.cells/state.json.
 */

import { FastMCP } from 'fastmcp'
import { z } from 'zod'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { BridgeClient } from './bridge-client.js'

// ---------- Configuration ----------

const STATE_DIR = process.env.CELLS_HOME_DIR || path.join(os.homedir(), '.cells')
const BRIDGE_SOCKET = process.env.CELLS_MCP_SOCKET || path.join(STATE_DIR, 'mcp-bridge.sock')
const TERMINAL_SERVICE_SOCKET = path.join(STATE_DIR, 'terminal-service.sock')
const STATE_FILE = path.join(STATE_DIR, 'state.json')

// ---------- Project resolution ----------

function resolveProjectPath(): string {
  return process.env.CELLS_PROJECT_PATH || process.cwd()
}

function resolveProjectFromState(): {
  id: string
  name: string
  path: string
} | null {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
    const cwd = resolveProjectPath()
    let best: any = null
    let bestLen = 0
    for (const project of state.projects ?? []) {
      if (cwd.startsWith(project.path) && project.path.length > bestLen) {
        best = project
        bestLen = project.path.length
      }
    }
    return best ? { id: best.id, name: best.name, path: best.path } : null
  } catch {
    return null
  }
}

// ---------- Bridge connection ----------

let bridge: BridgeClient | null = null
let bridgeSocketPath: string | null = null

const TERMINAL_SERVICE_METHODS = new Set([
  'get-project',
  'list-windows',
  'list-all-windows',
  'get-terminal-output',
  'write-terminal',
  'get-terminal-process',
  'create-terminal',
  'close-terminal',
])

async function getBridge(method: string): Promise<BridgeClient> {
  const canUseTerminalService = TERMINAL_SERVICE_METHODS.has(method)
  if (bridge?.isConnected()) {
    if (bridgeSocketPath === BRIDGE_SOCKET) return bridge
    if (canUseTerminalService && !fs.existsSync(BRIDGE_SOCKET)) return bridge
  }

  bridge?.disconnect()
  bridge = null
  bridgeSocketPath = null

  const candidates =
    BRIDGE_SOCKET === TERMINAL_SERVICE_SOCKET || !canUseTerminalService
      ? [BRIDGE_SOCKET]
      : [BRIDGE_SOCKET, TERMINAL_SERVICE_SOCKET]

  let lastError: unknown = null
  for (const socketPath of candidates) {
    const next = new BridgeClient()
    try {
      await next.connect(socketPath)
      bridge = next
      bridgeSocketPath = socketPath
      return next
    } catch (error) {
      lastError = error
      next.disconnect()
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Cells bridge is not available')
}

async function bridgeRequest(method: string, params: object = {}): Promise<any> {
  const b = await getBridge(method)
  return b.request(method, {
    projectPath: resolveProjectPath(),
    ...params,
  })
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function formatAgentMessages(messages: any[]): string {
  if (!messages.length) return 'No messages found.'
  return messages
    .map((message) => {
      const title = message.title ? ` ${message.title}` : ''
      const status = message.status ? ` [${message.status}]` : ''
      const timestamp = message.updatedAt ? ` ${new Date(message.updatedAt).toISOString()}` : ''
      return `## ${message.role}${title}${status}${timestamp}\n\n${message.text || ''}`
    })
    .join('\n\n')
}

// ---------- Server ----------

const server = new FastMCP({
  name: 'Cells',
  version: '0.1.0',
  instructions:
    'Cells is an Electron-based development environment that combines terminal emulators (powered by Ghostty) ' +
    'browser windows, and agent chat windows into a single, tiled workspace per project. ' +
    "This MCP server lets you observe and interact with the user's running terminals, browsers, and agent sessions inside Cells. " +
    'You can read terminal output, run commands, inspect/browser-control pages, take screenshots, execute JavaScript, and coordinate with other Cells agents — ' +
    "all scoped to the current project. Start with list_windows to see what's open.",
})

// ==================== Window listing ====================

server.addTool({
  name: 'list_windows',
  description:
    'List all terminal, browser, and agent windows in the current Cells project. ' +
    'Returns terminal IDs with process info, browser IDs with current URLs, and agent window IDs with chat/session status. ' +
    'Use the returned IDs with other tools to interact with specific windows.',
  parameters: z.object({}),
  execute: async () => {
    const project = resolveProjectFromState()
    if (!project) {
      return 'No Cells project found for the current directory. Add this directory as a Cells project first.'
    }

    const result = await bridgeRequest('list-windows')
    const lines: string[] = [`Project: ${project.name} (${project.path})\n`]

    if (result.terminals.length > 0) {
      lines.push('## Terminals\n')
      for (const t of result.terminals) {
        const proc = t.processInfo
          ? ` [${t.processInfo.label}${t.processInfo.isShell ? ' (idle)' : ''}]`
          : ' [no process info]'
        const agent = t.agent ? ` (agent: ${t.agent}, status: ${t.agentStatus})` : ''
        lines.push(`- **${t.title}** (id: \`${t.id}\`)${proc}${agent}`)
      }
    } else {
      lines.push('No terminals in this project.')
    }

    lines.push('')

    if (result.browsers.length > 0) {
      lines.push('## Browsers\n')
      for (const b of result.browsers) {
        lines.push(`- **${b.title}** (id: \`${b.id}\`): ${b.url}`)
      }
    } else {
      lines.push('No browsers in this project.')
    }

    lines.push('')

    if (result.agents?.length > 0) {
      lines.push('## Agents\n')
      for (const a of result.agents) {
        const pending = [
          a.pendingPlanApproval ? 'plan' : null,
          a.pendingQuestion ? 'input' : null,
          a.pendingApproval ? 'approval' : null,
        ].filter(Boolean)
        lines.push(
          `- **${a.title}** (id: \`${a.id}\`, agent: ${a.agent}, status: ${a.status}, messages: ${a.messageCount ?? 'unknown'})${a.cwd ? ` cwd: ${a.cwd}` : ''}${pending.length ? ` pending: ${pending.join(', ')}` : ''}`,
        )
      }
    } else {
      lines.push('No agent windows in this project.')
    }

    return lines.join('\n')
  },
})

server.addTool({
  name: 'list_all_cells_windows',
  description:
    'List terminal, browser, and agent windows across every Cells project. ' +
    'Use this when you need to inspect or control another Cells project/window, not just the project matching the current working directory.',
  parameters: z.object({}),
  execute: async () => {
    const result = await bridgeRequest('list-all-windows')
    return formatJson(result)
  },
})

// ==================== Terminal tools ====================

server.addTool({
  name: 'get_terminal_output',
  description:
    'Get recent output from a terminal window. Use list_windows first to find terminal IDs. ' +
    'Returns the buffered output (up to 256KB for active terminals). ' +
    'Useful for reading dev server logs, command output, build results, etc.',
  parameters: z.object({
    terminalId: z.string().describe('The terminal ID from list_windows'),
    lines: z
      .number()
      .optional()
      .describe('Limit output to the last N lines. Omit for all available output.'),
  }),
  execute: async ({ terminalId, lines }) => {
    const result = await bridgeRequest('get-terminal-output', {
      terminalId,
      lines,
    })
    if (!result.output) {
      return 'No output available for this terminal. It may be inactive or recently created.'
    }
    return result.output
  },
})

server.addTool({
  name: 'write_to_terminal',
  description:
    "Send input to a terminal window. The input is written to the terminal's stdin. " +
    'Use this to run commands, send keystrokes, or interact with running processes. ' +
    "Add \\n at the end to press Enter. Example: 'npm run dev\\n'",
  parameters: z.object({
    terminalId: z.string().describe('The terminal ID from list_windows'),
    input: z
      .string()
      .describe('The text to write to the terminal. Use \\n for Enter, \\x03 for Ctrl+C.'),
  }),
  execute: async ({ terminalId, input }) => {
    await bridgeRequest('write-terminal', { terminalId, data: input })
    return 'Input sent to terminal.'
  },
})

server.addTool({
  name: 'get_terminal_process',
  description:
    'Get information about the process currently running in a terminal. ' +
    'Returns the PID, command name, and whether the terminal is idle (at a shell prompt).',
  parameters: z.object({
    terminalId: z.string().describe('The terminal ID from list_windows'),
  }),
  execute: async ({ terminalId }) => {
    const info = await bridgeRequest('get-terminal-process', { terminalId })
    if (!info) {
      return 'No process info available. The terminal may not be running.'
    }
    return [
      `PID: ${info.pid}`,
      `Command: ${info.command}`,
      `Label: ${info.label}`,
      `Idle (at shell): ${info.isShell}`,
    ].join('\n')
  },
})

server.addTool({
  name: 'create_terminal',
  description:
    'Create a new headless terminal in the current project. ' +
    'The terminal runs in the PTY daemon and can be written to and read from via MCP. ' +
    'Returns the new terminal ID.',
  parameters: z.object({
    cwd: z
      .string()
      .optional()
      .describe('Working directory for the terminal. Defaults to the project root.'),
  }),
  execute: async ({ cwd }) => {
    const result = await bridgeRequest('create-terminal', { cwd })
    return `Terminal created with ID: ${result.terminalId}\n\nYou can now use write_to_terminal to run commands and get_terminal_output to read results.`
  },
})

server.addTool({
  name: 'close_terminal',
  description:
    'Close/kill a terminal and its running process. ' +
    'Only use this for terminals you created via create_terminal, ' +
    "or when you're sure you want to kill the process.",
  parameters: z.object({
    terminalId: z.string().describe('The terminal ID to close'),
  }),
  execute: async ({ terminalId }) => {
    await bridgeRequest('close-terminal', { terminalId })
    return 'Terminal closed.'
  },
})

server.addTool({
  name: 'await_terminal_idle',
  description:
    'Wait for a terminal to become idle (return to shell prompt). ' +
    "Polls the terminal's process info until it shows a shell process. " +
    'Useful after running a command to wait for it to complete. ' +
    'Returns the final terminal output.',
  parameters: z.object({
    terminalId: z.string().describe('The terminal ID to wait on'),
    timeout: z.number().optional().describe('Maximum time to wait in seconds. Default: 60'),
  }),
  execute: async ({ terminalId, timeout }) => {
    const maxWait = (timeout ?? 60) * 1000
    const start = Date.now()
    const pollInterval = 2000

    while (Date.now() - start < maxWait) {
      const info = await bridgeRequest('get-terminal-process', { terminalId })
      if (info?.isShell) {
        const result = await bridgeRequest('get-terminal-output', {
          terminalId,
          lines: 50,
        })
        return `Terminal is idle.\n\nLast 50 lines of output:\n${result.output || '(empty)'}`
      }
      await new Promise((r) => setTimeout(r, pollInterval))
    }

    const result = await bridgeRequest('get-terminal-output', {
      terminalId,
      lines: 50,
    })
    return `Timed out after ${timeout ?? 60}s. Terminal is still busy.\n\nLast 50 lines of output:\n${result.output || '(empty)'}`
  },
})

// ==================== Browser tools ====================

server.addTool({
  name: 'navigate_browser',
  description:
    'Navigate a browser window to a URL. Accepts full URLs or search queries. ' +
    'Use list_windows first to find browser IDs.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID from list_windows'),
    url: z.string().describe('URL to navigate to, or a search query'),
  }),
  execute: async ({ browserId, url }) => {
    await bridgeRequest('navigate-browser', { browserId, url })
    return `Navigating to: ${url}`
  },
})

server.addTool({
  name: 'browser_go_back',
  description: 'Navigate the browser back to the previous page.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
  }),
  execute: async ({ browserId }) => {
    await bridgeRequest('browser-go-back', { browserId })
    return 'Navigated back.'
  },
})

server.addTool({
  name: 'browser_go_forward',
  description: 'Navigate the browser forward to the next page.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
  }),
  execute: async ({ browserId }) => {
    await bridgeRequest('browser-go-forward', { browserId })
    return 'Navigated forward.'
  },
})

server.addTool({
  name: 'browser_reload',
  description: 'Reload the current page in a browser window.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
  }),
  execute: async ({ browserId }) => {
    await bridgeRequest('browser-reload', { browserId })
    return 'Page reloaded.'
  },
})

server.addTool({
  name: 'get_browser_url',
  description: 'Get the current URL and title of a browser window.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
  }),
  execute: async ({ browserId }) => {
    const result = await bridgeRequest('browser-get-url', { browserId })
    return `URL: ${result.url}\nTitle: ${result.title}`
  },
})

server.addTool({
  name: 'get_browser_console_logs',
  description:
    'Get console logs (log, warn, error, info) from a browser window. ' +
    'Captures up to 1000 recent log entries. ' +
    'Useful for debugging web applications.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
  }),
  execute: async ({ browserId }) => {
    const result = await bridgeRequest('get-console-logs', { browserId })
    if (!result.logs || result.logs.length === 0) {
      return 'No console logs captured for this browser.'
    }
    return result.logs
      .map(
        (log: any) =>
          `[${log.level}] ${log.message}${log.source ? ` (${log.source}:${log.line})` : ''}`,
      )
      .join('\n')
  },
})

server.addTool({
  name: 'execute_browser_js',
  description:
    "Execute JavaScript code in a browser window's page context. " +
    'Returns the stringified result. Use for DOM inspection, data extraction, ' +
    "or interacting with web applications. The code runs in the page's global scope.",
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    code: z.string().describe('JavaScript code to execute. The return value will be stringified.'),
  }),
  execute: async ({ browserId, code }) => {
    const result = await bridgeRequest('execute-js', { browserId, code })
    if (result.error) {
      return `Error: ${result.error}`
    }
    return `Result: ${result.result}`
  },
})

server.addTool({
  name: 'browser_screenshot',
  description:
    'Take a screenshot of a browser window. Returns the image as a base64-encoded PNG. ' +
    'Use this to visually inspect the state of a web page.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
  }),
  execute: async ({ browserId }) => {
    const result = await bridgeRequest('browser-screenshot', { browserId })
    return {
      type: 'image' as const,
      data: result.data,
      mimeType: 'image/png' as const,
    }
  },
})

server.addTool({
  name: 'get_browser_html',
  description:
    "Get the HTML content of a browser window's current page. " +
    'Returns the full document HTML or just the body text.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    textOnly: z
      .boolean()
      .optional()
      .describe('If true, returns only the visible text content (no HTML tags). Default: false'),
  }),
  execute: async ({ browserId, textOnly }) => {
    const code = textOnly ? 'document.body.innerText' : 'document.documentElement.outerHTML'
    const result = await bridgeRequest('execute-js', { browserId, code })
    if (result.error) {
      return `Error getting page content: ${result.error}`
    }
    return result.result
  },
})

server.addTool({
  name: 'browser_snapshot',
  description:
    'Get a Playwright/Chrome-DevTools-style page snapshot: URL, title, viewport, visible interactive elements with CSS selectors/bounds, and visible page text. ' +
    'Use this before clicking, filling, or extracting structured page state.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    maxElements: z
      .number()
      .optional()
      .describe('Maximum visible interactive elements to return. Default: 200, max: 500.'),
  }),
  execute: async ({ browserId, maxElements }) => {
    const result = await bridgeRequest('browser-snapshot', { browserId, maxElements })
    return formatJson(result)
  },
})

server.addTool({
  name: 'browser_click',
  description:
    'Click a browser page element by CSS selector, visible text, or viewport coordinates. Prefer selectors from browser_snapshot.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    selector: z.string().optional().describe('CSS selector to click'),
    text: z.string().optional().describe('Visible text to search for and click'),
    x: z.number().optional().describe('Viewport x coordinate'),
    y: z.number().optional().describe('Viewport y coordinate'),
  }),
  execute: async ({ browserId, selector, text, x, y }) => {
    await bridgeRequest('browser-click', { browserId, selector, text, x, y })
    return 'Clicked.'
  },
})

server.addTool({
  name: 'browser_hover',
  description: 'Move the mouse over a page element by CSS selector or viewport coordinates.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    selector: z.string().optional().describe('CSS selector to hover'),
    x: z.number().optional().describe('Viewport x coordinate'),
    y: z.number().optional().describe('Viewport y coordinate'),
  }),
  execute: async ({ browserId, selector, x, y }) => {
    await bridgeRequest('browser-hover', { browserId, selector, x, y })
    return 'Hovered.'
  },
})

server.addTool({
  name: 'browser_fill',
  description:
    'Set the value of an input, textarea, or compatible editable control and dispatch input/change events.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    selector: z.string().describe('CSS selector for the editable element'),
    value: z.string().describe('Value to set'),
  }),
  execute: async ({ browserId, selector, value }) => {
    await bridgeRequest('browser-fill', { browserId, selector, value })
    return 'Filled.'
  },
})

server.addTool({
  name: 'browser_type',
  description:
    'Type text into the focused element, or focus a selector first and then insert text.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    text: z.string().describe('Text to type'),
    selector: z.string().optional().describe('Optional CSS selector to focus before typing'),
  }),
  execute: async ({ browserId, text, selector }) => {
    await bridgeRequest('browser-type', { browserId, text, selector })
    return 'Typed.'
  },
})

server.addTool({
  name: 'browser_press_key',
  description:
    'Press a keyboard key in the browser page, for example Enter, Tab, Escape, ArrowDown, or a single letter.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    key: z.string().describe('Electron keyCode to press, such as Enter, Tab, Escape, ArrowDown'),
  }),
  execute: async ({ browserId, key }) => {
    await bridgeRequest('browser-press-key', { browserId, key })
    return `Pressed ${key}.`
  },
})

server.addTool({
  name: 'browser_select',
  description: 'Select an option value in a <select> element and dispatch input/change events.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    selector: z.string().describe('CSS selector for the select element'),
    value: z.string().describe('Option value to select'),
  }),
  execute: async ({ browserId, selector, value }) => {
    await bridgeRequest('browser-select', { browserId, selector, value })
    return 'Selected.'
  },
})

server.addTool({
  name: 'browser_wait_for',
  description:
    'Wait for a browser page to finish loading, for a selector to appear, or for visible text to appear.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    loadState: z.literal('loaded').optional().describe('Wait for the current main frame load'),
    selector: z.string().optional().describe('CSS selector to wait for'),
    text: z.string().optional().describe('Visible text to wait for'),
    timeoutMs: z
      .number()
      .optional()
      .describe('Timeout in milliseconds. Default: 10000, max: 60000.'),
  }),
  execute: async ({ browserId, loadState, selector, text, timeoutMs }) => {
    const result = await bridgeRequest('browser-wait-for', {
      browserId,
      loadState,
      selector,
      text,
      timeoutMs,
    })
    return result.matched ? 'Matched.' : 'Timed out waiting for target.'
  },
})

server.addTool({
  name: 'get_browser_network_requests',
  description:
    'List recent network requests captured for a Cells browser window. Useful for DevTools-style debugging alongside console logs.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
    limit: z.number().optional().describe('Number of recent requests to return. Default: 100.'),
  }),
  execute: async ({ browserId, limit }) => {
    const result = await bridgeRequest('get-network-requests', { browserId, limit })
    return formatJson(result.requests ?? [])
  },
})

server.addTool({
  name: 'clear_browser_network_requests',
  description: 'Clear the captured network request buffer for a browser window.',
  parameters: z.object({
    browserId: z.string().describe('The browser ID'),
  }),
  execute: async ({ browserId }) => {
    await bridgeRequest('clear-network-requests', { browserId })
    return 'Network request buffer cleared.'
  },
})

// ==================== Cells window / agent session tools ====================

server.addTool({
  name: 'focus_cells_window',
  description:
    'Bring a Cells window to the front. Supports browser and agent windows directly; terminals bring the main Cells window forward.',
  parameters: z.object({
    windowId: z.string().describe('Window ID from list_windows or list_all_cells_windows'),
    type: z.enum(['terminal', 'browser', 'agent']).describe('Window type'),
  }),
  execute: async ({ windowId, type }) => {
    const result = await bridgeRequest('focus-window', { windowId, type })
    return `Focused ${type} ${windowId}${result.projectId ? ` in project ${result.projectId}` : ''}.`
  },
})

server.addTool({
  name: 'get_agent_session',
  description:
    'Read the full live or persisted Cells agent session snapshot for an agent window, including chat messages, pending approvals/questions, and usage.',
  parameters: z.object({
    windowId: z.string().describe('Agent window ID from list_windows'),
  }),
  execute: async ({ windowId }) => {
    const result = await bridgeRequest('get-agent-session', { windowId })
    return formatJson(result)
  },
})

server.addTool({
  name: 'get_agent_messages',
  description:
    "Read recent chat content from another Cells agent window. Use this for cross-agent coordination and reviewing another agent's transcript.",
  parameters: z.object({
    windowId: z.string().describe('Agent window ID from list_windows'),
    limit: z
      .number()
      .optional()
      .describe('Number of recent messages to return. Default: all, max: 200.'),
    lines: z.number().optional().describe('Optional per-message text limit in lines.'),
  }),
  execute: async ({ windowId, limit, lines }) => {
    const result = await bridgeRequest('get-agent-messages', { windowId, limit, lines })
    return `Agent: ${result.title} (${result.agent}, ${result.status})\n\n${formatAgentMessages(result.messages ?? [])}`
  },
})

server.addTool({
  name: 'send_agent_message',
  description:
    'Send a message into another Cells agent window. Use when coordinating agents or asking another live session to continue work.',
  parameters: z.object({
    windowId: z.string().describe('Agent window ID from list_windows'),
    input: z.string().describe('Message text to send'),
    attachments: z.array(z.string()).optional().describe('Optional absolute file paths to attach'),
  }),
  execute: async ({ windowId, input, attachments }) => {
    await bridgeRequest('send-agent-message', { windowId, input, attachments })
    return 'Agent message sent.'
  },
})

// ==================== Notifications ====================

server.addTool({
  name: 'notify',
  description:
    'Send an arbitrary desktop notification to the user. ' +
    'Use this to alert the user about completed tasks, errors, or anything that needs their attention.',
  parameters: z.object({
    title: z.string().optional().describe("Notification title. Defaults to 'Cells'."),
    body: z.string().describe('The notification body text.'),
  }),
  execute: async ({ title, body }) => {
    await bridgeRequest('notify', { title, body })
    return 'Notification sent.'
  },
})

// ==================== Start server ====================

server.start({
  transportType: 'stdio',
})
