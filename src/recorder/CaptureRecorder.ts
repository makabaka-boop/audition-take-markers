/**
 * CaptureRecorder —— 纯前端试镜采集内核
 *
 * 设计要点：
 * 1. take 状态机：idle → starting → recording ⇄ paused → stopping → idle
 *    所有外部操作都做幂等保护，重复调用不会产生副作用。
 * 2. 三种采集模式（av 音视频 / video-only 仅视频 / audio-only 仅音频），
 *    各自按顺序探测一组 MIME；某组全不可用只禁用该模式，不影响其它模式。
 * 3. 开拍瞬间（申请权限之前）冻结模式、MIME 与设备选择：starting 期间
 *    外部的重复 start / 模式切换都无法改变取流约束、录制参数与成片类型，
 *    直到回到 idle 才解锁。
 * 4. 采集计划只请求所需轨道：仅音频 video:false、仅视频 audio:false，
 *    缺少无关设备不算失败。
 * 5. MediaRecorder 的 stop() / dataavailable 事件顺序在真实设备上会交错
 *    （拔掉摄像头尤其明显：轨道 ended、尾段晚到、stop 最后到）。
 *    本内核只在收到 stop 事件时形成成片；stop 之前到达的非空 chunk
 *    一律按到达顺序保留；stop 之后到达的陈旧事件一律丢弃。
 * 6. 每条 take 用自增 session 隔离：旧 recorder、旧轨道、旧定时器的事件
 *    不可能污染新 take。
 * 7. 设备中断（轨道 ended 或 recorder error）只触发一次停止，并标注原因；
 *    有数据则保留成片，无数据则失败报错。
 * 8. 瞬间标记（marker）只允许在 recording 态写入，时间取排除暂停的有效
 *    时钟（与成片时长同一时钟）；同一毫秒的标记按会话内自增序号保序。
 *    停止落定时标记与 Blob、时长一起冻结，并按冻结有效时长裁剪后随 take
 *    交付；空 Blob 不生成 take，标记随之丢弃；标记与 chunk 一样受 session
 *    守卫保护，旧会话迟到事件绝不可能把标记附到新 take。
 */

export type RecorderStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'

/** 采集模式：音视频（默认）/ 仅视频 / 仅音频 */
export type CaptureMode = 'av' | 'video-only' | 'audio-only'

/** 成片产生的停止原因 */
export type StopReason = 'user' | 'device-interrupted'

/** 向 UI 报告的错误类型 */
export type CaptureErrorCode =
  | 'codec-unsupported'
  | 'permission-denied'
  | 'start-failed'
  | 'empty-take'
  | 'stop-failed'

/**
 * 停止后等待编码器 stop 事件（含晚到尾段）的宽限窗口。
 * 真实 UA 通常在下一 tick 内派发 stop；超过该窗口仍无任何落定信号
 * （recorder.stop() 抛错且未进入 inactive，或始终不发 stop 事件）时，
 * 内核强制收尾：释放全部轨道、回到 idle，绝不久留 stopping。
 */
export const STOP_FINALIZE_GRACE_MS = 1000

export class CaptureError extends Error {
  readonly code: CaptureErrorCode
  constructor(code: CaptureErrorCode, message: string) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}

/** 导演在录制中打下的回看标记：时间基于排除暂停的有效录制时钟 */
export interface TakeMarker {
  /** 会话内唯一 id（会话内自增，跨 take 不复用） */
  id: string
  /** 短标签（已 trim，非空） */
  label: string
  /** 相对成片起点的有效时间（毫秒，不含暂停/等待/封装段） */
  timeMs: number
  /** 同毫秒内的创建次序（从 0 起，保证同毫秒保序） */
  seq: number
}

/** 短标签上限（trim 后的字符数） */
export const MAX_MARKER_LABEL_LENGTH = 40

/** 打标被拒原因：UI 据此给出明确提示 */
export type MarkerRejectCode =
  | 'not-recording' // starting（等待权限）/ idle（未开拍或已结束）
  | 'paused' // 已暂停：继续后才能标记
  | 'stopping' // 正在收尾：标记已冻结
  | 'empty-label' // 空白标签
  | 'label-too-long' // 标签超长

