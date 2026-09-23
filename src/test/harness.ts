/** 构造一个带可控时钟与 URL 记账的录制器 */
import {
  CaptureError,
  CaptureRecorder,
  type MediaRecorderLikeCtor,
  type StopReason,
  type Take,
  type TakeMarker,
} from '../recorder/CaptureRecorder'
import {
  controllableGetUserMedia,
  FakeMediaRecorder,
  fakeGetUserMediaFactory,
  type ControllableMedia,
  type CreatedSession,
} from './fakes'
import { createVirtualClock, type VirtualClock } from './virtualClock'

export interface Harness {
  recorder: CaptureRecorder
  sessions: CreatedSession[]
  takes: Take[]
  errors: CaptureError[]
  statuses: string[]
  settlements: Array<{ reason: StopReason; error?: CaptureError }>
  urls: Map<string, Blob>
  /**
   * onLiveMarkersChange 每次广播的快照序列：新增时为新数组、
   * 停止/取消/失败/卸载时为空数组。用于验证“会话结束即清空、不串会话”。
   */
  liveMarkerSnapshots: TakeMarker[][]
  /** 最近一次进行中标记广播快照 */
  liveMarkers: () => TakeMarker[]
  /** 虚拟时钟：nowMs 读写虚拟时间，advance 推进并触发兜底定时器 */
  clock: VirtualClock
  /** 手动授权模式下的取流控制器 */
  media: ControllableMedia
  /** 所有取流调用收到的约束 */
  calls: MediaStreamConstraints[]
  flush: () => Promise<void>
  lastRecorder: () => FakeMediaRecorder
}

export function makeHarness(getUserMediaOpts?: {
  reject?: Error
  missingKinds?: Array<'audio' | 'video'>
  /** true：getUserMedia 不自动落定，用 h.media.grant()/deny() 手动控制 */
  manualPermissions?: boolean
}): Harness {
  const factory = fakeGetUserMediaFactory({
    reject: getUserMediaOpts?.reject,
    missingKinds: getUserMediaOpts?.missingKinds,
  })
  const media = controllableGetUserMedia()
  const takes: Take[] = []
  const errors: CaptureError[] = []
  const statuses: string[] = []
  const settlements: Harness['settlements'] = []
  const liveMarkerSnapshots: TakeMarker[][] = []
  const urls = new Map<string, Blob>()
  const clock = createVirtualClock(1000)
  const calls: MediaStreamConstraints[] = []
  const manual = getUserMediaOpts?.manualPermissions === true

  const recorder = new CaptureRecorder(
    {
      onStatusChange: (s) => statuses.push(s),
      onTake: (t) => takes.push(t),
      onError: (e) => errors.push(e),
      onSettled: (reason, error) =>
        settlements.push({ reason, error }),
      onLiveMarkersChange: (markers) => {
        // 保存快照内容而非引用：内核每次都传新数组，这里再拷一层避免
        // 后续会话复用同一引用导致历史快照被改写
        liveMarkerSnapshots.push(markers.slice())
      },
    },
    {
      MediaRecorder:
        FakeMediaRecorder as unknown as MediaRecorderLikeCtor,
      // 立即落定模式由 factory 产流；手动模式授权 Promise 由测试控制
      getUserMedia: manual
        ? media.getUserMedia
        : (constraints) => {
            calls.push(constraints)
            return factory.getUserMedia(constraints)
          },
      createObjectURL: (blob) => {
        const url = `blob:h/${urls.size + 1}`
        urls.set(url, blob)
        return url
      },
      revokeObjectURL: (url) => {
        urls.delete(url)
      },
      now: () => clock.nowMs,
      randomId: () => `take-${takes.length + 1}`,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  )

  return {
    recorder,
    // 手动模式会话在 media.sessions；立即模式在 factory.sessions
    get sessions() {
      return manual ? media.sessions : factory.sessions
    },
    takes,
    errors,
    statuses,
    settlements,
    liveMarkerSnapshots,
    liveMarkers: () =>
      liveMarkerSnapshots[liveMarkerSnapshots.length - 1] ?? [],
    urls,
    clock,
    media,
    get calls() {
      return manual ? media.calls : calls
    },
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    lastRecorder: () =>
      FakeMediaRecorder.instances[
        FakeMediaRecorder.instances.length - 1
      ],
  }
}

/** 读取合并后 Blob 的文本（setup 已将全局 Blob 换为支持嵌套的 Node Blob） */
export async function readBlob(blob: Blob): Promise<string> {
  return blob.text()
}
