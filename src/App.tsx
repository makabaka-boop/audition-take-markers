import { useEffect, useRef, useState, type RefObject } from 'react'
import { useAuditionRecorder } from './hooks/useAuditionRecorder'
import type {
  CaptureMode,
  RecorderStatus,
  Take,
  TakeMarker,
} from './recorder/CaptureRecorder'

const STATUS_TEXT: Record<RecorderStatus, string> = {
  idle: '空闲',
  starting: '正在请求设备…',
  recording: '录制中',
  paused: '已暂停',
  stopping: '正在收尾…',
}

const MODE_TEXT: Record<CaptureMode, string> = {
  av: '音视频',
  'video-only': '仅视频',
  'audio-only': '仅音频',
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

/** 标记时间轴标签：与播放器 currentTime（秒）同源，精确到 0.1s */
function formatMarkerTime(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000
  const m = Math.floor(totalSeconds / 60)
  const s = Math.floor(totalSeconds % 60)
  const tenth = Math.floor((totalSeconds * 10) % 10)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenth}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function downloadTake(take: Take) {
  // 下载内容直接来自所选 take 的 Blob URL，保证与成片逐字节一致
  const a = document.createElement('a')
  a.href = take.url
  a.download = `audition-${take.id}.webm`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // URL 不在这里 revoke：它随 take 的删除/页面卸载统一释放
}

function Preview({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => undefined)
  }, [stream])

  return (
    <video
      ref={videoRef}
      className="preview"
      muted
      playsInline
      autoPlay
    />
  )
}