/** addMarker 的结局：成功带回冻结前的标记，失败带回明确原因 */
export interface AddMarkerResult {
  ok: boolean
  marker?: TakeMarker
  reason?: MarkerRejectCode
}

export interface Take {
  id: string
  /** 成片采用的采集模式（音频成片回放用 <audio>，其余用 <video>） */
  mode: CaptureMode
  /** 成片 Blob（仅内存，刷新/卸载即消失） */
  blob: Blob
  /** 实际采集时长（毫秒，扣除暂停时段，使用挂钟时间） */
  durationMs: number
  mimeType: string
  reason: StopReason
  createdAt: number
  /** 回放用对象 URL，由内核/上层负责 revoke */
  url: string
  /**
   * 停止落定时与成片一起冻结的瞬间标记，按 (timeMs, seq) 升序。
   * 已按冻结有效时长裁剪（不含暂停段，时间戳不超过 durationMs）。
   */
  markers: TakeMarker[]
}

export interface RecorderDeps {
  /** 便于测试：默认使用全局 MediaRecorder */
  MediaRecorder: MediaRecorderLikeCtor
  getUserMedia: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStreamLike>
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  now: () => number
  randomId: () => string
  /** 定时器：真实环境用全局 setTimeout/clearTimeout，测试注入虚拟时钟 */
  setTimer: (handler: () => void, timeoutMs: number) => unknown
  clearTimer: (handle: unknown) => void
}

/** MediaRecorder 所需的最小结构面，真实 MediaRecorder 结构兼容 */
export interface MediaRecorderLikeCtor {
  isTypeSupported(mimeType: string): boolean
  new (
    stream: MediaStreamLike,
    options?: { mimeType?: string },
  ): MediaRecorderLike
}

export interface MediaRecorderLike {
  readonly mimeType: string
  readonly state: 'inactive' | 'recording' | 'paused'
  start(timeslice?: number): void
  stop(): void
  pause(): void
  resume(): void
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  onerror:
    | ((event: { error?: { name?: string; message?: string } }) => void)
    | null
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[]
}

