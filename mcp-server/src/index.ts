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

import { FastMCP } from "fastmcp";
import { z } from "zod";
import os from "os";
import path from "path";
import fs from "fs";
import { BridgeClient } from "./bridge-client.js";

// ---------- Configuration ----------

const STATE_DIR =
  process.env.CELLS_HOME_DIR || path.join(os.homedir(), ".cells");
const BRIDGE_SOCKET =
  process.env.CELLS_MCP_SOCKET || path.join(STATE_DIR, "mcp-bridge.sock");
const STATE_FILE = path.join(STATE_DIR, "state.json");

// ---------- Project resolution ----------

function resolveProjectPath(): string {
  return process.env.CELLS_PROJECT_PATH || process.cwd();
}

function resolveProjectFromState(): {
  id: string;
  name: string;
  path: string;
} | null {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    const cwd = resolveProjectPath();
    let best: any = null;
    let bestLen = 0;
    for (const project of state.projects ?? []) {
      if (cwd.startsWith(project.path) && project.path.length > bestLen) {
        best = project;
        bestLen = project.path.length;
      }
    }
    return best ? { id: best.id, name: best.name, path: best.path } : null;
  } catch {
    return null;
  }
}

// ---------- Bridge connection ----------

let bridge: BridgeClient | null = null;

async function getBridge(): Promise<BridgeClient> {
  if (bridge?.isConnected()) return bridge;
  bridge = new BridgeClient();
  await bridge.connect(BRIDGE_SOCKET);
  return bridge;
}

async function bridgeRequest(method: string, params: object = {}): Promise<any> {
  const b = await getBridge();
  return b.request(method, {
    projectPath: resolveProjectPath(),
    ...params,
  });
}

// ---------- Server ----------

const server = new FastMCP({
  name: "Cells",
  version: "0.1.0",
  instructions:
    "Cells is an Electron-based development environment that combines terminal emulators (powered by Ghostty) " +
    "and browser windows into a single, tiled workspace per project. " +
    "This MCP server lets you observe and interact with the user's running terminals and browsers inside Cells. " +
    "You can read terminal output, run commands, inspect browser pages, take screenshots, and execute JavaScript — " +
    "all scoped to the current project. Start with list_windows to see what's open.",
});

// ==================== Window listing ====================

server.addTool({
  name: "list_windows",
  description:
    "List all terminal and browser windows in the current Cells project. " +
    "Returns terminal IDs with their running process info, and browser IDs with their current URLs. " +
    "Use the returned IDs with other tools to interact with specific windows.",
  parameters: z.object({}),
  execute: async () => {
    const project = resolveProjectFromState();
    if (!project) {
      return "No Cells project found for the current directory. Make sure Cells is running and this directory is part of a project.";
    }

    const result = await bridgeRequest("list-windows");
    const lines: string[] = [`Project: ${project.name} (${project.path})\n`];

    if (result.terminals.length > 0) {
      lines.push("## Terminals\n");
      for (const t of result.terminals) {
        const proc = t.processInfo
          ? ` [${t.processInfo.label}${t.processInfo.isShell ? " (idle)" : ""}]`
          : " [no process info]";
        const agent = t.agent ? ` (agent: ${t.agent}, status: ${t.agentStatus})` : "";
        lines.push(`- **${t.title}** (id: \`${t.id}\`)${proc}${agent}`);
      }
    } else {
      lines.push("No terminals in this project.");
    }

    lines.push("");

    if (result.browsers.length > 0) {
      lines.push("## Browsers\n");
      for (const b of result.browsers) {
        lines.push(`- **${b.title}** (id: \`${b.id}\`): ${b.url}`);
      }
    } else {
      lines.push("No browsers in this project.");
    }

    return lines.join("\n");
  },
});

// ==================== Terminal tools ====================

server.addTool({
  name: "get_terminal_output",
  description:
    "Get recent output from a terminal window. Use list_windows first to find terminal IDs. " +
    "Returns the buffered output (up to 256KB for active terminals). " +
    "Useful for reading dev server logs, command output, build results, etc.",
  parameters: z.object({
    terminalId: z.string().describe("The terminal ID from list_windows"),
    lines: z
      .number()
      .optional()
      .describe("Limit output to the last N lines. Omit for all available output."),
  }),
  execute: async ({ terminalId, lines }) => {
    const result = await bridgeRequest("get-terminal-output", {
      terminalId,
      lines,
    });
    if (!result.output) {
      return "No output available for this terminal. It may be inactive or recently created.";
    }
    return result.output;
  },
});

