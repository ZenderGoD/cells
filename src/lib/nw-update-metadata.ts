export type NwUpdateMetadata = {
  version: string
  assetUrl: string
  assetName: string
  sha512: string
  size: number | null
  releaseDate: string | null
}

function cleanNwYamlScalar(value: string) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function getNwUpdateAssetName(assetPath: string) {
  try {
    const url = new URL(assetPath)
    const name = url.pathname.split('/').filter(Boolean).pop()
    return name ? decodeURIComponent(name) : assetPath
  } catch {}

  return assetPath.split(/[\\/]/).filter(Boolean).pop() || assetPath
}

export function getNwUpdateMetadataBaseUrl(requestUrl: string, finalUrl: string) {
  try {
    const final = new URL(finalUrl)
    if (
      final.hostname === 'release-assets.githubusercontent.com' ||
      final.searchParams.has('jwt')
    ) {
      return requestUrl
    }
  } catch {}

  return finalUrl || requestUrl
}

export function parseNwUpdateMetadata(text: string, metadataUrl: string): NwUpdateMetadata {
  const scalar = (key: string) => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return match ? cleanNwYamlScalar(match[1]) : null
  }
  const version = scalar('version')
  const assetPath = scalar('path') ?? text.match(/^\s+-\s+url:\s*(.+)$/m)?.[1]
  const sha512 = scalar('sha512')
  if (!version || !assetPath || !sha512) {
    throw new Error('Update metadata is missing version, path, or sha512.')
  }
  const cleanAssetPath = cleanNwYamlScalar(assetPath)
  const sizeText = scalar('size') ?? text.match(/^\s+size:\s*(\d+)$/m)?.[1] ?? null
  const size = sizeText ? Number.parseInt(sizeText, 10) : null
  return {
    version,
    assetUrl: new URL(cleanAssetPath, metadataUrl).toString(),
    assetName: getNwUpdateAssetName(cleanAssetPath),
    sha512,
    size: Number.isFinite(size) ? size : null,
    releaseDate: scalar('releaseDate'),
  }
}