export interface MediaStreamTrackLike {
  readonly kind: string
  readonly readyState: 'live' | 'ended'
  stop(): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** 全部采集模式，UI 按此顺序渲染切换项 */
export const CAPTURE_MODES: readonly CaptureMode[] = [
  'av',
  'video-only',
  'audio-only',
]

/**
 * 各模式独立、按顺序探测的 MIME 候选：
 * - 音视频：video/webm;codecs=vp9,opus → vp8,opus → 裸 video/webm
 * - 仅视频：video/webm;codecs=vp9 → vp8 → 裸 video/webm
 * - 仅音频：audio/webm;codecs=opus → 裸 audio/webm
 */
export const MODE_MIME_CANDIDATES: Record<
  CaptureMode,
  readonly string[]
> = {
  av: [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ],
  'video-only': [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ],
  'audio-only': ['audio/webm;codecs=opus', 'audio/webm'],
}

/** @deprecated 兼容旧引用：音视频模式的 MIME 候选 */
export const MIME_CANDIDATES = MODE_MIME_CANDIDATES.av

export function pickSupportedMimeType(
  ctor: MediaRecorderLikeCtor | undefined,
  candidates: readonly string[] = MODE_MIME_CANDIDATES.av,
): string | null {
  if (!ctor) return null
  for (const candidate of candidates) {
    try {
      if (ctor.isTypeSupported(candidate)) return candidate
      // 该候选不支持：继续探测下一个
    } catch {
      // 个别实现对陌生字符串抛异常，按“不支持”处理继续探测
    }
  }
  return null
}

export interface StartOptions {
  /** 采集模式，缺省 av（兼容无参 start） */
  mode?: CaptureMode
  videoDeviceId?: string
  audioDeviceId?: string
  /**
   * 可选的已授权流（UI 取流做预览时复用，避免二次授权弹窗/设备占用）。
   * 传入时录制器不再自行调用 getUserMedia，但模式/MIME 仍在调用前冻结。
   */
  stream?: MediaStreamLike
}

export interface RecorderCallbacks {
  onStatusChange: (status: RecorderStatus) => void
  onTake: (take: Take) => void
  onError: (error: CaptureError) => void
  /** 停止已落定（无论成片还是失败），UI 可借此刷新设备标签等 */
  onSettled: (reason: StopReason, error?: CaptureError) => void
  /**
   * 当前会话有效标记快照变化（新增 / 随停止、取消、失败、卸载而清空）。
   * 只反映“进行中会话”的标记；take 冻结后的标记随 onTake 交付。
   */
  onLiveMarkersChange: (markers: readonly TakeMarker[]) => void
}

/** 开拍瞬间冻结的采集计划：授权等待期间任何外部操作都改不动它 */
interface FrozenPlan {
  mode: CaptureMode
  mimeType: string
  videoDeviceId?: string
  audioDeviceId?: string
}

interface ActiveSession {
  session: number
  mode: CaptureMode
  recorder: MediaRecorderLike
  stream: MediaStreamLike
  mimeType: string
  chunks: Blob[]
  startedAt: number
  accumulatedMs: number
  pausedAt: number | null
  /** 是否已请求停止（防重复停止 / 中断只停一次） */
  stopRequested: boolean
  /** stop 事件是否已到达，到达后一切陈旧数据丢弃 */
  finalized: boolean
  /**
   * 时长冻结点（请求停止 / 设备中断的时刻）。
   * 一旦冻结，最终时长即此值：暂停、授权等待与封装等待均不计入。
   */
  frozenDurationMs: number | null
  /** 编码器迟迟不落定时强制收尾的兜底定时器句柄 */
  stopTimer: unknown
  /** 兜底是否由定时器强制触发（用于区分失败文案） */
  forcedByTimer: boolean
  stopReason: StopReason
  /** 停止原因附带的设备信息，用于无成片时的报错文案 */
  interruptionMessage: string
  trackListeners: Array<{ track: MediaStreamTrackLike; listener: () => void }>
  /**
   * 本会话录制中打下的标记，按创建次序保存。时间取 currentElapsed
   * （排除暂停的有效时钟），与成片 durationMs 同源，因此暂停不会让标记漂移。
   */
  markers: TakeMarker[]
  /** 会话内标记自增序号：同一毫秒多次标记靠它保序 */
  markerSeq: number
}

const MODE_DEVICE_TEXT: Record<CaptureMode, string> = {
  av: '摄像头或麦克风',
  'video-only': '摄像头',
  'audio-only': '麦克风',
}

/** 各不可标记状态/非法标签的明确提示文案（UI 直接展示） */
export const MARKER_REJECT_MESSAGE: Record<MarkerRejectCode, string> = {
  'not-recording': '当前未在录制：只有录制中的瞬间才能打标。',
  paused: '已暂停：暂停期间不能打标，请继续后再标记。',
  stopping: '正在收尾：停止请求已发出，标记已冻结，不能再打标。',
  'empty-label': '标记内容不能为空：请输入简短标签。',
  'label-too-long': `标记过长：请控制在 ${MAX_MARKER_LABEL_LENGTH} 字以内。`,
}

function codecUnsupportedMessage(mode: CaptureMode): string {
  if (mode === 'audio-only') {
    return '当前浏览器不支持任何 audio/webm 录制编码（opus），仅音频模式无法开拍。'
  }
  if (mode === 'video-only') {
    return '当前浏览器不支持任何 video/webm 视频编码（vp9/vp8），仅视频模式无法开拍。'
  }
  return '当前浏览器不支持任何 webm 录制编码（vp9/vp8），无法开拍。'
}

export class CaptureRecorder {
  private status: RecorderStatus = 'idle'
  private sessionCounter = 0
  private active: ActiveSession | null = null
  /** 开拍时冻结、回到 idle 时清除的采集计划 */
  private plan: FrozenPlan | null = null
  private disposed = false

  constructor(
    private readonly callbacks: RecorderCallbacks,
    private readonly deps: RecorderDeps,
  ) {}

  getStatus(): RecorderStatus {
    return this.status
  }

  /** 某模式开机前探测：该模式候选均不可用时返回 null（UI 据此禁用该模式） */
  getSupportedMimeType(mode: CaptureMode = 'av'): string | null {
    return pickSupportedMimeType(
      this.deps.MediaRecorder,
      MODE_MIME_CANDIDATES[mode],
    )
  }

