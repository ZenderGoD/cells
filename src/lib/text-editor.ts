const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'shell',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  env: 'shell',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sass: 'scss',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'plaintext',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
}

const LANGUAGE_BY_FILE_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'package.json': 'json',
  'tsconfig.json': 'json',
  '.gitignore': 'ignore',
  '.env': 'shell',
  '.env.local': 'shell',
  '.env.development': 'shell',
  '.env.production': 'shell',
}

export function getFileNameFromPath(filePath: string | null | undefined) {
  if (!filePath) return ''
  const normalized = filePath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? filePath
}

export function getTextEditorTitle(filePath: string | null | undefined, fallback = 'Untitled') {
  return getFileNameFromPath(filePath) || fallback
}

export function inferEditorLanguage(filePath: string | null | undefined, title?: string | null) {
  const fileName = getFileNameFromPath(filePath) || title || ''
  const lowerName = fileName.toLowerCase()
  if (LANGUAGE_BY_FILE_NAME[lowerName]) return LANGUAGE_BY_FILE_NAME[lowerName]

  const extension = lowerName.includes('.') ? lowerName.split('.').pop() : ''
  if (!extension) return 'plaintext'
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext'
}
