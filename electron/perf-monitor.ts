import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const SAMPLE_INTERVAL_MS = 5_000
const RENDERER_REPORT_TTL_MS = 15_000
const TERMINAL_REPORT_TTL_MS = 15_000
const RECENT_EVENT_LIMIT = 200
const SPIKE_COOLDOWN_MS = 60_000
const RENDERER_CPU_SPIKE_THRESHOLD = 50
const GPU_CPU_SPIKE_THRESHOLD = 25
const LOW_FPS_THRESHOLD = 45
const LONG_TASK_SPIKE_THRESHOLD_MS = 120

type PerfEventKind = 'sample' | 'spike' | 'renderer' | 'terminal'

export interface RendererPerfReport {
  rendererPid: number
  sampleWindowMs: number
  fps: number
  longTaskCount: number
  maxLongTaskMs: number
  liveTerminalCount: number
  cachedTerminalCount: number
  totalTerminalCount: number
  totalBrowserCount: number
  totalTextEditorCount: number
  totalAgentWindowCount: number
  projectCount: number
  focusedTerminalId: string | null
  focusedBrowserId: string | null
  focusedTextEditorId: string | null
  focusedAgentWindowId: string | null
  useTransparentWindow: boolean
  windowOpacity: number
  overlayOpen: boolean
  cpu: {
    percentCPUUsage: number
    idleWakeupsPerSecond: number
  } | null
  memory: {
    residentSet: number
    private: number
    shared: number
  } | null
  heap: {
    totalHeapSize: number
    usedHeapSize: number
    heapSizeLimit: number
  } | null
}

export interface TerminalPerfReport {
  termId: string
  sampleWindowMs: number
  bytes: number
  writeCalls: number
  forcedFullRenders: number
  viewportY: number
  scrollbackLines: number
  isFocused: boolean
  isVisible: boolean
}

export interface PerfEventRecord {
  timestamp: number
  kind: PerfEventKind
  data: Record<string, unknown>
}

export interface PerfMonitorStatus {
  enabled: boolean
  logPath: string
  sampleIntervalMs: number
  hardwareAccelerationEnabled: boolean
  gpuFeatureStatus: Record<string, string>
  recentEventCount: number
}

type ProcessMetricLike = {
  pid?: number
  type?: string
  cpu?: { percentCPUUsage?: number; idleWakeupsPerSecond?: number }
  memory?: {
    workingSetSize?: number
    peakWorkingSetSize?: number
    privateBytes?: number
    sharedBytes?: number
  }
}