  /** 三种模式各自的能力探测结果，互不影响 */
  getSupportedMimeTypes(): Record<CaptureMode, string | null> {
    return {
      av: this.getSupportedMimeType('av'),
      'video-only': this.getSupportedMimeType('video-only'),
      'audio-only': this.getSupportedMimeType('audio-only'),
    }
  }

  /** 当前进行中（含 starting）冻结的模式；idle 时为 null */
  getActiveMode(): CaptureMode | null {
    return this.active?.mode ?? this.plan?.mode ?? null
  }

  /** 当前进行中（含 starting）冻结的实际 MIME；idle 时为 null */
  getActiveMimeType(): string | null {
    return this.active?.mimeType ?? this.plan?.mimeType ?? null
  }

  /** 当前录制会话的流（供 UI 做实时预览）；idle 时为 null */
  getActiveStream(): MediaStreamLike | null {
    return this.active?.stream ?? null
  }

  start(options: StartOptions = {}): void {
    if (this.disposed) return
    // 重复 start：除 idle 外一律忽略（starting 中等待授权时的双击也被挡下，
    // 冻结的计划不会被第二次调用改写）
    if (this.status !== 'idle') return

    // 模式与 MIME 在申请权限之前冻结：本模式无可用编码时根本不取设备，
    // 也不触碰任何旧 take；只禁用该模式，其它模式能力原样保留。
    const mode = options.mode ?? 'av'
    const mimeType = this.getSupportedMimeType(mode)
    if (!mimeType) {
      this.emitError(
        new CaptureError('codec-unsupported', codecUnsupportedMessage(mode)),
      )
      return
    }

    // 只冻结本模式实际会用到的设备：不相关的设备选择一律不进入计划
    const videoDeviceId =
      mode === 'audio-only' ? undefined : (options.videoDeviceId ?? '') || undefined
    const audioDeviceId =
      mode === 'video-only' ? undefined : (options.audioDeviceId ?? '') || undefined

    const session = ++this.sessionCounter
    this.plan = { mode, mimeType, videoDeviceId, audioDeviceId }
    // 先进入 starting 完成冻结，随后才申请权限
    this.setStatus('starting')

    // UI 已取到授权流（预览复用）：直接装配，避免二次授权弹窗/设备占用
    if (options.stream) {
      this.attachStream(session, options.stream)
      return
    }

    // 采集计划只请求所需轨道：缺少无关设备（如仅视频时没有麦克风）
    // 不会形成约束，自然不算失败
    const constraints: MediaStreamConstraints = {
      video:
        mode === 'audio-only'
          ? false
          : videoDeviceId
            ? { deviceId: { exact: videoDeviceId } }
            : true,
      audio:
        mode === 'video-only'
          ? false
          : audioDeviceId
            ? { deviceId: { exact: audioDeviceId } }
            : true,
    }

    this.deps
      .getUserMedia(constraints)
      .then((stream) => this.attachStream(session, stream))
      .catch((err: unknown) => {
        if (this.disposed || session !== this.sessionCounter) return
        this.active = null
        this.setStatus('idle')
        const name = errorName(err)
        const denied = name === 'NotAllowedError' || name === 'SecurityError'
        const device = MODE_DEVICE_TEXT[mode]
        const text = denied
          ? `${device}授权被拒绝，无法开拍。可在浏览器地址栏重新授权后再试。`
          : `无法开启${device}：${messageOf(err)}`
        this.emitError(
          new CaptureError(denied ? 'permission-denied' : 'start-failed', text),
        )
      })
  }

  /** 拿到流后的统一装配路径：按冻结计划构造 recorder、挂事件、start */
  private attachStream(session: number, stream: MediaStreamLike): void {
    // 授权返回期间用户可能已停止或卸载；迟到的 stream 必须立即释放
    if (this.disposed || session !== this.sessionCounter || !this.plan) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    const plan = this.plan
    const mimeType = plan.mimeType

    let recorder: MediaRecorderLike
    try {
      recorder = new this.deps.MediaRecorder(stream, { mimeType })
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop())
      if (session === this.sessionCounter && !this.disposed) {
        this.setStatus('idle')
        this.emitError(
          new CaptureError(
            'start-failed',
            `录制器初始化失败：${messageOf(err)}`,
          ),
        )
      }
      return
    }

