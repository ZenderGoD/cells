// Helpers for turning terminal text into clickable file/path links. Extracted
// from cell-terminal.tsx so the matching logic can be unit tested without
// importing the whole xterm stack.

// Recognize an absolute path, optionally preceded by `file://`, optionally
// followed by `:line` or `:line:col`. Must follow the start of the string or a
// whitespace/delimiter character so we don't match mid-word substrings.
export const LOCAL_PATH_RE =
  /(?:^|(?<=[\s([<'"`]))(?:file:\/\/)?(?:~|\/)[^\s:"'`<>()[\]]*(?::\d+(?::\d+)?)?/g

// Filter applied to every regex match before we treat it as a link. Only
// paths that look file-like (have an extension, a `:line` suffix, or end in a
// slash) are clickable — everything else is too likely to be a false positive
// on a URL fragment, a comment, or a slash-prefixed token.
export function looksLikeOpenablePath(raw: string): boolean {
  if (raw.length < 3) return false
  if (raw.startsWith('//')) return false
  return /\.[A-Za-z0-9]{1,8}$|:\d+(?::\d+)?$|\/$/.test(raw)
}

// Given a URL or text the user clicked on (either an OSC 8 hyperlink target
// or a regex-matched path), return a bare filesystem path we can stat — or
// null if the input isn't a local path at all.
export function extractLocalPathCandidate(url: string): string | null {
  if (!url) return null
  const trimmed = url.trim().replace(/^['"`<]|['"`>]$/g, '')
  if (!trimmed) return null

  if (/^file:\/\//i.test(trimmed)) {
    const withoutScheme = trimmed.replace(/^file:\/\//i, '')
    try {
      return decodeURIComponent(withoutScheme)
    } catch {
      return withoutScheme
    }
  }

  // Anything with a recognized URL scheme is handled by the URL router.
  if (/^(?:https?|mailto|ftp|ssh|git|tel|magnet|gemini|gopher|news):/i.test(trimmed)) {
    return null
  }
  if (!/^(?:~|\/)/.test(trimmed)) return null

  // Strip trailing :line or :line:col — callers open the base path only.
  return trimmed.replace(/:(\d+)(?::\d+)?$/, '')
}
