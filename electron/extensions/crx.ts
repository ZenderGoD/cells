/**
 * CRX download and extraction.
 *
 * Downloads Chrome extensions from Google's update2 CRX endpoint (the same
 * URL pattern used by Brave, Vivaldi, and other Chromium-based browsers)
 * and extracts them to an unpacked directory that Electron can load.
 *
 * CRX format: magic bytes "Cr24" + version header + ZIP payload.
 * We strip the header and extract the ZIP contents.
 */

import { app, net } from 'electron'
import path from 'path'
import fs from 'fs'
import AdmZip from 'adm-zip'

const CHROME_VERSION = '120.0.0.0'
const CWS_UPDATE_URL = 'https://clients2.google.com/service/update2/crx'

export function getCrxDownloadUrl(extensionId: string): string {
  const x = `id=${extensionId}&uc`
  return `${CWS_UPDATE_URL}?response=redirect&prodversion=${CHROME_VERSION}&acceptformat=crx2,crx3&x=${encodeURIComponent(x)}`
}

/** Accept a Chrome Web Store URL or a raw 32-char extension ID. */
export function parseExtensionInput(input: string): string | null {
  const cwsMatch = input.match(/chromewebstore\.google\.com\/detail\/[^/]*\/([a-z]{32})/)
  if (cwsMatch) return cwsMatch[1]

  const raw = input.trim().toLowerCase()
  if (/^[a-z]{32}$/.test(raw)) return raw

  return null
}

export async function downloadCrx(extensionId: string): Promise<string> {
  const tempDir = path.join(app.getPath('temp'), 'cells-ext-dl')
  fs.mkdirSync(tempDir, { recursive: true })

  const url = getCrxDownloadUrl(extensionId)
  const crxPath = path.join(tempDir, `${extensionId}.crx`)

  const response = await net.fetch(url)
  if (!response.ok) {
    throw new Error(`CRX download failed: HTTP ${response.status}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  fs.writeFileSync(crxPath, buffer)
  return crxPath
}

export function extractCrx(crxPath: string, destDir: string): void {
  const buffer = fs.readFileSync(crxPath)

  const magic = buffer.toString('ascii', 0, 4)
  if (magic !== 'Cr24') throw new Error('Invalid CRX file: bad magic bytes')

  const version = buffer.readUInt32LE(4)
  let zipOffset: number

  if (version === 3) {
    const headerLength = buffer.readUInt32LE(8)
    zipOffset = 12 + headerLength
  } else if (version === 2) {
    const pubkeyLen = buffer.readUInt32LE(8)
    const sigLen = buffer.readUInt32LE(12)
    zipOffset = 16 + pubkeyLen + sigLen
  } else {
    throw new Error(`Unsupported CRX version: ${version}`)
  }

  const zipBuffer = buffer.subarray(zipOffset)
  const zip = new AdmZip(zipBuffer)
  zip.extractAllTo(destDir, true)
}