    const now = this.deps.now()
    const next: ActiveSession = {
      session,
      mode: plan.mode,
      recorder,
      stream,
      mimeType: recorder.mimeType || mimeType,
      chunks: [],
      startedAt: now,
      accumulatedMs: 0,
      pausedAt: null,
      stopRequested: false,
      finalized: false,
      frozenDurationMs: null,
      stopTimer: null,
      forcedByTimer: false,
      stopReason: 'user',
      interruptionMessage: '',
      trackListeners: [],
      markers: [],
      markerSeq: 0,
    }
    this.active = next

    recorder.ondataavailable = (event) => {
      // 会话守卫：旧 take 的事件永不影响新 take
      if (this.disposed || this.active?.session !== session) return
      this.handleData(next, event.data)
    }
    recorder.onstop = () => {
      if (this.disposed || this.active?.session !== session) return
      this.handleStop(next)
    }
    recorder.onerror = (event) => {
      if (this.disposed || this.active?.session !== session) return
      this.handleError(next, event.error)
    }

    for (const track of stream.getTracks()) {
      // ended 是一次性事件，闭包捕获本会话
      const listener = () => {
        if (this.disposed || this.active?.session !== session) return
        if (next.finalized || next.stopRequested) return
        this.requestStop(next, 'device-interrupted')
      }
      track.addEventListener('ended', listener)
      next.trackListeners.push({ track, listener })
    }

    try {
      // timeslice 让 chunk 在录制中持续到达，尾段晚到也能并入
      recorder.start(250)
    } catch (err) {
      this.teardownSession(next)
      this.active = null
      this.setStatus('idle')
      this.emitError(
        new CaptureError('start-failed', `录制启动失败：${messageOf(err)}`),
      )
      return
    }

    this.setStatus('recording')
  }

  pause(): void {
    const a = this.active
    if (!a || this.status !== 'recording') return
    try {
      a.recorder.pause()
    } catch {
      return
    }
    const now = this.deps.now()
    a.accumulatedMs += now - a.startedAt
    a.pausedAt = now
    this.setStatus('paused')
  }

  resume(): void {
    const a = this.active
    if (!a || this.status !== 'paused' || a.pausedAt === null) return
    try {
      a.recorder.resume()
    } catch {
      return
    }
    // 从继续时刻重新计时；否则停止结算时会把暂停时段再算一遍
    a.startedAt = this.deps.now()
    a.pausedAt = null
    this.setStatus('recording')
  }

  /**
   * 给当前录制会话打下一个瞬间标记（短标签）。
   *
   * 仅 recording 态允许写入：等待权限（starting）、已暂停（paused）、
   * 正在收尾（stopping）以及未开拍/已结束（idle）都给出明确拒绝原因，
   * 不产生任何状态变化。时间使用与成片时长同源的“有效时钟”
   * （currentElapsed：扣除全部暂停段），因此暂停不会让标记漂移；
   * 同一毫秒的多次标记按会话内自增 seq 保留创建次序。
   */
  addMarker(rawLabel: string): AddMarkerResult {
    if (this.disposed || !this.active || this.status !== 'recording') {
      return { ok: false, reason: this.inactiveMarkerReason() }
    }
    const a = this.active
    const label = rawLabel.trim()
    if (label.length === 0) {
      return { ok: false, reason: 'empty-label' }
    }
    if (label.length > MAX_MARKER_LABEL_LENGTH) {
      return { ok: false, reason: 'label-too-long' }
    }
    const marker: TakeMarker = {
      id: `m${a.session}-${a.markerSeq + 1}`,
      label,
      timeMs: this.currentElapsed(a),
      seq: a.markerSeq,
    }
    a.markerSeq += 1
    a.markers.push(marker)
    this.emitLiveMarkers(a)
    return { ok: true, marker }
  }

  /** 当前会话进行中标记的只读快照（无进行中会话时为空） */
  getLiveMarkers(): readonly TakeMarker[] {
    return this.active ? this.active.markers.slice() : []
  }

  /**
   * 用户停止；重复调用安全，停止中的再次调用无效。
   * starting（授权弹窗未决）时语义为“取消本次开拍”：不产生任何成片、
   * 不释放任何轨道（流尚未拿到），直接回 idle 并令 session 失效；
   * 迟到的授权结果由会话守卫释放其流后丢弃。
   */
  stop(): void {
    if (this.disposed) return
    // 授权未决：取消本次开拍。设备尚被浏览器弹窗占用、流尚未返回，
    // 这里没有轨道可释放；让 session 立即作废即可解锁模式/设备切换。
    if (this.status === 'starting') {
      this.cancelStarting()
      return
    }
    const a = this.active
    if (!a) return
    this.requestStop(a, 'user')
  }

