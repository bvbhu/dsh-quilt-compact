# dsh-quilt-compact

> 中文 | [English](README.en.md)

DeepSeek Harness 的分层模型池摘要后端——`dsh-compaction-basic` 的
`compaction` 服务替代实现。

插件处理一次压缩区域的方式：先做 Stage 0 预处理，切成带重叠的分块，每个
分块经由配置好的模型池（tiers、单模型并发与冷却）摘要，最后把各分块的摘要
归并回一个检查点。模型调用失败会让该模型冷却一段配置时长（或每日重置窗口）；
某 tier 的模型全部冷却时降级到下一 tier；所有 tier 都冷却时，由会话模型兜底
（可关闭），或让压缩失败进入内置的 `compaction/summary-error` 恢复流程。

> 本包独立开发，**尚未**安装进任何 DSH profile。准备好后再激活（见
> [安装激活](#安装激活)）。

本包以 DSH **bundle** 形式发布：`package.json` 声明了 `dsh.bundle.patch`，
因此 `dsh plugin add` 会自动激活随包附带的
[`cordis.patch.yml`](cordis.patch.yml) 层。

## 目录

- [工作原理](#工作原理)
- [配置](#配置)
- [持久化](#持久化)
- [运行记录（压缩质量评估）](#运行记录压缩质量评估)
- [保真度基准（test/bench）](#保真度基准testbench)
- [隐私](#隐私)
- [可观测性（日志）](#可观测性日志)
- [包结构](#包结构)
- [开发与测试](#开发与测试)
- [安装激活](#安装激活)
- [卸载](#卸载)
- [官方插件指南对照](#官方插件指南对照)
- [兼容性检查](#兼容性检查)

## 工作原理

一次压缩运行（无论触发方式：步进压力、上下文溢出、手动 `compactNow` 或
`compactRegion`）产生一个持久化事务：

```
compaction/start → summarize → compaction/summary → user/message (replace) → compaction/end
```

摘要器本身：

1. **0a** — 把区域消息展平为行文档；合并相邻重复行；清除终端噪音（ANSI
   转义、光标标记、长分隔线）；head-middle-tail 截断；跳过空白块。文件与图片
   附件不匿名化成裸 `[file]`/`[image]`：保留附件的 `name`（如
   `[file: src/components/editor/Editor.tsx]`、`[image: screenshot.png]`），
   让 Stage 0 之后的模型仍能看到路径/引用；无名称时退回裸标记。
2. **0b** — 对超过 `maxDepth: 2` 的围栏代码块做 AST 骨架化；对超过
   `maxLines` 的日志长段做冷凝，并保留 `[condensed: N lines removed]` 标记。
3. **0c** — 重叠分块：核心预算 `usableInput × chunkRatio`，其中
   `usableInput = 上下文窗口 − 输出预留 − 指令开销 − 安全余量`
   （输出预留为 `min(32768, 窗口 × 15%)`，重叠 `core × chunkOverlapRatio`，
   切分点对齐整行（优先句末行）。分块是纯计算。为什么不是 `窗口 × chunkRatio`：
   模型的 `contextWindow` 是**输入 + 输出共用的**组合窗口，且 DSH 适配器不会
   自动把 `maxTokens` 收敛进窗口；直接按窗口比例分块会在预留输出 token 后
   静默超限，把"容量不足"误判成"模型故障"进入冷却。所以 `chunkRatio` 意为
   **"可用输入预算的比例"**，而不是窗口的比例。输出预留上限
   `min(32768, 窗口 × 15%)` 与每次调用固定 `maxTokens = 32768` 一致。
   窗口取**主 tier 内已知容量的最小值**（不是最大模型的窗口）：容量感知调度
   只拒绝真的装不下的模型，chunk 规划则保证主 tier 里每个健康模型都装得下
   任意 chunk——1M 主模型旁边放一个 128K 同 tier 模型时，chunk 按 128K 规划，
   而不是造出只有 1M 模型能吃的巨型 chunk。
4. **ModelChain** — 所有分块任务进入同一个调度队列；每个任务在当前 tier 挑
   一个有空闲槽位的健康模型（轮询），tier 内无健康模型时逐级降级；失败时让
   该模型冷却并重新入队。调度还会按**容量**选模型：每个 pool 路由的上下文
   窗口与默认输出上限（`resolveModelInfo`）在每次压缩时解析；任务的估计输入
   token 与模型窗口不匹配时**跳过该模型而不写冷却**（容量不足不是故障），
   tier 内健康模型全部装不下时像全冷 tier 一样降级。**实际发出的 `maxTokens`
   也按同一套容量系统 clamp**：`min(32768, 模型 defaultMaxTokens,
   窗口 − 实际输入 − 指令开销)`——规划用的 15% 是"预期生成空间"，而请求上限
   永远不可能把输入 + 输出推过窗口。所有 tier 都冷却时，整批
   收敛到会话模型兜底：**直接调用默认压缩插件**（`dsh-compaction-basic` 的
   `summarize`），它重放原始会话前缀、在末尾追加压缩指令作为最后一条 user
   消息——即默认的 KV 缓存复用压缩，一次调用覆盖整个区域（单分块足够时即
   一次完成，不经过分块/归并）。兜底关闭时整批抛错，经由区域的
   `compaction/summary-error` 恢复瀑布上抛。
5. **归并（层级）** — 分块摘要重新经过 ModelChain。不再把全部 digest 拼成
   一个巨型归并调用：`mergeDigests` 按可用输入预算把 digest 分组，每组一个
   归并调用，再把结果继续归并，直到剩一个——`N → N/k → … → 1`。每个归并调用
   都经过容量感知调度（装不下的模型会被跳过而非错误投递）。最终检查点会套
   框架（`<compacted-summary>` 标签，与 `dsh-compaction-basic` 相同的前言），
   且必须通过内置校验*摘要 < 被遮蔽区域*才能提交。

取消不算模型失败：中止信号立即传播，绝不写入冷却。

实现要点：

- **单次尝试即上限**：每次 `ctx.llm.stream()` 调用单次尝试（DSH 的
  `retryPolicy` 执行器只作用于 agent 循环内的请求失败——`dsh-llm-retry`）。
  分块调用失败**就是**耗尽边界：写入该模型冷却并把分块换模型重排。插件不
  提供任何重试参数。
- **生成上限**：每次调用的生成上限是常量 `DEFAULT_MAX_TOKENS = 32768`——
  `dsh-llm` 对未配置模型的输出假设（32k），保证打包后的检查点不会在密集
  区域摘要未被截断时悄悄膨胀。
- **自动压缩策略跟随默认插件**：阈值、保留比例、headroom、压缩重试、溢出
  重试全部**运行时读取** `dsh-compaction-basic` 的解析后默认值
  （`readBasicPolicy()`，`lib/default-compression.js`），本插件不固定自己的
  拷贝；`test/unit/policy.test.js` 断言两者一致，防止静默漂移。
- **Stage 0 全部内嵌**：算法在 `lib/stage0/*` 中实现（纯行变换、有单元测试），
  不安装 dsh-dcp/dshx/dsh-context-lens，避免与内置 toolResultPruner/compaction
  接缝双重重叠。
- **冷却两种模式**：`duration`（小时，支持小数）与 `dailyReset`（固定 UTC
  小时），精确数学在 `lib/cooldown.js`。

## 配置

两种配置方式：Web UI 的**设置页**（模型池与调优旋钮）和下面描述的
**profile patch 层**。设置页写入同一个 profile patch，两者等价互换——怎么
方便怎么改。

### 设置页

Web 应用运行时，打开插件页选择 **dsh-quilt-compact**（其 row-config 条目）。
该页编辑：

- **模型池** — 增删 tier、每 tier 增删模型行。provider 与 model 从本安装
  实际配置的模型中选取，绝不手输；已保存但 catalog 中不再存在的路由保持
  可见并标记不可用，便于查看和删除。
- **chunkRatio**、**chunkOverlapRatio**、**fallbackToSessionModel** 与两个
  prompt 后缀。
- **Stage 0 预处理开关**。

设置卡片复刻 `dsh-connect-trae` 的插件卡片：可折叠外壳（标题 + 描述 +
  纯 CSS 箭头——不导入 primitives 图标，因为图标名不是跨 DSH 版本的稳定
  契约）、覆盖四个分区的 tab 栏、只使用 token 样式的表面。它同时注册到
  `plugins.row.config` 与 `plugins.bundle.config`（两个座位各自独立守护）。
  Save 按钮不会因校验错误被禁用：点击会浮出原因；改 provider 会把配套
  model 从新 provider 的第一个模型重新填充，编辑不会让草稿悄悄失效。

页面经由引擎在存在 web server 时注册的设置 bridge
（`/api/dsh-quilt-compact/*`）通信。在 **web/desktop profile** 里引擎运行在
`standard` preset 的 `compaction` 组内，bridge 通过 `configEditor` 写入
`preset-standard` 内的那份拷贝——与官方编辑器相同的持久化路径（
`dsh-settings` 表单无法寻址 preset 组内的行）。在 **headless/sdk profile**
里 bridge 直接写宿主平面行。两种路径写入都无需重启生效：loader 把新值提交
进运行中的 volatile 引用后触发 `loader/volatile-update`，引擎从原始（volatile）
配置**重新解析**出冻结的 resolved config（`reloadConfig()`），随后的压缩即按
新值调度；池路由也会用新 tier 重新校验。校验失败的编辑保留上一次的 resolved
配置并记录 warning，不会让运行中的引擎用坏配置。

### Profile patch 层

bundle 原样附带这层配置（[`cordis.patch.yml`](cordis.patch.yml)）；在你自己
profile 的 `cordis.patch.yml` 里覆盖个别行（后层按行生效，且 patch 是整行
替换 `config` 值而不是深合并——需要什么键就重述什么键）：

```yaml
# 只保留服务条目：包必须保持安装，因为链的会话模型兜底会直接 import 它的 summarize()
- id: compaction-basic
  disabled: true

- insert:
    - id: dsh-quilt-compact
      name: 'dsh-quilt-compact'   # 安装后的包名
      config:
        chunkRatio: 0.8              # 每个分块占「可用输入预算」的比例（可用输入 = 窗口 − 输出预留 − 开销 − 余量）
        chunkOverlapRatio: 0.1       # 相邻分块重叠比例
        fallbackToSessionModel: true # 会话模型兜底（requestHeader().config ?? agent.options）
        chunkPromptSuffix: ''        # 可选，追加到分块 prompt 末尾
        mergePromptSuffix: ''        # 可选，追加到归并 prompt 末尾

        tiers:
          - name: primary
            models:
              - provider: openrouter
                model: openrouter/free
                maxConcurrent: 1
                cooldown: { mode: dailyReset, hour: 0 }

        # 请求重试完全复用 DSH 的 retryPolicy；这里无需配置任何东西

        preprocessing:
          dedup: true
          purgeErrors: true
          astSkeleton: { enabled: true, maxDepth: 2 }
          logCondense: { mode: balanced, maxLines: 200 }
```

`maxConcurrent` 默认为 1。`cooldown` 必填且恰好一种模式：`duration`（正数
`hours`，支持小数）或 `dailyReset`（整数 `hour` 0–23，UTC）。路由键为
`${provider}/${model}`，全池必须唯一。未知键、重复路由、非法冷却在插件加载
时响亮失败。

### 模型池校验

不存在的路由没法工作，而 schema 区分不了真路由和笔误——`provider: trae`
和 `provider: traa` 都只是字符串。所以引擎在加载时把每条池路由与**实时**
模型注册表比对，并在每次设置页编辑后复检：

- `provider` 未注册 → *"provider is not registered"*
- provider 已知、model 不在其 catalog → *"model is not in the provider catalog"*
- provider 已注册但不发布 catalog → *"provider does not publish a model catalog"*
  （放行不强制——provider 可以合法路由而不做广告）

权威来源是 `ctx.llm.listProviders()` + `listModels()`，**不是** profile
文档：provider 由拥有它们的插件在运行时注册（`dsh-llm-pi-ai` 从自己的设置
区块、`dsh-connect-*` 从 `registerAdapter()`），只有注册表知道真实集合。这在
实践中很重要——静态读 profile 会把所有 `trae/*`、`workbuddy/*` 路由误报为
缺失。

校验**只警告并继续**，绝不阻塞挂载。provider 只是注册得慢、或注册表暂时
不可用，都不能让压缩停摆。每条警告都会点名路由与原因，故障仍可诊断。

## 持久化

冷却状态存放在 `dsh_quilt_compact_state` 域（路由到 `json` 后端）。
`dsh-base` 已挂载整条栈（`storage`、`storage-json`（`root:
dshHomePath('storages')`）、`storage-domain`（`backend: json`）），普通
profile 无需额外接线。自定义 base 需要自己挂载：

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: '~/.dsh/storage'
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

状态文件：`<root>/dsh_quilt_compact_state.json`（单一布局）——一张 `routes`
表 `{ "provider/model": { "cooldownUntil": <epoch ms> } }` 加可选的 global。
写入走 zod 校验 + 原子发布；只有冷却**状态转换**才落盘（写入节流）；过期在
读取时懒清理（绝不回写）。

> 域实际落地名是 `dsh_quilt_compact_state`（不是 `dsh-quilt-compact-state`）：
> DSH 的 `UNIT_NAME_RE`（`/^[a-z][a-z0-9_]*$/`）禁止连字符，所以包名按
> 下划线规则改写。`defineDomain` 还拒绝接受 `null` 的 global schema（null 是
> "从不写入"哨兵），故 global 是 `{ schema: { schemaVersion: 1 }, initial:
> { schemaVersion: 1 } }`，首次写入时物化。

如果 storage-domain 形态缺失或打开失败，引擎降级到内存存储并打日志警告，
继续工作。丢失冷却状态可接受：没有记录的路由天然健康，下个请求会重新发现
当前状态。冷却状态**不是**插件配置——插件配置来自 cordis patch 层并在加载
时校验。

> 冷却状态不能存浏览器存储（localStorage / IndexedDB）：本插件运行在 Node
> 宿主平面，与 `ctx.llm`、`ctx.sessions` 平级，而 DSH 只带文件系统 `json`
> 后端。存储 hub 的 `backend.register()` 接缝本可接受自定义后端，但并未提供。

## 运行记录（压缩质量评估）

**默认关闭。** 启用后，每次压缩写入**一行 JSON** 到
`<DSH home>/storages/dsh_quilt_compact_runs.jsonl`（JSONL，追加式；DSH home
按官方规则解析：**非空 `$DSH_HOME` 优先，否则 `~/.dsh`**），供之后回顾
压了什么、压出什么——目的是评估压缩质量，而不只是观察它跑过：

```json
{"at":1790000000000,"trigger":"manual","regionChars":245760,"stage0Lines":120,"chunkCount":6,"mergeLevels":2,"chunkBudget":8192,"overlapTokens":819,"contextWindow":262144,"outputBudget":32768,"usableInput":229376,"route":"openrouter/openrouter/free","fallback":false,"digestChars":1840,"attempts":1,"snapshotChars":20000,"snapshot":"…capped input…","result":"…final digest…"}
```

- `trigger`：`manual`（`/compact`）、`pressure`（自动步进压力）、
  `context-overflow`（provider 确认的溢出恢复）、或 `auto`。
- `snapshot`：重放的会话前缀，截断到 `runRecord.snapshotChars`（头 80% +
  尾 20%，带省略标记；`0` 保留全部）。
- `result`：最终摘要文本（层级归并结果，或 `fallback: true` 时的会话模型
  兜底摘要）。
- `route`/`fallback`/`digestChars`/`attempts` 以及区域/分块统计；
  `mergeLevels` 记录**实际完成**的层级归并层数（0 表示单分块未归并；一个
  因无法合法收缩而坍缩的层级不计入——那一次没有执行任何 merge 调用）；
  `fallbackReason` 说明 `fallback: true` 的原因（`unmergeable-merge-level`
  表示 digest 层级无法收缩，区别于模型故障/容量耗尽）；
  `outputBudget`/`usableInput` 记录本次分块预算的组成部分（输出预留与可用
  输入），便于对照质量与容量使用。

通过 `runRecord` 配置（默认：`enabled: false`、`maxEntries: 200`、
`snapshotChars: 20000`、`path: ''` → 存储根目录）。`maxEntries` 把文件裁剪
到最近若干条；`path` 固定为绝对文件位置（测试和指向共享卷时有用）。设置页
的 **运行记录 / Run log** tab 可切换开关。

这是与冷却域刻意分开的隐私边界：运行记录**确实**按设计包含对话内容
（snapshot + digest）。正因如此它**默认关闭**；只有确实需要时才启用
（`runRecord.enabled: true`）。

## 保真度基准（test/bench）

`test/bench/` 是一个**信息保真度 / 管线回归基准**——它回答的是：

> Stage 0 → chunk → merge → checkpoint 这条管线，有没有把 agent 会话里
> 关键的信息（错误串、文件路径、决策、数字、待办）在压缩前先弄丢？

而不是"这个压缩算法已经证明适合真实 Agent"。两者必须分开理解：

- **它能证明**：管线各阶段是否保留了关键证据 token、层级归并是否把 N 个
  digest 收拢到最终 checkpoint、`legacy-trim`（被移除的有损裁剪）是否确实
  更差、以及**每次发出的请求是否满足 `input + maxTokens <= context window`**。
- **它不能单独证明**：真实 LLM + 真实工具 + 真实多轮决策下，压缩后任务
  成功率不下降。那需要真实模型验证（见下）。

因此基准分**两层**：

1. **确定性层（CI 每次跑）**——`npm run bench`：脚本化 summarizer persona
   （`perfect` / `leak` / `forgetful`），结果跨机器、跨 commit 稳定，直接
   断言回归阈值（`npm test` 会跑）。
2. **真实模型层（periodic / release，不进 CI）**——`npm run bench -- --real`：
   用真实 `ctx.llm` 跑同一条管线（同一 engine、同一 episode），真实模型读
   真实 prompt 做压缩；结果**只报告、不设阈值**（真实模型有波动与限流）。
   注入点是 suiteA/B 的 `llmFactory`，包装器见 `test/bench/llm.js` 的
   `createRealLlm`。

三个 episode（JWT 调试、CI 日志、重构）的 probe 由作者提供 ground truth；
`control` 分支直接删除同一 span，用于把"压缩保住的"与"本来就在上下文里的"
分开。Suite B 测的是**词法可检索性**（对精确 needle 的 grep），是检索能力
的下界而非真实搜索工具的全量能力。

## 隐私

状态文件**只**含路由冷却时间戳。任何会话消息、提示词、摘要都不会进入该域。

## 可观测性（日志）

每次模型调用都可端到端追踪；日志行是结构化 key=value 字符串，便于 grep：

- `debug dsh-quilt-compact call: …` — 每次调用，分派前：
  - `job=chunk N | merge | fallback` 与 `route=provider/model`
  - 兜底行上的 `defaultPlugin=true` 标记对 `dsh-compaction-basic`（默认压缩
    插件）的**直接**调用；兜底随后在同一行记录
    `outputChars`/`outputTokens`/`durationMs`。
  - 输入段标识：`inputChars`、`inputTokens~`（启发式）、`lines=A..B`（Stage
    0c 的 chunk 作业行范围）、`requestChars`（含指令的完整请求信封）、
    `sha=…`（输入 SHA-256 前 12 位十六进制）、`preview="…"`（前 80 字符，
    单行）。
- `debug dsh-quilt-compact call ok: …` — 每次成功调用：
  `outputChars`、`outputTokens`（provider 上报时）、`durationMs`。
- `warn dsh-quilt-compact: route … failed … job=… sha=…; cooling until …` —
  冷却写入事件（只打日志，不打印状态文件原文）。
- `info dsh-quilt-compact summarize: …` — 分块前的区域统计：
  `regionChars`、`stage0Lines`、`chunks`、`chunkBudget`、`overlapTokens`、
  `contextWindow`。
- `info dsh-quilt-compact summarize done: …` — 最终路由、`fallback`、
  `digestChars`、`attempts`。
- `info dsh-quilt-compact batch: …` — 每个池批次：`jobs`、`calls`、
  `byRoute=p1/m1:N,…`、`failures`、`fallback`、`durationMs`。

隐私边界：日志**只**携带统计、指纹与 ≤80 字符的预览——绝不携带完整会话
消息、提示词或摘要。

## 包结构

```
lib/
  index.js            导出：default QuiltCompactEngine、Config、spec、helpers、
                      bridge 核心 + 宿主接线
  engine.js           QuiltCompactEngine：summarize、compactIfNeeded/Now/Region、
                      自动接线、store 引导、兜底委托接线、设置 bridge 注册（有 webServer 时）
  bridge.js           无框架 bridge 核心：describe/mutate/status 处理器、
                      loopback 守护、JSON body/response 助手、路由构造器
  bridge-host.js      createBridgeDeps（定位 preset/宿主行、经由 configEditor 读写、
                      llm catalog、status）+ registerQuiltBridge
  default-compression.js  dsh-compaction-basic 的 summarize 直接门面
  config.js           schemastery Config + resolveConfig（校验/默认值）
  model-pool.js       模型池相对实时注册表的运行时校验
  spec.js             dsh_quilt_compact_state 域 spec、routeKey
  cooldown.js         computeCooldownUntil、Domain/Memory store
  run-log.js          JSONL 运行记录：capSnapshot、resolveRunLogPath、RunLog
  model-chain.js      tier 调度器：槽位、冷却、降级、兜底
  summarize.js        内置 prompt、单次 stream 调用、检查点框架
  region.js           持久化压缩事务 + shrink 校验 + 恢复
  stage0/             文本抽取、修剪、语义压缩、分块
client/
  client.js           浏览器半区：设置页（plugins.row.config 座位，经设置 bridge 读写）
cordis.patch.yml      随包层（dsh.bundle.patch）：宿主平面替换 +
                      preset-standard 重述（compaction 组引擎）
test/
  unit/               冷却、config、stage0、model-chain、policy、model-pool、
                      bridge（describe/mutate/conflict/schema/guard/locate）
  e2e/                真实会话上的完整事务；真实 json 持久化
  smoke/              真实 dsh 代码：patch 组合器、容器挂载、volatile 配置、
                      池校验、服务注册安全、完整 web 栈组合、经 bridge 的客户端渲染
```

## 开发与测试

```sh
npm install --cache ./.npm-cache      # 测试依赖（绝不触碰任何 DSH profile）
node test/unit/cooldown.test.js       # 直接运行任意文件；node:test 进程内执行
npm run smoke                         # 全部 smoke 脚本
```

`node --test test/` 需要子进程派生，本项目所用的沙箱不允许；请改为单独运行
文件（或在沙箱外运行）。假 LLM 端到端套件模拟 retryPolicy 耗尽失败 → 冷却
写入 → tier 降级 → 会话模型兜底；持久化套件跑真实 json 后端 + 重开。

smoke 脚本超越 unit/e2e，跑的是**真实 DSH 代码**而不是假件：

| 脚本 | 证明什么 |
|---|---|
| `smoke:patch` | 真实的 `dsh-base` 层 + 本 bundle 层，经 **dsh 自己的 `composeEntries` / `loadOverlayPatches`**（`dsh --dump-config` 用的函数）组合：`compaction-basic` 被禁用、`dsh-quilt-compact` 启用、其它行原样 |
| `smoke:compose-web` | **完整 web 栈**（web-app bundle patch 依序 + 用户 profile 层 + 本 bundle 最后）：`preset-standard` 保持 19 个插件、`compaction` 组现在承载 `dsh-quilt-compact`（isolate + command-compact + tool-result-pruner 完好）、宿主 insert 行的 `!!js` 门存活、组内不再有 `compaction-basic` |
| `smoke:mount` | 真实 cordis `Context` + 真实 `dsh-storage` / `storage-json` / `storage-domain` 栈；插件以 `ctx.compaction` 挂载、冷却状态真实落到文件系统、卸载干净 |
| `smoke:volatile` | `.volatile()` Config 交付的是**引用**而非值——引擎解包并仍应用默认值 |
| `smoke:pool` | 对实时注册表的池校验：校验、按原因警告、配置编辑后复检、注册表损坏时仍能挂载 |
| `smoke:registration` | 内部构造 `BasicCompactionEngine`（兜底门面 + 策略读取）绝不抢占 live `compaction` 槽位——这正是两个后端同时启用时插件拒绝启动的失败模式 |
| `smoke:client` | 浏览器页面经**设置 bridge** 渲染（stub fetch、真实 `dsh-client-store` snapshot API——`getSnapshot`/`subscribe`，无 `get()`），注册进 `plugins.row.config` 与 `plugins.bundle.config`（键为 `<package>#<row>` / `<package>`），外壳可折叠、tab 切换面板、picker 来自 catalog、改 provider 会重填配套 model 使 Save 保持有效、整个 `tiers` 数组以修订号为栅栏保存为干净 JSON、无效输入在点击时浮出（Save 绝不因校验错误被禁用） |
| `smoke:bridge-order` | 真实 cordis `Context`：引擎在 webServer 已存在时挂载会注册 bridge 路由，**且**在*迟到*的 `webServer` 提供后也会注册——即真实 web-profile 竞态（`include:dsh-quilt-compact` 可能在 `dsh-web-app` 启动服务器前激活），此前导致设置页 404 `not found` |

patch/mount 脚本需要磁盘上的 dsh 安装。它们自动定位（从本 checkout 向上
找，再 `npm root -g`）；也可设 `DSH_MODULES` 指向 dsh 安装的 `node_modules`。
找不到 dsh 时打印 `SKIP` 并以 0 退出，因此不会让一个没装 dsh 的 checkout
失败。

## 安装激活

直接从 GitHub 仓库安装（无需 npm 发布）：

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-quilt-compact
dsh --profile <name> --dump-config   # 验证 "## == dsh-quilt-compact" 层
```

完整 URL 形式同样可用（`dsh plugin --profile <name> add
https://github.com/bvbhu/dsh-quilt-compact`），本地路径也可用于开发。`#<ref>`
后缀可钉住提交或 tag：`github:bvbhu/dsh-quilt-compact#<sha>`。确定某个修订后
建议钉住，因为裸仓库安装跟随默认分支。

由于包声明了 `dsh.bundle`，这条命令同时把 bundle 追加到
`dsh.profile.bundles` **并**激活随包层——无需手动 `insert:`。没有 `dsh.bundle`
声明的包仍可安装，但只是普通依赖：`dsh plugin` 会警告且不激活任何层。

> **这个 bundle 同时禁用了 `compaction-basic`。** 安装它会改变谁持有
> `ctx.compaction`，所以移除前务必重读[卸载](#卸载)。

随包层已经：

- 把 `compaction-basic` 禁用为*服务条目*（包本身必须保持安装——兜底直接
  import 它的 `summarize`；peer 依赖 `@deepseek-ai/dsh-compaction-basic`，
  DSH 默认随附）；
- 从**已安装**的包名挂载 `dsh-quilt-compact`，而非相对源码路径，让 Node
  解析已安装副本。

### 宿主平面持有 compaction 的 profile

本 bundle 层面向 `compaction` 服务位于宿主平面的 profile 编写——`headless`、
`sdk`、`sdk-minimal` 以及自定义 `dsh-base` 系 profile。在那里 `dsh plugin add`
一步切换后端：`compaction-basic` 禁用、`dsh-quilt-compact` 成为
`ctx.compaction`，与 `smoke:patch` 验证的一致。

### Web profile：压缩后端住在 agent preset 里

**Web** profile（`dsh --profile web`）按设计不同：

- `dsh-web-app` **禁用**宿主平面的 `compaction-basic`、`command-compact`、
  `tool-result-pruner` 三行——它的注释说明压缩后端"迁走"了。
- `standard` agent preset（以及 `minimal`/`ptc`/`cordis`）在 `compaction`
  **组**内重挂这三件套，带 `isolate: { compaction: true, toolResultPruner:
  true }`。用该 preset 创建 agent 时，`dsh-agent-preset-registry` 把 preset
  的插件行（含 compaction 组）挂到 **agent context** 的隔离域里。

自 v4 起 bundle 自动处理此事。随包层同时做**两件事**：

1. **宿主平面分支**（headless/sdk/自定义）：禁用 `compaction-basic` 并挂载
   `dsh-quilt-compact`——经典的一步切换。
2. **Web/desktop 分支**：重述 `preset-standard` 声明，把 `compaction` 组的
   后端行换成 `dsh-quilt-compact`（组的 `isolate`、`command-compact`、
   `tool-result-pruner` 保持不变）。重述由 `tools/generate-preset-restate.mjs`
   从随附的 `standard.patch.yml` 逐字生成，不会漂移。

两个分支按 profile 互斥：宿主 insert 行带
`disabled: !!js "['web', 'desktop'].includes(ctx.get('profileContext')?.name)"`
（与 `dsh-web-app` 相同的惯用法），因此 web/desktop profile 里只有 preset 组
引擎生效——绝不在同一 agent 事件上跑两个压缩引擎。headless/sdk profile 里
没有 `preset-standard` 行，重述被跳过（无害的 "not found"），宿主平面行就是
后端。`test/smoke/compose-web.mjs` 组合完整 web 栈并断言结果。

因为 patch 是整行替换 `config`（绝不深合并），重述携带 `standard` preset 的
完整 19 行插件表。这把随附的 preset 内容冻结在本 bundle 里：**DSH 升级改变了
standard preset 之后，重跑**
`$env:DSH_MODULES='…dsh\node_modules'; node tools/generate-preset-restate.mjs`
针对新文件重新生成重述。

设置页（见[配置](#配置)）经设置 bridge（`/api/dsh-quilt-compact/*`）写入：
web profile 里它通过 `configEditor` 编辑 `preset-standard` 内的拷贝（官方
编辑器同款持久化路径），因为 `dsh-settings` 表单无法寻址 preset 组内的行；
headless/sdk profile 里直接编辑宿主平面行。

层优先级（后层按行生效）：`dsh.profile.bundles` 中的每个 bundle patch → profile
的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlay。要改
模型池，用设置页，或在你的 profile patch 里整行重述 `dsh-quilt-compact`（带上
它需要的每个键），而不是改包。注意 web/desktop 的池是 **`preset-standard`
内的那份拷贝**；页面 bridge 写入的正是那份拷贝，只要你通过页面编辑、或手改
宿主行后重跑生成器，两处就保持一致。

`dsh plugin --profile <name> remove dsh-quilt-compact` 同时移除依赖与层。
之后如何恢复默认后端取决于 profile 类型——完整步骤见[卸载](#卸载)（宿主
平面 profile 必须重新启用 `compaction-basic`，Web profile 必须把 preset 的
compaction 组换回去）。

## 卸载

如何移除插件取决于它被加到了哪类 profile（见
[Web profile](#web-profile压缩后端住在-agent-preset-里)）。

### 宿主平面 profile（headless、sdk、自定义）

`dsh plugin remove` 删除依赖与 bundle 层，但有一件事它不能撤销：本 bundle
**禁用**了 `compaction-basic` 行。该行活在 `dsh-base` 里并会存活到移除之后，
所以只移除包会留下**没有**压缩服务的 profile。务必完成第 3 步。

```sh
# 1. 从 profile 移除依赖与本 bundle 层。
dsh plugin --profile <name> remove dsh-quilt-compact

# 2. 确认层已消失但 compaction-basic 仍被禁用。
dsh --profile <name> --dump-config | Select-String -Pattern 'compaction'

# 3. 恢复默认后端：重新启用 compaction-basic 行。
#    写进 $DSH_HOME/profiles/<name>/cordis.patch.yml（profile 自己的层）：
- id: compaction-basic
  disabled: false

# 4. 验证恰好一个压缩服务活跃、一个启用。
dsh --profile <name> --dump-config | Select-String -Pattern 'compaction'
```

第 3 步应写在**profile** 的 `cordis.patch.yml` 里，而不是包内——后层按行
生效，profile 层的 `disabled: false` 即可重新启用 basic，无需碰 `dsh-base`
或本包。

### Web profile

`dsh plugin remove dsh-quilt-compact` 删除依赖与 bundle 层——包括随包附带的
`preset-standard` 重述，所以 preset 的 `compaction` 组自动回归
`@deepseek-ai/dsh-compaction-basic`，**除非存在 profile 层覆盖**：

```sh
# 1. 移除依赖与本 bundle 层（含重述）。
dsh plugin --profile web remove dsh-quilt-compact

# 2. 确认 preset 的 compaction 组回到默认后端。
dsh --profile web --dump-config | Select-String -Pattern 'compaction-basic'
```

如果你以前在 **profile** 的 `cordis.patch.yml` 里写过自己的 `preset-standard`
覆盖（旧指令），该层活得比 bundle 久，会一直把组指向 `dsh-quilt-compact`；
手工删掉那块，让组回归 `@deepseek-ai/dsh-compaction-basic`。宿主平面行两种
情况都不受影响：Web 层本就禁用它们，真正服务 agent 的是 preset 组。

冷却状态与插件无关，不会自动删除。它在 DSH home 下的一个文件——
`$DSH_HOME/storages/dsh_quilt_compact_state.json`（`json` 后端每个存储单元
写一个文档；域名是 `dsh_quilt_compact_state`）。想完全清零就删掉它：

```sh
Remove-Item "$env:DSH_HOME\storages\dsh_quilt_compact_state.json" -ErrorAction SilentlyContinue
```

留着也无害：插件没了就没人读它。之后重装时每条路由从健康起步，因为没记录
的路由天然健康。

### 临时禁用（不卸载）

**宿主平面 profile** —— 在 profile 层里只禁用 insert 行并在同一文件重启用
basic：

```yaml
- id: dsh-quilt-compact
  disabled: true

- id: compaction-basic
  disabled: false
```

包保持安装，profile 下次启动回到默认后端——A/B 两者最省钱的方式。

**Web profile** —— 在 profile 层重述 `preset-standard` 行，把 compaction
组的后端行换回 `@deepseek-ai/dsh-compaction-basic`（后层按行生效，所以会压过
bundle 的重述），或临时把 bundle 移出 `dsh.profile.bundles`。没有宿主平面行
可翻；preset 组是唯一决定点。

## 官方插件指南对照

对照
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop)
的 `docs/user/develop/`
（[第一个插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)、
[服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.md)、
[配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)、
[发布](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)）逐条核对：

| 指南规则 | 状态 |
|---|---|
| 以类形式提供服务：`extends Service`、`super(ctx, name)` | ✅ `extends CompactionEngine`（注册为 `compaction`） |
| 在 `inject` 声明必需服务 | ✅ `['llm', 'tokenMeter', 'sessions']` |
| 可选服务：不进 `inject`，用 `ctx.get()` 查询 | ✅ `storageDomain`、`toolResultPruner` |
| 用 `ctx.effect()` disposer 显式清理 | ✅ 懒打开的冷却域在卸载时关闭 |
| 事件监听/定时器自动清理；不要手动移除 | ✅ 只用 `ctx.on(...)` |
| 导出 schemastery `Config` schema（绝不是普通对象） | ✅ `config.js` 导出 `Config = z.object({...})`、`static Config` |
| 不要硬编码两个部署可能想要不同的值 | ✅ 没有随意的值：压力策略**运行时读取** `dsh-compaction-basic`（`readBasicPolicy()`），两个模型能力兜底（`262144` / `32768`）是 `dsh-llm` 对未配置模型的假设。`test/unit/policy.test.js` 断言两处一致性 |
| 声明 `dsh.bundle` 让 `dsh plugin add` 激活层 | ✅ `dsh.bundle.patch` → `cordis.patch.yml` |
| bundle 行按安装名引用包 | ✅ `name: dsh-quilt-compact` |
| patch 文件进 `files` | ✅ `["lib", "client", "cordis.patch.yml"]` |
| 可编辑 Config 字段标 `.volatile()` | ✅ 每个字段都标，设置页才能实时写；`tiers` 整体 volatile，因为 schemastery 禁止数组元素内的 volatile 字段 |
| 使用前解包 volatile 引用 | ✅ `resolveConfig()` 透过 `.get()` 读，也接受普通值（单元测试与直接构造） |
| 客户端半区需要 `dsh.client` + `./client` 导出 | ✅ `dsh.client.platform: web`、`exports["./client"]` → `client/client.js` |
| 客户端 UI：只用宿主主题 token，不用字面颜色 | ✅ 只用 `--dsw-alias-*` |
| 客户端 UI：所有可见文本经 `ctx.locale` | ✅ `zh` + `en` 词典 |
| 客户端 UI：绝不把 `dsh-client-ui-*` 包 `require` 成模块 | ✅ 只用模块表（`react`、`react/jsx-runtime`、`slots`、`primitives`） |
| 客户端 UI：每个资源用 `ctx.effect` 注册 | ✅ 订阅与槽位注册都是 effect |
| 改随附 preset：重述整行（绝不 insert、绝不 patch 组子项） | ✅ `preset-standard` 用完整 19 行表覆盖；`tools/generate-preset-restate.mjs` 从随附文件逐字再生 |
| 提供服务的 preset 插件必须在同一域隔离 provider 与消费者 | ✅ `compaction` 组保留 `isolate: { compaction: true, toolResultPruner: true }`；`command-compact`（消费者）留在同组 |
| 可选服务走 `inject`/`ctx.get`，让插件没有它们也能保持不活跃 | ✅ `configEditor`/`llm` 用 `ctx.get` 查询；bridge 只在存在 webServer 时注册——并会经由 `ctx.inject(['webServer'])` **等待**迟到的 webServer（free-search 模式），引擎先于 `dsh-web-app` 启动服务器挂载也能拿到路由；兄弟引擎的重复注册被容忍 |
| 超出 configForms 的设置 UI：当行不是 include-tree 条目时，随附页面 + 宿主 bridge | ✅ `plugins.row.config` 座位 + `/api/dsh-quilt-compact/*` bridge（free-search / auto-approval 先例） |
| 与宿主共享的 dsh 包：同时进 `peerDependencies` 与 `devDependencies` | ✅ cordis、agent、compaction、compaction-basic、llm、session、storage-domain、token-meter |
| 深导入必须被依赖的 `exports` 允许 | ✅ `@deepseek-ai/dsh-token-meter/estimate` |
| `types` 必须指向真实产物（publint 卫生） | ✅ 无 `types` 字段——包是无需构建的纯 JS，不声明任何声明文件 |

`@deepseek-ai/dsh-storage-domain` 是静态 import（它的 `defineDomain` /
`domainTable` 在模块加载时构建 spec），所以它是真正的安装期依赖；运行期若
形态未挂载，引擎仍降级到内存（有意为之，见[持久化](#持久化)）。

## 兼容性检查

发布前对照已安装的 DSH `0.1.7-rc.1` 验证过。

| 检查 | 结果 |
|---|---|
| 每个 `peerDependencies` 版本等于已安装 DSH 版本 | ✅ `dsh-compaction`、`dsh-compaction-basic`、`dsh-llm`、`dsh-session`、`dsh-storage-domain`、`dsh-token-meter`、`dsh-agent` 都为 `0.1.7-rc.1`；`cordis ~4.0.4` 由 `4.0.4` 满足 |
| `CompactionEngine` 接缝：`extends Service`、`super(ctx, 'compaction')` | ✅ 与 `dsh-compaction-basic` 相同的注册路径，`ctx.compaction` 就是消费者看到的那个服务 |
| `inject` 名称解析到 base 层提供的服务 | ✅ `llm`、`tokenMeter`、`sessions`（行 `llm`、`token-meter`、`session`） |
| 自动压力策略与内置后端一致 | ✅ 运行时从 `dsh-compaction-basic` 经 `readBasicPolicy()` 读取——`0.8 / 0.16 / 65536 / 1 / 1` |
| patch 层在真实 `dsh-base` 层上组合 | ✅ dsh 自己的 `composeEntries` 产出 93 行：`compaction-basic` 禁用且保留 `name`、`dsh-quilt-compact` 启用、无旁支改动 |
| 插件在真实 cordis 容器中以 `ctx.compaction` 挂载 | ✅ `smoke:mount`，真实 `dsh-storage` / `storage-json` / `storage-domain` 栈 |
| 冷却状态真实持久化 | ✅ 经真实域往返，落到 `dsh_quilt_compact_state.json` |
| 卸载干净 | ✅ `ctx.effect` disposer 关闭域；容器无错释放 |
| 对实时注册表的池校验 | ✅ `smoke:pool`：校验、按原因警告、配置编辑后复检、注册表损坏时仍挂载 |
| volatile 配置交付解包后的值 | ✅ `smoke:volatile`：引用经 `.get()` 读取，默认值仍生效 |
| 设置页编辑实时生效 | ✅ `loader/volatile-update` 时从原始 volatile 配置重解析（`reloadConfig()`）——chunk 预算、模型池、预处理、run log 均换新；失败编辑保留旧配置 |
| 分块预算预留输出 token | ✅ `budget.js`：`usableInput = 窗口 − 输出预留 − 开销 − 余量`，`chunkRatio` 表示可用输入的比例；单测断言输入+输出不超窗口 |
| 调度按模型容量选模型 | ✅ `ModelChain` 容量感知：任务带估计输入 token，容量不匹配跳过而不写冷却，tier 全装不下则降级 |
| 实际 `maxTokens` 与容量规划一致 | ✅ 每个请求按 `min(32768, 模型 defaultMaxTokens, 窗口 − 实际输入 − 指令开销)` 动态 clamp；单测覆盖 64K 模型 40K 输入 → 24K 上限 |
| chunk 规划覆盖主 tier 最小容量 | ✅ 窗口取主 tier 已知容量的最小值（未知容量路由不参与 min），保证同 tier 每个健康模型都能吃下任意 chunk |
| 大区域层级归并 | ✅ `mergeDigests`：按可用输入预算分组归并到剩一个 digest（`N → N/k → … → 1`），每层都过容量调度 |
| 内部 `BasicCompactionEngine` 绝不抢占 `ctx.compaction` | ✅ `smoke:registration` |
| 完整 web 栈：preset 组服务 dsh-quilt-compact、宿主行被门控 | ✅ `smoke:compose-web`：167 行、19 个 preset 插件、组 = `dsh-quilt-compact, command-compact, tool-result-pruner`、`!!js` 门完好 |
| 设置 bridge：describe/mutate/status + conflict/schema 栅栏 | ✅ 21 个单元测试；客户端经 stub bridge 渲染（`smoke:client`） |

已知的有意约束：

- **`compaction-basic` 禁用的是服务条目，不是卸载。** 会话模型兜底直接
  import 它的 `summarize`，包必须保持安装。把包从依赖树移除会弄坏兜底。
- **只应启用一个压缩后端。** 两者挂同一个 `compaction` 服务。同时启用会在
  启动时报 *"service `compaction` has been registered at
  `<BasicCompactionEngine>`"*；都不启用会让 profile 无法压缩。随包层已正确
  设置，所以 profile 层通常什么都不用说——见
  [临时禁用](#临时禁用水不卸载)。
- **DSH 没有自动生成的设置表单。** `dsh-settings` 会给从 schema 建页的客户端
  上报 `autoGenerate`，但没有随附客户端这么做（`dsh-settings/README.md`）。
  `.volatile()` 只是让字段*可写*；页面本身是 `client/client.js`。想要自动化
  表单的插件得自己写渲染器。
- **Web profile：设置 bridge 是唯一 GUI 路径，且绑定引擎实例。**
  `dsh-settings` 表单无法寻址 preset 组内的行，所以页面与
  `/api/dsh-quilt-compact/*`（引擎在存在 web server 时注册）通信。bridge 经
  `configEditor` 写 `preset-standard` 内的嵌套拷贝。若 preset 引擎未挂载
  （例如用户切到 `minimal` preset），bridge 报 `no-target`，页面解释而不是
  编辑死行。
- **preset 重述冻结了随附的 `standard` preset。** DSH 升级改变了
  `presets/standard.patch.yml` 之后，重跑 `tools/generate-preset-restate.mjs`
  重新生成重述（见
  [Web profile](#web-profile压缩后端住在-agent-preset-里)）。
- **针对 DSH `0.1.7-rc.1` 调优。** `readBasicPolicy()` 会自动跟随上游再调优，
  但服务接缝本身（`CompactionEngine`、patch 格式、preset 形状）不做版本协商
  ——DSH 大版本更新需要重跑这些检查。