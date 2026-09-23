# 试镜采集台（Audition Capture Bench）

纯前端的试镜采集台：授权摄像头与麦克风后，对一个 take 执行**开始 / 暂停 / 继续 / 停止**，停止后形成成片，可回放、选为交付版并下载。支持三种采集模式：**音视频（默认）/ 仅视频 / 仅音频**，仅空闲时可切换。录制过程中导演可以给值得回看的瞬间**打标记（短标签）**，标记按排除暂停的实际录制时长定位，停止后随成片冻结并在回放列表中一键跳转。

- **无后端、无任何在线服务**：Vite 构建为纯静态文件，nginx 只负责托管。
- **成片不持久化**：take 仅以 `Blob` + `blob:` 对象 URL 存在于当前页面内存，刷新或关闭即清空；删除 take 或卸载页面会释放轨道与对象 URL。
- **安全上下文**：浏览器只在 `https://` 或 `http://localhost`（含 `127.0.0.1`）下授予摄像头/麦克风。容器映射到本机后请用 `http://localhost:${WEB_PORT}` 访问；跨机访问请在前置反代上终止 TLS。

## 快速开始（本地开发）

```bash
npm ci
npm run dev        # http://localhost:5173
```

其它脚本：

```bash
npm test           # Vitest 跑全部单测（含媒体替身交错用例）
npm run typecheck  # 仅类型检查
npm run build      # tsc -b && vite build -> dist/
npm run verify     # 测试 + 类型检查 + 构建（一次性验收）
npm run preview    # 本地预览构建产物
```

## Docker Compose

`WEB_PORT` 是**可覆盖**的宿主机托管端口（默认 `8080`，容器内固定 80）：

```bash
docker compose up --build                 # http://localhost:8080
WEB_PORT=9000 docker compose up --build    # http://localhost:9000
```

一次性验收服务 `verify`（挂在 `verify` profile 下，普通 `up` 不会启动；跑完即退出，退出码即验收结论）：

```bash
docker compose --profile verify build verify
docker compose --profile verify run --rm verify
# 等价于容器内执行：npm run verify  -> vitest run && tsc --noEmit && vite build
```

## 采集模式与编码探测

三种模式**独立**按顺序探测，选择各组首个受支持项：

| 模式 | 探测顺序 |
| --- | --- |
| 音视频（默认） | `video/webm;codecs=vp9,opus` → `video/webm;codecs=vp8,opus` → `video/webm` |
| 仅视频 | `video/webm;codecs=vp9` → `video/webm;codecs=vp8` → `video/webm` |
| 仅音频 | `audio/webm;codecs=opus` → `audio/webm` |

- 某组候选全部不可用时**只禁用该模式**（界面标注“不可用”），不影响其它模式；选中被禁用模式开拍会报 `codec-unsupported`，**不会取设备，也不改动任何旧 take / 交付选择**。
- 只有 `idle` 可切换模式；点击“开始 take”会在**申请权限之前**冻结模式、MIME 与相关设备并进入 `starting`，直到回到 `idle` 才解锁。等待授权期间重复开始、切换模式或设备都无法让取流约束、录制参数与成片类型漂移。
- **授权弹窗未决可取消**：`starting` 期间停止入口显示为“取消”且始终可用。取消是确定结局——立即回 `idle`、不产生成片、不报错；迟到的授权结果（无论放行还是拒绝）其流会被立即释放并丢弃，随后可改模式/设备重拍。
- **时长冻结在停止/中断时刻**：成片 `durationMs` 在用户停止或设备轨道 `ended` 的一瞬间冻结，排除授权等待、全部暂停段与编码器封装等待（`stop` 事件晚到多久都不影响素材长度）；暂停中停止不会重复累计已录片段。
- 采集计划只请求所需轨道：仅音频传 `video:false`、仅视频传 `audio:false`，不相关的设备选择不进入约束；因此缺少无关设备（如仅视频时没有麦克风）不算失败。
- take 保存采集模式与**实际** MIME：仅音频成片用 `<audio>` 回放，其余用 `<video>`；下载始终指向当前所选交付 take 的对象 URL。

## 瞬间标记（markers）

录制中可随时给值得回看的瞬间写入一条短标签（≤ 40 字，自动 trim；空白/超长被拒绝并即时提示）。

