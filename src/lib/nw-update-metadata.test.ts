import assert from 'node:assert/strict'
import test from 'node:test'

import { getNwUpdateMetadataBaseUrl, parseNwUpdateMetadata } from './nw-update-metadata.ts'

const metadata = [
  'version: 0.1.212',
  'files:',
  '  - url: Cells-0.1.212-mac-arm64.zip',
  '    sha512: abc123',
  '    size: 42',
  'path: Cells-0.1.212-mac-arm64.zip',
  'sha512: abc123',
  "releaseDate: '2026-05-28T22:00:00.000Z'",
  '',
].join('\n')

test('parseNwUpdateMetadata resolves relative GitHub assets from the stable feed URL', () => {
  const parsed = parseNwUpdateMetadata(
    metadata,
    'https://github.com/xrehpicx/cells/releases/latest/download/latest-mac.yml',
  )

  assert.equal(
    parsed.assetUrl,
    'https://github.com/xrehpicx/cells/releases/latest/download/Cells-0.1.212-mac-arm64.zip',
  )
  assert.equal(parsed.assetName, 'Cells-0.1.212-mac-arm64.zip')
  assert.equal(parsed.size, 42)
})

test('getNwUpdateMetadataBaseUrl ignores GitHub signed release asset URLs', () => {
  const requestUrl = 'https://github.com/xrehpicx/cells/releases/latest/download/latest-mac.yml'
  const signedUrl =
    'https://release-assets.githubusercontent.com/github-production-release-asset/1191511447/metadata?jwt=expired'

  assert.equal(getNwUpdateMetadataBaseUrl(requestUrl, signedUrl), requestUrl)
})

test('parseNwUpdateMetadata accepts absolute artifact URLs for old updater compatibility', () => {
  const parsed = parseNwUpdateMetadata(
    metadata.replaceAll(
      'Cells-0.1.212-mac-arm64.zip',
      'https://github.com/xrehpicx/cells/releases/download/v0.1.212/Cells-0.1.212-mac-arm64.zip',
    ),
    'https://release-assets.githubusercontent.com/github-production-release-asset/1191511447/metadata?jwt=expired',
  )

  assert.equal(
    parsed.assetUrl,
    'https://github.com/xrehpicx/cells/releases/download/v0.1.212/Cells-0.1.212-mac-arm64.zip',
  )
  assert.equal(parsed.assetName, 'Cells-0.1.212-mac-arm64.zip')
})
