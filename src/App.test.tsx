import { describe, expect, it, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { FakeMediaRecorder, FakeTrack } from './test/fakes'
import { STOP_FINALIZE_GRACE_MS } from './recorder/CaptureRecorder'

/**
 * UI 层测试：下载按钮使用“当前所选交付版”；三种模式的切换/禁用、
 * 授权等待期间冻结、仅音频用 <audio> 回放、无麦克风时仅视频仍可成片下载。
 */

interface Pending {
  constraints?: MediaStreamConstraints
  resolve: (stream: MediaStream) => void
  reject: (err: unknown) => void
}

function installGlobals(opts?: {
  manualPermissions?: boolean
  missingKinds?: Array<'audio' | 'video'>
}) {
  const pending: Pending[] = []
  const missing = new Set(opts?.missingKinds ?? [])

  const tracksFor = (constraints?: MediaStreamConstraints): FakeTrack[] => {
    const tracks: FakeTrack[] = []
    if (constraints?.video !== false) {
      if (missing.has('video')) {
        throw new DOMException('no cam', 'NotFoundError')
      }
      tracks.push(new FakeTrack('video'))
    }
    if (constraints?.audio !== false) {
      if (missing.has('audio')) {
        throw new DOMException('no mic', 'NotFoundError')
      }
      tracks.push(new FakeTrack('audio'))
    }
    return tracks
  }

  const enumerateDevices = vi.fn(async () => [
    { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A', toJSON() {} },
    { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A', toJSON() {} },
  ])
  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints) => {
    if (opts?.manualPermissions) {
      return new Promise<MediaStream>((resolve, reject) => {
        pending.push({ constraints, resolve, reject })
      })
    }
    try {
      const tracks = tracksFor(constraints)
      return Promise.resolve({
        getTracks: () => tracks,
      } as unknown as MediaStream)
    } catch (err) {
      return Promise.reject(err)
    }
  })

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      enumerateDevices,
      getUserMedia,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })

  return {
    enumerateDevices,
    getUserMedia,
    pending,
    grant: () => {
      const item = pending.shift()
      if (!item) throw new Error('无等待中的授权')
      const tracks = tracksFor(item.constraints)
      item.resolve({ getTracks: () => tracks } as unknown as MediaStream)
    },
    deny: () =>
      pending
        .shift()
        ?.reject(new DOMException('denied', 'NotAllowedError')),
  }
}

/** 录制一条成片并停止，返回该 take 的 recorder 替身 */
async function shootAndStop(modeLabel?: string) {
  if (modeLabel) {
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(modeLabel) }))
    })
  }
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
  })
  const rec = FakeMediaRecorder.instances[
    FakeMediaRecorder.instances.length - 1
  ]
  await act(async () => {
    rec.emitData(['take-data'])
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    rec.emitStop()
    await Promise.resolve()
    await Promise.resolve()
  })
  return rec
}

describe('下载交付版一致性', () => {
  let stubs: ReturnType<typeof vi.spyOn>[] = []

  // 用 beforeAll/afterAll 而非 beforeEach：RTL 的 afterEach 清理在本文件
  // afterEach 之后执行，卸载时仍需这些 jsdom 缺失方法的桩
  beforeAll(() => {
    stubs = [
      vi
        .spyOn(HTMLMediaElement.prototype, 'play')
        .mockImplementation(() => Promise.resolve()),
      vi
        .spyOn(HTMLMediaElement.prototype, 'pause')
        .mockImplementation(() => undefined),
      vi
        .spyOn(HTMLMediaElement.prototype, 'load')
        .mockImplementation(() => undefined),
    ]
  })

  afterAll(() => {
    stubs.forEach((s) => s.mockRestore())
  })

  beforeEach(() => {
    FakeMediaRecorder.reset()
    installGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('把 B 选为交付版后点击下载，下载链接指向 B 的对象 URL 而非列表首条 A', async () => {
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    await shootAndStop() // take A
    await shootAndStop() // take B

    // 列表按时间倒序渲染：第一张卡片是最新的 B，第二张是 A
    const takeVideos = Array.from(
      document.querySelectorAll<HTMLVideoElement>('video.take-video'),
    )
    expect(takeVideos).toHaveLength(2)
    const urlB = takeVideos[0].src
    const urlA = takeVideos[1].src
    expect(urlB).not.toBe(urlA)

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '选为交付版' })[0])
    })

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const created: HTMLAnchorElement[] = []
    const appendSpy = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation((node) => {
        created.push(node as HTMLAnchorElement)
        return node as never
      })

    fireEvent.click(screen.getByRole('button', { name: '下载交付版' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
    // 下载目标必须是当前标记的交付版 B，而不是列表首条 A
    expect(created[0].href).toBe(urlB)
    expect(created[0].href).not.toBe(urlA)

    clickSpy.mockRestore()
    appendSpy.mockRestore()
  })
})