- **只在 `recording` 态可写**：等待授权（`starting`）、**已暂停（`paused`）**、正在收尾（`stopping`）以及未开拍/已结束（`idle`）都会被拒绝并给出**明确的不可标记提示**，输入框与按钮同步禁用；不产生任何录制状态变化。
- **时间取“有效时钟”**：标记时间戳与成片 `durationMs` 同源（扣除全部暂停段、授权等待与封装等待），因此暂停、设备中断、停止封装慢都**不会让标记漂移**。
- **同毫秒保序**：同一毫秒内连续打下的标记按会话内自增序号（`seq`）保留创建次序，冻结后按 `(timeMs, seq)` 稳定排序。
- **停止即冻结**：用户停止成功后，标记与该 take 的 `Blob`、时长一起冻结到 `take.markers`；**停止超时（兜底强制收尾）或设备中断**时，按停止/中断瞬间冻结的有效时长裁剪标记（等于边界的保留）。
- **空 Blob 不生成带标记 take**：全程只有空数据导致 `empty-take`/`stop-failed` 时不产生成片，标记随失败丢弃，绝不残留成“孤儿标记”。
- **会话隔离**：标记与 chunk 一样受自增 session 守卫保护——旧 recorder 迟到的 `dataavailable`/`stop`/`error` 事件**绝不能把标记附到新 take**；取消授权、重录都会清空进行中标记视图，切换 take 各用各的冻结副本，互不串扰。
- **回放跳转**：成片卡片列出全部标记（`分:秒.十分之一秒` + 标签），点击即把播放器 `currentTime` 定位到该有效秒点并继续播放；标记时间轴与播放器媒体时间一致。

## 生命周期与交错处理（核心约束）

录制内核见 `src/recorder/CaptureRecorder.ts`，状态机为：

```
idle → starting → recording ⇄ paused → stopping → idle
```

- **重复操作幂等**：非 `idle` 的 `start` 一律忽略（无参 `start` 兼容为音视频）；`pause/resume/stop` 都做状态守卫，重复点击不产生副作用。
- **开拍冻结**：`start` 在申请权限前先冻结模式/MIME/设备并进入 `starting`；授权、取流或 recorder 构造/启动失败时释放刚拿到的新流并回到 `idle`，各模式能力、旧成片与交付选择原样保留。
- **start 失败**：所选模式编码全不支持时根本不取设备；授权拒绝报 `permission-denied`；取流成功但 recorder 构造/启动失败会释放刚拿到的轨道。失败均回到 `idle`，**不破坏已有成片**。
- **chunk 合并**：录制以 250ms timeslice 持续产出；只有非空 chunk 被按到达顺序缓存，空 chunk 丢弃。
- **收到 `stop` 才形成成片**：`dataavailable` 再多也不提前成片；最终 `new Blob(chunks, {type: mimeType})` 生成唯一一个可播放 webm。
- **设备中断只停一次**：任一轨道 `ended` 或 recorder `error` 触发一次停止并把成片原因标为 `device-interrupted`；重复 ended/error 被挡下。有数据则保留成片，零数据则以 `empty-take` 失败。
- **拔掉摄像头 / 尾段晚到**：轨道 ended 与 `dataavailable`/`stop` 交错时，`stop` 事件之前到达的尾段照常并入；`stop()` 对已 `inactive` 的 recorder 抛 `InvalidStateError` 时，内核吞掉异常并用微任务兜底落定，给晚到尾段留窗口；`stop` 之后到达的陈旧事件一律丢弃。因此「最终轨道中断且尾段晚到」只会得到**一个**成片。
- **停止必有结局（不会久留 stopping）**：调用 `stop()` 后统一武装 1000ms（`STOP_FINALIZE_GRACE_MS`）兜底定时器。recorder `stop()` 在 recording/paused 态直接抛错（拒绝停止）、正常返回但始终不发 `stop` 事件、或设备中断后编码器沉默，都会在窗口结束时**强制收尾**：摘掉监听、`stop()` 全部轨道、回 `idle`。窗口内已有非空数据则保留为唯一成片（时长仍冻结在停止/中断时刻），零数据以 `stop-failed`/`empty-take` 失败，**不产生空壳半成品**。真实 `stop` 先到时定时器被清除，二者竞争只落定一次。
- **take 会话隔离**：每条 take 持有自增 session，旧 recorder 的迟到事件通过 session 守卫丢弃，**旧事件不能改变新 take**。
- **资源释放**：每次停止/中断/取消都 `stop()` 全部轨道（取消发生在授权未决时则释放迟到授权返回的流）并摘掉事件监听；删除 take 撤销其对象 URL；组件卸载（页面关闭）执行 `dispose()` 停轨并撤销所有 URL。
- **下载一致性**：下载直接使用所选 take 的对象 URL（指向 `take.blob` 本身），下载内容与所选交付版逐字节一致。