function normalizeMetric(metric: ProcessMetricLike) {
  return {
    pid: typeof metric.pid === 'number' ? metric.pid : null,
    type: typeof metric.type === 'string' ? metric.type : 'unknown',
    cpuPercent: metric.cpu?.percentCPUUsage ?? 0,
    idleWakeupsPerSecond: metric.cpu?.idleWakeupsPerSecond ?? 0,
    workingSetSize: metric.memory?.workingSetSize ?? 0,
    peakWorkingSetSize: metric.memory?.peakWorkingSetSize ?? 0,
    privateBytes: metric.memory?.privateBytes ?? 0,
    sharedBytes: metric.memory?.sharedBytes ?? 0,
  }
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

export class PerfMonitor {
  private readonly logPath: string
  private interval: ReturnType<typeof setInterval> | null = null
  private writer: fs.WriteStream | null = null
  private recentEvents: PerfEventRecord[] = []
  private rendererReports = new Map<number, { timestamp: number; sample: RendererPerfReport }>()
  private terminalReports = new Map<string, { timestamp: number; sample: TerminalPerfReport }>()
  private lastSpikeAt = 0

  constructor(logDir: string) {
    ensureDir(logDir)
    this.logPath = path.join(logDir, 'perf.ndjson')
  }

  start() {
    if (this.interval) return
    this.writer = fs.createWriteStream(this.logPath, { flags: 'a' })
    this.interval = setInterval(() => {
      this.captureSample()
    }, SAMPLE_INTERVAL_MS)
    this.captureSample()
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    this.writer?.end()
    this.writer = null
  }

  reportRendererSample(sample: RendererPerfReport) {
    this.rendererReports.set(sample.rendererPid, { timestamp: Date.now(), sample })
    this.recordEvent('renderer', {
      rendererPid: sample.rendererPid,
      fps: sample.fps,
      longTaskCount: sample.longTaskCount,
      maxLongTaskMs: sample.maxLongTaskMs,
      liveTerminalCount: sample.liveTerminalCount,
      cachedTerminalCount: sample.cachedTerminalCount,
      totalTerminalCount: sample.totalTerminalCount,
      cpuPercent: sample.cpu?.percentCPUUsage ?? null,
      residentSet: sample.memory?.residentSet ?? null,
      usedHeapSize: sample.heap?.usedHeapSize ?? null,
    })
  }

  reportTerminalSample(sample: TerminalPerfReport) {
    this.terminalReports.set(sample.termId, { timestamp: Date.now(), sample })
    this.recordEvent('terminal', sample as unknown as Record<string, unknown>)
  }

  getStatus(): PerfMonitorStatus {
    const electronApp = app as typeof app & {
      isHardwareAccelerationEnabled?: () => boolean
    }
    return {
      enabled: this.interval !== null,
      logPath: this.logPath,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      hardwareAccelerationEnabled: electronApp.isHardwareAccelerationEnabled?.() ?? true,
      gpuFeatureStatus: app.getGPUFeatureStatus() as unknown as Record<string, string>,
      recentEventCount: this.recentEvents.length,
    }
  }

  getRecentEvents(limit = 50): PerfEventRecord[] {
    return this.recentEvents.slice(-Math.max(1, limit))
  }

  private captureSample() {
    const now = Date.now()
    const metrics = app
      .getAppMetrics()
      .map((metric) => normalizeMetric(metric as unknown as ProcessMetricLike))
    const recentRendererReports = [...this.rendererReports.values()].filter(
      (entry) => now - entry.timestamp <= RENDERER_REPORT_TTL_MS,
    )
    const recentTerminalReports = [...this.terminalReports.values()].filter(
      (entry) => now - entry.timestamp <= TERMINAL_REPORT_TTL_MS,
    )

    const rendererMetrics = metrics.filter((metric) => {
      const type = metric.type.toLowerCase()
      return type.includes('renderer') || type.includes('tab')
    })
    const gpuMetrics = metrics.filter((metric) => metric.type.toLowerCase().includes('gpu'))

    const rendererCpuPercent = rendererMetrics.reduce((sum, metric) => sum + metric.cpuPercent, 0)
    const gpuCpuPercent = gpuMetrics.reduce((sum, metric) => sum + metric.cpuPercent, 0)
    const rendererWorkingSetSize = rendererMetrics.reduce(
      (sum, metric) => sum + metric.workingSetSize,
      0,
    )

    const topTerminalReports = recentTerminalReports
      .map((entry) => entry.sample)
      .sort((a, b) => {
        if (b.forcedFullRenders !== a.forcedFullRenders) {
          return b.forcedFullRenders - a.forcedFullRenders
        }
        return b.bytes - a.bytes
      })
      .slice(0, 5)

    const rendererReport = recentRendererReports
      .map((entry) => entry.sample)
      .sort((a, b) => b.sampleWindowMs - a.sampleWindowMs)[0]

    this.recordEvent('sample', {
      rendererCpuPercent,
      gpuCpuPercent,
      rendererWorkingSetSize,
      rendererProcessCount: rendererMetrics.length,
      gpuProcessCount: gpuMetrics.length,
      rendererReport: rendererReport ?? null,
      topTerminalReports,
    })

    const spikeDetected =
      rendererCpuPercent >= RENDERER_CPU_SPIKE_THRESHOLD ||
      gpuCpuPercent >= GPU_CPU_SPIKE_THRESHOLD ||
      (rendererReport?.fps ?? 100) <= LOW_FPS_THRESHOLD ||
      (rendererReport?.maxLongTaskMs ?? 0) >= LONG_TASK_SPIKE_THRESHOLD_MS

    if (spikeDetected && now - this.lastSpikeAt >= SPIKE_COOLDOWN_MS) {
      this.lastSpikeAt = now
      this.recordEvent('spike', {
        rendererCpuPercent,
        gpuCpuPercent,
        rendererWorkingSetSize,
        rendererReport: rendererReport ?? null,
        topTerminalReports,
      })
    }
  }

  private recordEvent(kind: PerfEventKind, data: Record<string, unknown>) {
    const event: PerfEventRecord = {
      timestamp: Date.now(),
      kind,
      data,
    }
    this.recentEvents.push(event)
    if (this.recentEvents.length > RECENT_EVENT_LIMIT) {
      this.recentEvents.splice(0, this.recentEvents.length - RECENT_EVENT_LIMIT)
    }
    this.writer?.write(JSON.stringify(event) + '\n')
  }
}