describe('模式切换与 MIME 能力隔离（UI）', () => {
  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
      Promise.resolve(),
    )
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined,
    )
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
      () => undefined,
    )
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    FakeMediaRecorder.reset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('默认音视频；三模式单选可在空闲切换，录制相关控件在 starting 冻结', async () => {
    const g = installGlobals({ manualPermissions: true })
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    const avRadio = screen.getByRole('radio', { name: /音视频/ })
    const videoRadio = screen.getByRole('radio', { name: /仅视频/ })
    const audioRadio = screen.getByRole('radio', { name: /仅音频/ })
    expect((avRadio as HTMLInputElement).checked).toBe(true)

    fireEvent.click(videoRadio)
    expect((videoRadio as HTMLInputElement).checked).toBe(true)
    fireEvent.click(audioRadio)
    expect((audioRadio as HTMLInputElement).checked).toBe(true)
    fireEvent.click(avRadio)
    expect((avRadio as HTMLInputElement).checked).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    // 已进入 starting：模式/设备/开拍按钮全部冻结
    expect(
      (
        screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect((avRadio as HTMLInputElement).disabled).toBe(true)
    expect((videoRadio as HTMLInputElement).disabled).toBe(true)
    expect((audioRadio as HTMLInputElement).disabled).toBe(true)

    // 授权等待期间点击无效
    fireEvent.click(audioRadio)
    fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    expect(g.getUserMedia).toHaveBeenCalledTimes(1)

    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('video/webm;codecs=vp9,opus')

    await act(async () => {
      rec.emitData(['frozen-ui'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 回 idle 解锁
    await waitFor(() => expect((avRadio as HTMLInputElement).disabled).toBe(false))
  })

  it('纯 audio/webm 环境：两个视频模式禁用并标注不可用，仅音频成片用 <audio> 回放', async () => {
    // 能力在挂载时探测：先布置环境再渲染
    FakeMediaRecorder.supported = ['audio/webm']
    installGlobals()
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('radio', { name: /仅音频/ }) as HTMLInputElement)
          .disabled,
      ).toBe(false),
    )

    const avRadio = screen.getByRole('radio', { name: /音视频/ })
    const videoRadio = screen.getByRole('radio', { name: /仅视频/ })
    const audioRadio = screen.getByRole('radio', { name: /仅音频/ })
    expect((avRadio as HTMLInputElement).disabled).toBe(true)
    expect((videoRadio as HTMLInputElement).disabled).toBe(true)
    expect((audioRadio as HTMLInputElement).disabled).toBe(false)
    expect(
      (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    fireEvent.click(audioRadio)
    expect((audioRadio as HTMLInputElement).checked).toBe(true)
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    )
    expect(screen.getByText('audio/webm')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('audio/webm')
    await act(async () => {
      rec.emitData(['sound'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })

    // 仅音频成片以 <audio> 回放，页面没有成片 <video>
    const audioEl = document.querySelector('audio.take-audio')
    expect(audioEl).toBeTruthy()
    expect(document.querySelectorAll('video.take-video')).toHaveLength(0)
    expect((audioEl as HTMLAudioElement).src).toContain('blob:')
  })

  it('麦克风不可用时仅视频仍能成片、回放并下载所选 take', async () => {
    installGlobals({ missingKinds: ['audio'] })
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    fireEvent.click(screen.getByRole('radio', { name: /仅视频/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    // 无错误提示、无授权弹窗残留：audio:false 直接成功
    expect(screen.queryByRole('alert')).toBeNull()

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('video/webm;codecs=vp9')
    await act(async () => {
      rec.emitData(['vision'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })

    const takeVideo = document.querySelector(
      'video.take-video',
    ) as HTMLVideoElement
    expect(takeVideo).toBeTruthy()
    const takeUrl = takeVideo.src

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const created: HTMLAnchorElement[] = []
    const appendSpy = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation((node) => {
        created.push(node as HTMLAnchorElement)
        return node as never
      })

    fireEvent.click(screen.getByRole('button', { name: '下载交付版' }))
    expect(created).toHaveLength(1)
    expect(created[0].href).toBe(takeUrl)

    clickSpy.mockRestore()
    appendSpy.mockRestore()
  })
})

describe('授权未决时取消（UI）', () => {
  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
      Promise.resolve(),
    )
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined,
    )
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
      () => undefined,
    )
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    FakeMediaRecorder.reset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('授权弹窗未决时停止入口可用（显示“取消”），取消后可靠回到可再次录制状态', async () => {
    const g = installGlobals({ manualPermissions: true })
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    fireEvent.click(screen.getByRole('radio', { name: /仅音频/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    expect(g.pending).toHaveLength(1)

    // 停止入口在授权未决时可用并呈现“取消”
    const cancelBtn = screen.getByRole('button', { name: '取消本次开拍' })
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(false)

    await act(async () => {
      fireEvent.click(cancelBtn)
    })

    // 无成片、无错误、状态回空闲
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      document.querySelectorAll('video.take-video, audio.take-audio'),
    ).toHaveLength(0)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    // 模式切换解锁
    expect(
      (screen.getByRole('radio', { name: /音视频/ }) as HTMLInputElement)
        .disabled,
    ).toBe(false)

    // 迟到的授权结果被吞掉；随后可正常再录一条
    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    expect(FakeMediaRecorder.instances).toHaveLength(0)

    fireEvent.click(screen.getByRole('radio', { name: /音视频/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
      g.grant()
      await Promise.resolve()
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    expect(rec.mimeType).toBe('video/webm;codecs=vp9,opus')
    await act(async () => {
      rec.emitData(['retry'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelectorAll('video.take-video')).toHaveLength(1)
  })
})

describe('瞬间标记（页面）', () => {
  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
      Promise.resolve(),
    )
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined,
    )
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
      () => undefined,
    )
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    FakeMediaRecorder.reset()
    installGlobals()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** 输入标签并点击“打标记” */
  function mark(label: string) {
    fireEvent.change(screen.getByLabelText('瞬间标记标签'), {
      target: { value: label },
    })
    fireEvent.click(screen.getByRole('button', { name: '打标记' }))
  }

  /** 当前成片卡片（倒序，最新一张在最前）的播放器 */
  function takeVideo(index = 0): HTMLVideoElement {
    const els = Array.from(
      document.querySelectorAll<HTMLVideoElement>('video.take-video'),
    )
    return els[index] as HTMLVideoElement
  }

  it('录制中可打标并即时显示；非录制状态按钮禁用且给出明确不可标记提示', async () => {
    vi.useFakeTimers()
    render(<App />)
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })

    // idle：未开拍，打标禁用，提示“当前未在录制”
    const markerBtn = screen.getByRole('button', { name: '打标记' })
    const markerInput = screen.getByLabelText('瞬间标记标签')
    expect((markerBtn as HTMLButtonElement).disabled).toBe(true)
    expect((markerInput as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId('marker-blocked-hint').textContent).toContain(
      '当前未在录制',
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
      await Promise.resolve()
    })
    expect((markerBtn as HTMLButtonElement).disabled).toBe(false)

    // 录制 1200ms 后打标
    await act(async () => {
      vi.advanceTimersByTime(1200)
    })
    act(() => mark('第一次笑场'))
    expect(
      Array.from(document.querySelectorAll('.live-marker')).some((li) =>
        li.textContent?.includes('笑场'),
      ),
    ).toBe(true)

    // 暂停：打标禁用 + 明确暂停提示
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '暂停' }))
      vi.advanceTimersByTime(9000) // 暂停 9 秒
    })
    expect((markerBtn as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('marker-blocked-hint').textContent).toContain(
      '已暂停',
    )

    // 继续 300ms 后再打标，时间不应包含暂停段
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '继续' }))
      vi.advanceTimersByTime(300)
    })
    act(() => mark('继续后的亮点'))
    const liveTexts = Array.from(
      document.querySelectorAll('.live-marker'),
    ).map((li) => li.textContent)
    expect(liveTexts.some((t) => t?.includes('00:01.2'))).toBe(true)
    expect(liveTexts.some((t) => t?.includes('00:01.5'))).toBe(true)
    expect(liveTexts.some((t) => t?.includes('00:10'))).toBe(false)

    // 停止（收尾态短暂存在也不允许打标），落定后回到“当前未在录制”
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    act(() => {
      rec.emitData(['clip'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
    })
    expect(screen.getByTestId('marker-blocked-hint').textContent).toContain(
      '正在收尾',
    )
    expect((screen.getByRole('button', { name: '打标记' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      rec.emitStop()
      vi.advanceTimersByTime(STOP_FINALIZE_GRACE_MS + 10)
      await Promise.resolve()
    })
    expect(screen.getByTestId('marker-blocked-hint').textContent).toContain(
      '当前未在录制',
    )
    // 进行中列表消失，标记进入成片卡片
    expect(document.querySelectorAll('.live-marker')).toHaveLength(0)
  })

  it('空白标签被明确拒绝（不新增标记、不影响录制）', async () => {
    vi.useFakeTimers()
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
      await Promise.resolve()
    })
    act(() => {
      fireEvent.change(screen.getByLabelText('瞬间标记标签'), {
        target: { value: '   ' },
      })
      fireEvent.click(screen.getByRole('button', { name: '打标记' }))
    })
    expect(screen.getByRole('alert').textContent).toContain('不能为空')
    expect(document.querySelectorAll('.live-marker')).toHaveLength(0)
  })

  it('停止后标记列在回放卡片中：点击跳转把播放器 currentTime 定位到标记秒点（与播放器时间同步）', async () => {
    vi.useFakeTimers()
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
      await Promise.resolve()
    })

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    act(() => mark('两秒处'))
    await act(async () => {
      vi.advanceTimersByTime(2500)
    })
    act(() => mark('四点五秒处'))

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['video-bytes'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      vi.advanceTimersByTime(STOP_FINALIZE_GRACE_MS + 10)
      await Promise.resolve()
    })

    const video = takeVideo(0)
    // 卡片中的跳转按钮，时间标签与录制有效时长一致
    const jump2 = screen.getByRole('button', {
      name: /跳转到 00:02.0 的标记：两秒处/,
    })
    const jump45 = screen.getByRole('button', {
      name: '跳转到 00:04.5 的标记：四点五秒处',
    })
    expect(jump2).toBeTruthy()
    expect(jump45).toBeTruthy()

    // 点击跳转：播放器 currentTime 精确同步到标记的有效时间（秒）
    act(() => {
      fireEvent.click(jump45)
    })
    expect(video.currentTime).toBeCloseTo(4.5, 5)

    act(() => {
      fireEvent.click(jump2)
    })
    expect(video.currentTime).toBeCloseTo(2.0, 5)
  })

  it('同一毫秒两个标记：回放列表都保留，按创建次序排列且各自可跳转', async () => {
    vi.useFakeTimers()
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    act(() => mark('同毫秒甲'))
    act(() => mark('同毫秒乙'))

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['same-ms'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      vi.advanceTimersByTime(STOP_FINALIZE_GRACE_MS + 10)
      await Promise.resolve()
    })

    const video = takeVideo(0)
    const card = video.closest('.take-card') as HTMLElement
    const labels = Array.from(
      card.querySelectorAll('.marker-jump-btn .marker-label-text'),
    ).map((el) => el.textContent)
    expect(labels).toEqual(['同毫秒甲', '同毫秒乙'])
    const times = Array.from(card.querySelectorAll('.marker-jump-btn time')).map(
      (el) => el.textContent,
    )
    expect(times).toEqual(['00:03.0', '00:03.0'])

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /跳转到 00:03.0 的标记：同毫秒乙/ }),
      )
    })
    expect(video.currentTime).toBeCloseTo(3.0, 5)
  })

  it('暂停边界：暂停期间不计入标记时间，恢复后继续累积；成片时长与标记时间一致', async () => {
    vi.useFakeTimers()
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    act(() => mark('暂停前'))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(8000)
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '继续' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    act(() => mark('继续后'))

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['pause-edge-ui'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      vi.advanceTimersByTime(STOP_FINALIZE_GRACE_MS + 10)
      await Promise.resolve()
    })

    const video = takeVideo(0)
    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /跳转到 00:01.5 的标记：继续后/ }),
      )
    })
    expect(video.currentTime).toBeCloseTo(1.5, 5)
    // 时长同样排除了暂停段（1.0 + 0.5 = 1.5s）
    const info = (video.closest('.take-card') as HTMLElement).querySelector(
      '.take-info',
    )?.textContent
    expect(info).toContain('00:02')
  })

  it('切换 take 不串标记：两个成片各自只显示并跳转到自己的标记', async () => {
    vi.useFakeTimers()
    render(<App />)

    // take A：在 1s 打标
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
      await Promise.resolve()
      vi.advanceTimersByTime(1000)
    })
    act(() => mark('A 的标记'))
    let rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['a'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      vi.advanceTimersByTime(STOP_FINALIZE_GRACE_MS + 10)
      await Promise.resolve()
    })

    // take B：在 4s 打标（不同标签、不同时间）
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
      await Promise.resolve()
      vi.advanceTimersByTime(4000)
    })
    act(() => mark('B 的标记'))
    rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['b'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      vi.advanceTimersByTime(STOP_FINALIZE_GRACE_MS + 10)
      await Promise.resolve()
    })

    // 倒序渲染：卡片 0 = B（最新），卡片 1 = A
    const videoB = takeVideo(0)
    const videoA = takeVideo(1)
    const cardB = videoB.closest('.take-card') as HTMLElement
    const cardA = videoA.closest('.take-card') as HTMLElement

    expect(
      cardB.querySelector('.marker-label-text')?.textContent,
    ).toBe('B 的标记')
    expect(
      cardA.querySelector('.marker-label-text')?.textContent,
    ).toBe('A 的标记')

    act(() => {
      fireEvent.click(
        cardA.querySelector('.marker-jump-btn') as HTMLButtonElement,
      )
    })
    expect(videoA.currentTime).toBeCloseTo(1.0, 5)
    expect(videoB.currentTime).toBe(0) // B 的播放器未被联动

    act(() => {
      fireEvent.click(
        cardB.querySelector('.marker-jump-btn') as HTMLButtonElement,
      )
    })
    expect(videoB.currentTime).toBeCloseTo(4.0, 5)
    expect(videoA.currentTime).toBeCloseTo(1.0, 5) // A 停在原处
  })

  it('设备中断后重录：中断成片保留中断前标记，重录成片不继承旧标记', async () => {
    render(<App />)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '开始 take' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    act(() => mark('中断瞬间'))
    // 模拟拔掉摄像头：轨道 ended 触发 device-interrupted 自动停止
    const firstRecorder = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      firstRecorder.emitData(['before-pull'])
      // installGlobals 的 take 没暴露轨道，这里用 recorder error 走同一中断路径
      firstRecorder.emitError({ name: 'UnknownError', message: 'device gone' })
      firstRecorder.emitData(['tail'])
      firstRecorder.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })

    // 中断成片带标记与“设备中断”标注
    const videosAfterFirst = document.querySelectorAll('video.take-video')
    expect(videosAfterFirst).toHaveLength(1)
    const card1 = videosAfterFirst[0].closest('.take-card') as HTMLElement
    expect(
      card1.querySelector('.marker-label-text')?.textContent,
    ).toBe('中断瞬间')
    expect(card1.querySelector('.reason-device-interrupted')).toBeTruthy()
    // 中断落定后进行中标记区清空
    expect(document.querySelectorAll('.live-marker')).toHaveLength(0)

    // 重录一条：打新标记后停止
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    act(() => mark('重录瞬间'))
    const secondRecorder = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      secondRecorder.emitData(['retry'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      secondRecorder.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })

    const cards = Array.from(document.querySelectorAll('.take-card'))
    expect(cards).toHaveLength(2)
    // 倒序：0 = 重录，1 = 中断
    expect(
      cards[0].querySelector('.marker-label-text')?.textContent,
    ).toBe('重录瞬间')
    expect(
      cards[1].querySelector('.marker-label-text')?.textContent,
    ).toBe('中断瞬间')
    // 重录卡片只有自己的 1 个标记按钮
    expect(cards[0].querySelectorAll('.marker-jump-btn')).toHaveLength(1)
    expect(cards[1].querySelectorAll('.marker-jump-btn')).toHaveLength(1)
  })
})
