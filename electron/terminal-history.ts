import { MAX_REPLAY_HISTORY_BYTES } from './pty-shared'

export class TerminalHistoryBuffer {
  private chunks: string[] = []
  private start = 0
  private length = 0

  append(data: string) {
    if (!data) return

    this.chunks.push(data)
    this.length += data.length

    while (this.length > MAX_REPLAY_HISTORY_BYTES && this.chunks.length > 0) {
      const excess = this.length - MAX_REPLAY_HISTORY_BYTES
      const first = this.chunks[this.start]
      if (first === undefined) {
        this.compact()
        continue
      }

      if (first.length <= excess) {
        this.start += 1
        this.length -= first.length
        continue
      }

      this.chunks[this.start] = first.slice(excess)
      this.length -= excess
      break
    }

    if (this.start > 128 && this.start * 2 > this.chunks.length) {
      this.compact()
    }
  }

  readAll() {
    return this.start === 0 ? this.chunks.join('') : this.chunks.slice(this.start).join('')
  }

  clear() {
    this.chunks = []
    this.start = 0
    this.length = 0
  }

  private compact() {
    if (this.start === 0) return
    this.chunks = this.chunks.slice(this.start)
    this.start = 0
  }
}
