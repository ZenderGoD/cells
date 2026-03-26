import { app } from 'electron'
import path from 'path'

export const STATE_DIR = path.join(app.getPath('home'), '.cells')
export const EXTENSIONS_DIR = path.join(STATE_DIR, 'extensions')
export const EXTENSIONS_META_FILE = path.join(STATE_DIR, 'extensions.json')