function TakeReplay({
  take,
  selected,
  onSelect,
  onDelete,
}: {
  take: Take
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const mediaRef = useRef<HTMLMediaElement>(null)

  useEffect(() => {
    const el = mediaRef.current
    if (!el) return
    // 切换选中项时重置到该 take 自己的对象 URL
    el.src = take.url
    return () => {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
  }, [take.url])

  /**
   * 定位到某个瞬间标记：标记时间是排除暂停的有效时钟，与成片 Blob 的
   * 媒体时间轴一致，因此直接把播放器 currentTime 跳到该秒即可。
   */
  const jumpToMarker = (marker: TakeMarker) => {
    const el = mediaRef.current
    if (!el) return
    const seconds = marker.timeMs / 1000
    // 防御式裁剪：不越过媒体时长（jsdom 下 duration 为 NaN 时跳过裁剪）
    const bounded =
      Number.isFinite(el.duration) && el.duration > 0
        ? Math.min(seconds, Math.max(0, el.duration - 0.001))
        : Math.max(0, seconds)
    el.currentTime = bounded
    void el.play().catch(() => undefined)
  }

  // 仅音频成片用 <audio> 回放，其余用 <video>
  return (
    <div className={`take-card${selected ? ' selected' : ''}`}>
      {take.mode === 'audio-only' ? (
        <div className="take-audio-wrap">
          <span className="audio-badge">♫ 仅音频</span>
          <audio
            ref={mediaRef as RefObject<HTMLAudioElement>}
            controls
            playsInline
            className="take-audio"
          />
        </div>
      ) : (
        <video
          ref={mediaRef as RefObject<HTMLVideoElement>}
          controls
          playsInline
          className="take-video"
        />
      )}
      {take.markers.length > 0 && (
        <div className="marker-list" aria-label="本 take 的瞬间标记">
          <p className="marker-list-title">
            瞬间标记（{take.markers.length}）· 点击跳转
          </p>
          <ol>
            {take.markers.map((marker) => (
              <li key={marker.id}>
                <button
                  type="button"
                  className="marker-jump-btn"
                  onClick={() => jumpToMarker(marker)}
                  aria-label={`跳转到 ${formatMarkerTime(marker.timeMs)} 的标记：${marker.label}`}
                >
                  <time dateTime={`PT${marker.timeMs / 1000}S`}>
                    {formatMarkerTime(marker.timeMs)}
                  </time>
                  <span className="marker-label-text">{marker.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="take-meta">
        <button
          type="button"
          className="select-btn"
          onClick={onSelect}
          disabled={selected}
          aria-pressed={selected}
        >
          {selected ? '★ 交付版' : '选为交付版'}
        </button>
        <span className="take-info">
          {MODE_TEXT[take.mode]} · {formatDuration(take.durationMs)} ·{' '}
          {formatTime(take.createdAt)}
          {take.markers.length > 0 ? ` · ${take.markers.length} 个标记` : ''}
        </span>
        <span className={`take-reason reason-${take.reason}`}>
          {take.reason === 'user' ? '手动停止' : '设备中断'}
        </span>
        <button
          type="button"
          className="delete-btn"
          onClick={onDelete}
          aria-label="删除该 take"
        >
          删除
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const {
    status,
    devices,
    videoDeviceId,
    audioDeviceId,
    setVideoDeviceId,
    setAudioDeviceId,
    mode,
    modes,
    mimeByMode,
    activeMode,
    activeMimeType,
    setMode,
    takes,
    selectedTake,
    selectTake,
    deleteTake,
    error,
    canStart,
    canSwitchDevice,
    liveStream,
    start,
    pause,
    resume,
    stop,
    liveMarkers,
    addMarker,
    canMark,
    maxMarkerLabelLength,
    markerRejectMessage,
  } = useAuditionRecorder()

  // 标记输入与提示均为组件本地状态；不进入内核，取消/重拍自然无残留
  const [markerDraft, setMarkerDraft] = useState('')
  const [markerNotice, setMarkerNotice] = useState<string | null>(null)

  // 每次进入“录制中”都清空上一轮的输入与提示，保证切换 take/重录不串
  const prevStatusRef = useRef<RecorderStatus>('idle')
  useEffect(() => {
    if (
      status === 'recording' &&
      prevStatusRef.current !== 'recording'
    ) {
      setMarkerDraft('')
      setMarkerNotice(null)
    }
    prevStatusRef.current = status
  }, [status])

  const submitMarker = () => {
    const result = addMarker(markerDraft)
    if (result.ok) {
      setMarkerDraft('')
      setMarkerNotice(null)
    } else if (result.reason) {
      setMarkerNotice(markerRejectMessage[result.reason])
    }
  }

  const videoDevices = devices.filter((d) => d.kind === 'videoinput')
  const audioDevices = devices.filter((d) => d.kind === 'audioinput')
  // 进行中显示冻结的模式；空闲时显示所选模式
  const displayMode = activeMode ?? mode
  const needsVideo = displayMode !== 'audio-only'
  const needsAudio = displayMode !== 'video-only'
  const displayMime = activeMimeType ?? mimeByMode[mode]

  const startingText =
    displayMode === 'audio-only'
      ? '正在请求麦克风…'
      : displayMode === 'video-only'
        ? '正在请求摄像头…'
        : '正在请求摄像头与麦克风…'

  return (
    <main className="app">
      <header className="app-header">
        <h1>试镜采集台</h1>
        <p className="subtitle">
          纯前端采集 · 无后端 · 成片仅存在于本次页面内存，刷新即清空
        </p>
      </header>

      <section className="stage" aria-label="采集区">
        <div className="preview-wrap">
          {liveStream && needsVideo ? (
            <Preview stream={liveStream} />
          ) : (
            <div className="preview placeholder">
              {status === 'starting'
                ? startingText
                : displayMode === 'audio-only'
                  ? '仅音频模式：授权后开始采集声音'
                  : '授权后开始采集画面'}
            </div>
          )}
          <div className={`status-badge status-${status}`}>
            <span className="status-dot" />
            {STATUS_TEXT[status]}
          </div>
        </div>

        <div className="controls">
          <fieldset className="mode-row" aria-label="采集模式">
            <legend>采集模式</legend>
            <div className="mode-options" role="radiogroup">
              {modes.map((m) => {
                const unavailable = mimeByMode[m] === null
                const selectable = canSwitchDevice && !unavailable
                return (
                  <label
                    key={m}
                    className={`mode-option${unavailable ? ' unavailable' : ''}`}
                  >
                    <input
                      type="radio"
                      name="capture-mode"
                      value={m}
                      checked={displayMode === m}
                      disabled={!selectable}
                      onChange={() => setMode(m)}
                    />
                    <span>{MODE_TEXT[m]}</span>
                    {unavailable && (
                      <span className="mode-na">不可用</span>
                    )}
                  </label>
                )
              })}
            </div>
            {!canSwitchDevice && (
              <p className="hint">模式已随开拍冻结；停止后才可切换。</p>
            )}
          </fieldset>

          <div className="device-row">
            {needsVideo && (
              <label>
                摄像头
                <select
                  value={videoDeviceId}
                  onChange={(e) => setVideoDeviceId(e.target.value)}
                  disabled={!canSwitchDevice}
                >
                  {videoDevices.length === 0 && (
                    <option value="">默认设备</option>
                  )}
                  {videoDevices.map((d) => (
                    <option
                      key={d.deviceId || 'default'}
                      value={d.deviceId}
                    >
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {needsAudio && (
              <label>
                麦克风
                <select
                  value={audioDeviceId}
                  onChange={(e) => setAudioDeviceId(e.target.value)}
                  disabled={!canSwitchDevice}
                >
                  {audioDevices.length === 0 && (
                    <option value="">默认设备</option>
                  )}
                  {audioDevices.map((d) => (
                    <option
                      key={d.deviceId || 'default'}
                      value={d.deviceId}
                    >
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {!canSwitchDevice && (
            <p className="hint">录制进行中，设备已锁定；停止后才可切换。</p>
          )}

          <div className="mime-line">
            编码（{MODE_TEXT[displayMode]}）：
            {displayMime ? (
              <code>{displayMime}</code>
            ) : (
              <strong className="mime-bad">
                该模式无受支持的 webm 编码，已禁用
              </strong>
            )}
          </div>

          <div className="button-row">
            <button
              type="button"
              className="btn btn-start"
              onClick={() => start()}
              disabled={!canStart}
            >
              开始 take
            </button>
            <button
              type="button"
              className="btn"
              onClick={pause}
              disabled={status !== 'recording'}
            >
              暂停
            </button>
            <button
              type="button"
              className="btn"
              onClick={resume}
              disabled={status !== 'paused'}
            >
              继续
            </button>
            <button
              type="button"
              className="btn btn-stop"
              onClick={stop}
              disabled={
                status === 'idle' || status === 'stopping'
              }
              aria-label={status === 'starting' ? '取消本次开拍' : '停止'}
            >
              {status === 'starting' ? '取消' : '停止'}
            </button>
          </div>

          <fieldset className="marker-row" aria-label="瞬间标记">
            <legend>瞬间标记（按实际录制时长定位）</legend>
            <div className="marker-compose">
              <input
                type="text"
                className="marker-input"
                value={markerDraft}
                maxLength={maxMarkerLabelLength}
                placeholder="给值得回看的瞬间写个短标签…"
                aria-label="瞬间标记标签"
                disabled={!canMark}
                onChange={(e) => setMarkerDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canMark) submitMarker()
                }}
              />
              <button
                type="button"
                className="btn btn-marker"
                onClick={submitMarker}
                disabled={!canMark}
              >
                打标记
              </button>
            </div>
            {/* 不可标记状态给出明确、持续可见的原因 */}
            {!canMark && (
              <p className="marker-hint" data-testid="marker-blocked-hint">
                {status === 'paused'
                  ? markerRejectMessage.paused
                  : status === 'stopping'
                    ? markerRejectMessage.stopping
                    : status === 'starting'
                      ? markerRejectMessage['not-recording'] +
                        ' 正在等待设备授权。'
                      : markerRejectMessage['not-recording']}
              </p>
            )}
            {/* 空白/超长等非法标签的即时反馈 */}
            {markerNotice && (
              <p className="marker-notice" role="alert" aria-live="polite">
                {markerNotice}
              </p>
            )}
            {liveMarkers.length > 0 && (
              <ol className="live-markers" aria-label="本次录制已打的标记">
                {liveMarkers.map((m) => (
                  <li key={m.id} className="live-marker">
                    <time>{formatMarkerTime(m.timeMs)}</time>
                    <span>{m.label}</span>
                  </li>
                ))}
              </ol>
            )}
          </fieldset>

          {error && (
            <div className="error-box" role="alert">
              <strong>出错了：</strong>
              {error.message}
            </div>
          )}
        </div>
      </section>

      <section className="takes" aria-label="成片列表">
        <div className="takes-head">
          <h2>本页成片（{takes.length}）</h2>
          <button
            type="button"
            className="btn btn-download"
            onClick={() => selectedTake && void downloadTake(selectedTake)}
            disabled={!selectedTake}
          >
            下载交付版
          </button>
        </div>
        {takes.length === 0 ? (
          <p className="hint">还没有成片。停止录制后才会在此生成。</p>
        ) : (
          <div className="take-grid">
            {takes
              .slice()
              .reverse()
              .map((take) => (
                <TakeReplay
                  key={take.id}
                  take={take}
                  selected={selectedTake?.id === take.id}
                  onSelect={() => selectTake(take.id)}
                  onDelete={() => deleteTake(take.id)}
                />
              ))}
          </div>
        )}
      </section>
    </main>
  )
}
