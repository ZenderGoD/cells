import test from 'node:test'
import assert from 'node:assert/strict'

const { LOCAL_PATH_RE, looksLikeOpenablePath, extractLocalPathCandidate } = await import(
  new URL('./terminal-links.ts', import.meta.url).href
)

function findAll(text: string): string[] {
  const out: string[] = []
  const re = new RegExp(LOCAL_PATH_RE.source, LOCAL_PATH_RE.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[0])
  return out
}

test('extractLocalPathCandidate unwraps file:// URLs', () => {
  assert.equal(extractLocalPathCandidate('file:///Users/raj/foo.ts'), '/Users/raj/foo.ts')
  assert.equal(extractLocalPathCandidate('file:///Users/raj/my%20file.ts'), '/Users/raj/my file.ts')
})

test('extractLocalPathCandidate accepts plain absolute and home-relative paths', () => {
  assert.equal(extractLocalPathCandidate('/Users/raj/foo.ts'), '/Users/raj/foo.ts')
  assert.equal(extractLocalPathCandidate('~/notes.md'), '~/notes.md')
})

test('extractLocalPathCandidate strips :line and :line:col suffixes', () => {
  assert.equal(extractLocalPathCandidate('/Users/raj/foo.ts:42'), '/Users/raj/foo.ts')
  assert.equal(extractLocalPathCandidate('/Users/raj/foo.ts:42:3'), '/Users/raj/foo.ts')
})

test('extractLocalPathCandidate rejects URLs and non-absolute text', () => {
  assert.equal(extractLocalPathCandidate('https://example.com/foo'), null)
  assert.equal(extractLocalPathCandidate('mailto:foo@example.com'), null)
  assert.equal(extractLocalPathCandidate('ssh://host/path'), null)
  assert.equal(extractLocalPathCandidate('README.md'), null)
  assert.equal(extractLocalPathCandidate(''), null)
})

test('looksLikeOpenablePath requires a file-like shape', () => {
  assert.equal(looksLikeOpenablePath('/Users/raj/foo.ts'), true)
  assert.equal(looksLikeOpenablePath('/Users/raj/foo.ts:42'), true)
  assert.equal(looksLikeOpenablePath('/Users/raj/foo.ts:42:3'), true)
  assert.equal(looksLikeOpenablePath('/tmp/'), true)
  assert.equal(looksLikeOpenablePath('/etc/passwd'), false) // no extension, no slash, no :line
  assert.equal(looksLikeOpenablePath('/'), false)
  assert.equal(looksLikeOpenablePath('//example.com/path'), false)
})

test('LOCAL_PATH_RE finds paths in surrounding prose', () => {
  const matches = findAll('see /Users/raj/foo.ts:42 and ~/notes.md for details')
  assert.deepEqual(matches, ['/Users/raj/foo.ts:42', '~/notes.md'])
})

test('LOCAL_PATH_RE does not match mid-word slashes', () => {
  const matches = findAll('a/b/c/foo.ts and x/y/bar.ts')
  assert.deepEqual(matches, [])
})

test('LOCAL_PATH_RE stops at closing delimiters', () => {
  const matches = findAll('(/Users/raj/foo.ts) and [/tmp/]')
  assert.deepEqual(matches, ['/Users/raj/foo.ts', '/tmp/'])
})
