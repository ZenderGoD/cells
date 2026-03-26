export const GIT_GRAPH_LABEL = 'Git Graph'

export function buildLazygitCommand() {
  return [
    'if command -v lazygit >/dev/null 2>&1; then',
    '  lazygit;',
    'else',
    "  printf '\\nlazygit is not installed. Install it first, then reopen this terminal.\\n\\n';",
    'fi',
  ].join(' ')
}