server.addTool({
  name: "write_to_terminal",
  description:
    "Send input to a terminal window. The input is written to the terminal's stdin. " +
    "Use this to run commands, send keystrokes, or interact with running processes. " +
    "Add \\n at the end to press Enter. Example: 'npm run dev\\n'",
  parameters: z.object({
    terminalId: z.string().describe("The terminal ID from list_windows"),
    input: z
      .string()
      .describe(
        "The text to write to the terminal. Use \\n for Enter, \\x03 for Ctrl+C."
      ),
  }),
  execute: async ({ terminalId, input }) => {
    await bridgeRequest("write-terminal", { terminalId, data: input });
    return "Input sent to terminal.";
  },
});

server.addTool({
  name: "get_terminal_process",
  description:
    "Get information about the process currently running in a terminal. " +
    "Returns the PID, command name, and whether the terminal is idle (at a shell prompt).",
  parameters: z.object({
    terminalId: z.string().describe("The terminal ID from list_windows"),
  }),
  execute: async ({ terminalId }) => {
    const info = await bridgeRequest("get-terminal-process", { terminalId });
    if (!info) {
      return "No process info available. The terminal may not be running.";
    }
    return [
      `PID: ${info.pid}`,
      `Command: ${info.command}`,
      `Label: ${info.label}`,
      `Idle (at shell): ${info.isShell}`,
    ].join("\n");
  },
});

server.addTool({
  name: "create_terminal",
  description:
    "Create a new headless terminal in the current project. " +
    "The terminal runs in the PTY daemon and can be written to and read from via MCP. " +
    "Returns the new terminal ID.",
  parameters: z.object({
    cwd: z
      .string()
      .optional()
      .describe(
        "Working directory for the terminal. Defaults to the project root."
      ),
  }),
  execute: async ({ cwd }) => {
    const result = await bridgeRequest("create-terminal", { cwd });
    return `Terminal created with ID: ${result.terminalId}\n\nYou can now use write_to_terminal to run commands and get_terminal_output to read results.`;
  },
});

server.addTool({
  name: "close_terminal",
  description:
    "Close/kill a terminal and its running process. " +
    "Only use this for terminals you created via create_terminal, " +
    "or when you're sure you want to kill the process.",
  parameters: z.object({
    terminalId: z.string().describe("The terminal ID to close"),
  }),
  execute: async ({ terminalId }) => {
    await bridgeRequest("close-terminal", { terminalId });
    return "Terminal closed.";
  },
});