  /** 卸载：释放轨道，不产生 take（成片本就只在内存） */
  dispose(): void {
    this.disposed = true
    // 授权未决时卸载：作废 session，迟到的授权结果只会释放其流
    if (!this.active && this.plan) this.plan = null
    const a = this.active
    if (a) {
      this.teardownSession(a)
      // 卸载不产生 take：进行中标记随会话一起丢弃，不附到任何成片
      this.callbacks.onLiveMarkersChange([])
    }
    this.active = null
    if (this.status !== 'idle') this.setStatus('idle')
  }

  // ---- 内部 ----

  /** 非 recording 态下打标的拒绝原因（dispose 后按已结束处理） */
  private inactiveMarkerReason(): MarkerRejectCode {
    switch (this.status) {
      case 'paused':
        return 'paused'
      case 'stopping':
        return 'stopping'
      // starting（等待权限）与 idle（未开拍/已结束）统一为“未在录制”
      default:
        return 'not-recording'
    }
  }

  /** 广播进行中标记的不可变快照（slice 防止外部改写会话内数组） */
  private emitLiveMarkers(a: ActiveSession): void {
    this.callbacks.onLiveMarkersChange(a.markers.slice())
  }

  /** 取消等待授权的开拍：确定结局是“取消”——无成片、无错误、回 idle */
  private cancelStarting(): void {
    // 作废自增 session：迟到的 grant/deny 与迟到的流全部失效
    this.sessionCounter++
    this.plan = null
    this.setStatus('idle')
    // 取消不产生 take：进行中标记视图（理论上为空）也一并清空
    this.callbacks.onLiveMarkersChange([])
  }

  private requestStop(a: ActiveSession, reason: StopReason): void {
    if (a.finalized || a.stopRequested) return
    a.stopRequested = true
    a.stopReason = reason

    // 时长在此刻冻结：排除此后的全部时间——
    // - 编码器封装等待（stop 事件晚到）不计入；
    // - 暂停中停止时暂停时段不计入（currentElapsed 在 paused 时不增长）。
    a.frozenDurationMs = this.currentElapsed(a)

    if (this.status === 'recording' || this.status === 'paused') {
      this.setStatus('stopping')
    }

    // 先把编码器缓冲吐出，再停。轨道 ended 时 state 可能已不是 recording，
    // stop() 对 inactive 会抛 InvalidStateError——吞掉，并让事件循环排空
    // 一轮再兜底落定，给“晚到的尾段 chunk”留出并入窗口；
    // 若 onstop 在这之前到达，finalized 会使兜底自动失效。
    let inactiveAfterThrow = false
    try {
      a.recorder.stop()
    } catch {
      inactiveAfterThrow = a.recorder.state === 'inactive'
      if (inactiveAfterThrow) {
        queueMicrotask(() => {
          if (!this.disposed && this.active === a && !a.finalized) {
            this.handleStop(a)
          }
        })
      }
      // stop() 在 recording/paused 态直接抛错（拒绝停止）时也不能悬挂：
      // 交由统一的兜底定时器强制收尾。
    }

    // 统一兜底：recorder 拒绝停止、stop() 后始终不发 stop 事件、
    // 或设备中断后编码器沉默，都在宽限窗口后强制落定，保证轨道必释放。
    this.armStopWatchdog(a)
  }

  /**
   * 停止落定兜底：宽限窗口内未收到 stop 事件就强制收尾。
   * 窗口给晚到尾段（stop 之前的 dataavailable）保留并入机会；
   * 窗口之后到达的 chunk 因 finalized 一律丢弃。
   */
  private armStopWatchdog(a: ActiveSession): void {
    if (a.stopTimer !== null) return
    a.stopTimer = this.deps.setTimer(() => {
      if (this.disposed || this.active !== a || a.finalized) return
      a.forcedByTimer = true
      this.handleStop(a)
    }, STOP_FINALIZE_GRACE_MS)
  }

