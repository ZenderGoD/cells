import { MAX_REPLAY_HISTORY_BYTES } from './pty-shared'

export class TerminalHistoryBuffer {
  private chunks: string[] = []
  private length = 0

  append(data: string) {
    if (!data) return

    this.chunks.push(data)
    this.length += data.length

    while (this.length > MAX_REPLAY_HISTORY_BYTES && this.chunks.length > 0) {
      const excess = this.length - MAX_REPLAY_HISTORY_BYTES
      const first = this.chunks[0]
      if (first.length <= excess) {
        this.chunks.shift()
        this.length -= first.length
        continue
      }

      this.chunks[0] = first.slice(excess)
      this.length -= excess
      break
    }
  }

  readAll() {
    return this.chunks.join('')
  }

  clear() {
    this.chunks = []
    this.length = 0
  }
}