server.addTool({
  name: "await_terminal_idle",
  description:
    "Wait for a terminal to become idle (return to shell prompt). " +
    "Polls the terminal's process info until it shows a shell process. " +
    "Useful after running a command to wait for it to complete. " +
    "Returns the final terminal output.",
  parameters: z.object({
    terminalId: z.string().describe("The terminal ID to wait on"),
    timeout: z
      .number()
      .optional()
      .describe("Maximum time to wait in seconds. Default: 60"),
  }),
  execute: async ({ terminalId, timeout }) => {
    const maxWait = (timeout ?? 60) * 1000;
    const start = Date.now();
    const pollInterval = 2000;

    while (Date.now() - start < maxWait) {
      const info = await bridgeRequest("get-terminal-process", { terminalId });
      if (info?.isShell) {
        const result = await bridgeRequest("get-terminal-output", {
          terminalId,
          lines: 50,
        });
        return `Terminal is idle.\n\nLast 50 lines of output:\n${result.output || "(empty)"}`;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    const result = await bridgeRequest("get-terminal-output", {
      terminalId,
      lines: 50,
    });
    return `Timed out after ${timeout ?? 60}s. Terminal is still busy.\n\nLast 50 lines of output:\n${result.output || "(empty)"}`;
  },
});

// ==================== Browser tools ====================

server.addTool({
  name: "navigate_browser",
  description:
    "Navigate a browser window to a URL. Accepts full URLs or search queries. " +
    "Use list_windows first to find browser IDs.",
  parameters: z.object({
    browserId: z.string().describe("The browser ID from list_windows"),
    url: z.string().describe("URL to navigate to, or a search query"),
  }),
  execute: async ({ browserId, url }) => {
    await bridgeRequest("navigate-browser", { browserId, url });
    return `Navigating to: ${url}`;
  },
});

server.addTool({
  name: "browser_go_back",
  description: "Navigate the browser back to the previous page.",
  parameters: z.object({
    browserId: z.string().describe("The browser ID"),
  }),
  execute: async ({ browserId }) => {
    await bridgeRequest("browser-go-back", { browserId });
    return "Navigated back.";
  },
});

server.addTool({
  name: "browser_go_forward",
  description: "Navigate the browser forward to the next page.",
  parameters: z.object({
    browserId: z.string().describe("The browser ID"),
  }),
  execute: async ({ browserId }) => {
    await bridgeRequest("browser-go-forward", { browserId });
    return "Navigated forward.";
  },
});

server.addTool({
  name: "browser_reload",
  description: "Reload the current page in a browser window.",
  parameters: z.object({
    browserId: z.string().describe("The browser ID"),
  }),
  execute: async ({ browserId }) => {
    await bridgeRequest("browser-reload", { browserId });
    return "Page reloaded.";
  },
});

server.addTool({
  name: "get_browser_url",
  description: "Get the current URL and title of a browser window.",
  parameters: z.object({
    browserId: z.string().describe("The browser ID"),
  }),
  execute: async ({ browserId }) => {
    const result = await bridgeRequest("browser-get-url", { browserId });
    return `URL: ${result.url}\nTitle: ${result.title}`;
  },
});

server.addTool({
  name: "get_browser_console_logs",
  description:
    "Get console logs (log, warn, error, info) from a browser window. " +
    "Captures up to 1000 recent log entries. " +
    "Useful for debugging web applications.",
  parameters: z.object({
    browserId: z.string().describe("The browser ID"),
  }),
  execute: async ({ browserId }) => {
    const result = await bridgeRequest("get-console-logs", { browserId });
    if (!result.logs || result.logs.length === 0) {
      return "No console logs captured for this browser.";
    }
    return result.logs
      .map(
        (log: any) =>
          `[${log.level}] ${log.message}${log.source ? ` (${log.source}:${log.line})` : ""}`
      )
      .join("\n");
  },
});

server.addTool({
  name: "execute_browser_js",
  description:
    "Execute JavaScript code in a browser window's page context. " +
    "Returns the stringified result. Use for DOM inspection, data extraction, " +
    "or interacting with web applications. The code runs in the page's global scope.",
  parameters: z.object({
    browserId: z.string().describe("The browser ID"),
    code: z
      .string()
      .describe(
        "JavaScript code to execute. The return value will be stringified."
      ),
  }),
  execute: async ({ browserId, code }) => {
    const result = await bridgeRequest("execute-js", { browserId, code });
    if (result.error) {
      return `Error: ${result.error}`;
    }
    return `Result: ${result.result}`;
  },
});

server.addTool({
  name: "browser_screenshot",
  description:
    "Take a screenshot of a browser window. Returns the image as a base64-encoded PNG. " +
    "Use this to visually inspect the state of a web page.",
  parameters: z.object({
    browserId: z.string().describe("The browser ID"),
  }),
  execute: async ({ browserId }) => {
    const result = await bridgeRequest("browser-screenshot", { browserId });
    return {
      type: "image" as const,
      data: result.data,
      mimeType: "image/png" as const,
    };
  },
});

server.addTool({
  name: "get_browser_html",
  description:
    "Get the HTML content of a browser window's current page. " +
    "Returns the full document HTML or just the body text.",
  parameters: z.object({
    browserId: z.string().describe("The browser ID"),
    textOnly: z
      .boolean()
      .optional()
      .describe("If true, returns only the visible text content (no HTML tags). Default: false"),
  }),
  execute: async ({ browserId, textOnly }) => {
    const code = textOnly
      ? "document.body.innerText"
      : "document.documentElement.outerHTML";
    const result = await bridgeRequest("execute-js", { browserId, code });
    if (result.error) {
      return `Error getting page content: ${result.error}`;
    }
    return result.result;
  },
});

// ==================== Start server ====================

server.start({
  transportType: "stdio",
});