  /** 当前未结算录制段的时长；暂停态自暂停时刻起不再增长 */
  private currentElapsed(a: ActiveSession): number {
    if (a.pausedAt !== null) return a.accumulatedMs
    return a.accumulatedMs + (this.deps.now() - a.startedAt)
  }

  private handleData(a: ActiveSession, data: Blob): void {
    // stop 到达之后的陈旧 chunk 一律不并入
    if (a.finalized) return
    // 只缓存非空 chunk：零字节 chunk（含 size 为 0 的 Blob）丢弃，
    // 否则全程仅空数据也会拼出一个“可回放/可下载”的空壳成片
    if (data && data.size > 0) a.chunks.push(data)
  }

  private handleError(
    a: ActiveSession,
    raw: { name?: string; message?: string } | undefined,
  ): void {
    if (a.finalized) return
    // 设备中断路径：只触发一次停止并标注原因（重复 error 被挡下）
    a.interruptionMessage = raw?.message || raw?.name || '设备中断'
    this.requestStop(a, 'device-interrupted')
  }

  private handleStop(a: ActiveSession): void {
    if (a.finalized) return
    a.finalized = true

    // 时长冻结在请求停止/中断的时刻，handleStop 无论何时被调用
    // （stop 事件晚到或兜底定时器）都不再读取时钟，封装等待不计入。
    const durationMs = a.frozenDurationMs ?? this.currentElapsed(a)
    const reason = a.stopReason
    const mode = a.mode
    const mimeType = a.mimeType
    const chunks = a.chunks
    const interruptedMessage = a.interruptionMessage
    const forced = a.forcedByTimer
    // 标记与时长在同一落定时刻冻结：以冻结有效时长裁剪
    // （等于裁剪边界的标记保留），再按 (timeMs, seq) 稳定排序。
    // 正常时钟下单调推进不会产生越界标记；裁剪是对时钟回拨等异常的防御。
    const markers = a.markers
      .filter((m) => m.timeMs <= durationMs)
      .sort((x, y) => x.timeMs - y.timeMs || x.seq - y.seq)

    this.teardownSession(a)
    this.active = null
    this.setStatus('idle')
    // 会话结束：进行中标记视图清空；冻结副本已随 take（或随失败丢弃）
    this.callbacks.onLiveMarkersChange([])

    if (chunks.length === 0) {
      const error = forced
        ? new CaptureError(
            'stop-failed',
            '录制器停止后迟迟未完成封装（未收到结束事件），且本次没有可保留的数据，本次拍摄失败。',
          )
        : reason === 'device-interrupted'
          ? new CaptureError(
              'empty-take',
              `设备在产出任何数据之前中断（${interruptedMessage || '轨道 ended'}），本次拍摄失败。`,
            )
          : new CaptureError(
              'empty-take',
              '未采集到任何数据，本次拍摄失败。',
            )
      this.callbacks.onSettled(reason, error)
      this.emitError(error)
      return
    }

    const blob = new Blob(chunks, { type: mimeType })
    const take: Take = {
      id: this.deps.randomId(),
      mode,
      blob,
      durationMs,
      mimeType,
      reason,
      createdAt: this.deps.now(),
      url: this.deps.createObjectURL(blob),
      markers,
    }
    this.callbacks.onTake(take)
    this.callbacks.onSettled(reason)
  }

  private teardownSession(a: ActiveSession): void {
    if (a.stopTimer !== null) {
      this.deps.clearTimer(a.stopTimer)
      a.stopTimer = null
    }
    a.recorder.ondataavailable = null
    a.recorder.onstop = null
    a.recorder.onerror = null
    for (const { track, listener } of a.trackListeners) {
      track.removeEventListener('ended', listener)
    }
    a.trackListeners = []
    for (const track of a.stream.getTracks()) {
      track.stop()
    }
  }

  private setStatus(status: RecorderStatus): void {
    this.status = status
    // 回到 idle 即解锁：冻结的采集计划到此结束
    if (status === 'idle') this.plan = null
    this.callbacks.onStatusChange(status)
  }

  private emitError(error: CaptureError): void {
    this.callbacks.onError(error)
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** DOMException 在部分环境（jsdom）不继承 Error，需防御式读取 name */
function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  if (err instanceof Error) return err.name
  return ''
}