## 测试

Vitest + jsdom + Testing Library。`src/test/fakes.ts` 提供可精确编排事件顺序的媒体替身（`emitData` / `emitEmptyData` / `emitStop` / `emitError` / 轨道 `emitEnded`、可模拟 `stop()` 对 inactive 或任意状态抛错、按约束产轨、`missingKinds` 缺设备、`controllableGetUserMedia` 可控权限 Promise 等）；`src/test/virtualClock.ts` 提供同时驱动 `now()` 与兜底定时器的虚拟时钟（`advance`/`pendingCount`）。覆盖：

- 三种模式各自的编码探测顺序、回退与模式隔离（某组全不可用只禁用该模式）；
- **纯 `audio/webm` 环境**、视频编码不可用时的模式隔离；
- 仅音频 `video:false` / 仅视频 `audio:false` 的取流约束与 take 模式、实际 MIME；
- **授权等待期间（starting）冻结**：重复开始、切模式/设备不改变取流约束、录制参数与成片类型，回 idle 才解锁；
- **授权未决时取消**（可控权限 Promise）：立即回 idle、无成片无错误，迟到 grant/deny 的流被释放，旧 take 与交付选择保留，可立即改模式重拍（内核 + hook + UI 三层）；
- 麦克风物理不可用时仅视频仍能成片、回放与下载；
- chunk 顺序合并、空 chunk 丢弃、收到 stop 才成片；
- 暂停/继续时长；**暂停中停止**只计已录段、不重复累计、暂停与封装等待均排除；
- 重复 start/pause/resume/stop；
- 授权拒绝、recorder 构造/启动失败的资源释放与旧成片/交付选择保留；
- 轨道 ended、recorder error 的单次停止与原因标注；无数据中断失败；
- **尾段在 stop 前后交错**、stop 后陈旧事件丢弃、旧 take 事件不污染新 take；
- 设备中断 + inactive `InvalidStateError` 的微任务兜底（仍只产出一个成片）；
- **延迟结束 / 停止抛错 / 无结束事件**（虚拟时钟 + 伪 MediaRecorder）：封装等待不计入时长，兜底窗口后强制回 idle、释放全部轨道，有数据保留唯一一个成片、零数据报 `stop-failed`，且可立即再录；
- 真实 stop 与兜底定时器竞争只落定一次；starting 中 dispose 后迟到授权流被释放；
- 删除/卸载释放对象 URL 与轨道；
- hook 层：仅空闲可切换设备与模式、授权失败不毁旧成片、新拍失败保留已选交付版；
- **瞬间标记（内核 + hook + 页面三层）**：
  - 有效时钟：暂停/继续边界上标记时间不含暂停段（虚拟时钟推进暂停 8 秒后标记不漂移）；
  - 同毫秒多次标记按 `seq` 创建次序保留（内核断言 `(timeMs, seq)`，页面断言回放列表次序）；
  - 写入守卫：`idle`/`starting`（等待权限）/`paused`/`stopping` 各状态均被明确拒绝，空白/超长标签拒绝，UI 按钮禁用与提示文案可见；
  - 停止冻结：用户停止后标记随 take 冻结、进行中列表清空；`stop`/`dataavailable` 乱序不改变标记；
  - 停止超时（永不发 stop，兜底窗口强制收尾）按冻结有效时长保留标记；设备中断走 `device-interrupted` 并按中断时刻裁剪；时钟回拨的越界标记防御性裁剪、边界值保留；
  - 空 Blob（仅零字节 / 无数据中断）不生成带标记 take，标记随失败丢弃；
  - 会话隔离：旧 take 迟到事件不能把标记附到新 take；取消授权、设备中断后重录、切换 take 均不串标记，跨会话标记 id 不冲突；
  - 页面测试核对标记与播放器时间同步：点击回放列表跳转按钮后 `<video>.currentTime` 精确等于标记秒点（2.0s / 4.5s / 1.5s 等），切换 take 只联动自己的播放器。

## 目录结构

```
src/
  recorder/CaptureRecorder.ts     # 无 React 依赖的录制状态机内核
  hooks/useAuditionRecorder.ts    # 设备枚举、take/URL 内存管理、预览复用单流
  App.tsx / styles.css            # 采集台界面
  test/                           # 媒体替身、虚拟时钟、harness、setup
```
