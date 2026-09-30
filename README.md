# dsh-quilt-compact

DeepSeek Harness 的上下文压缩插件。

它替代默认的 `compaction` 后端：**用低价/免费小模型压缩对话内容，节省成本**。
部分模型的上下文窗口较短、装不下完整对话，所以采用分块与归并：切块逐个交给小模型摘要，再把所有摘要**一次归并**成一个最终检查点（`N → 1`）。

- 支持配置多档模型（不同 tier 放不同规格），按容量自动选用、自动降级。
- 模型调用失败会冷却一段时间；模型池无法完成当前任务时由会话模型兜底。
- 分块、摘要、归并全流程自动完成，最终产出一个小而全的检查点。

## 工作方式

一次压缩按以下管线进行：

```
Stage 0 → (选模型 → 切块 → 摘要) × N → 单级归并 → Checkpoint
```

1. **Stage 0** — 对要压缩的区域做预处理：展平为行文档、合并相邻重复行、
   压缩连续空行、清除终端噪音（ANSI 转义、光标标记、长分隔线等）、保留
   文件/图片附件的名称而非匿名化成裸标记；可选地做代码骨架化（按缩进层级
   保留结构行）与日志冷凝。
2. **选模型 → 切块** — 每轮选定一个健康且空闲的模型，**按该模型自己的
   contextWindow 现场切出一段上下文**（带重叠、切分对齐整行），所以模型
   装不下上下文的问题从流程上被消除。每块同时带上摘要长度上限
   `cap_i`（按块大小占区域总长的比例分配），保证所有摘要合起来装得下单级
   归并。
3. **Summarize** — 每个分块经模型池的一次模型调用摘要成一个小 digest
   （不超过 `cap_i`）。
4. **单级归并** — 所有 digest **一次调用**整合成最终检查点（`N → 1`），
   不做多层归并。归并窗口由配置 `mergeMaxContextTokens`（归并前最多保留多少
   上下文）控制，**默认值就是 128k**（恒有值，没有"未设置"分支）。归并没有
   专用池：在主模型池内**逐级下降**找上下文足够的模型执行归并；若降池后仍
   没有模型装得下，直接由会话模型兜底。
5. **Checkpoint** — 最终 digest 替换原区域，写入会话。

## 适用版本

peer 依赖声明`>=0.1.7-alpha.2`，**但仅在 DSH `0.1.7-rc.1` 上验证**。

## 安装

直接从 GitHub 仓库安装（无需 npm 发布）：

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-quilt-compact
```

包声明了 `dsh.bundle`，安装命令会自动激活随包层并**禁用 `compaction-basic`**
（本插件成为 `ctx.compaction`）。建议用 `#<sha>` 后缀钉住提交，避免裸仓库
跟随默认分支：

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-quilt-compact#<sha>
```

## 更新

```sh
dsh plugin --profile <name> update dsh-quilt-compact
```

## 卸载

```sh
dsh plugin --profile <name> remove dsh-quilt-compact
```

之后在 profile 层重新启用 `compaction-basic` 即恢复默认后端。

## 配置

两种方式等价：Web UI 的**设置页**（写入同一份 profile patch），或直接编辑
profile 的 `cordis.patch.yml`（后层按行生效）。

### 模型池

```yaml
- id: dsh-quilt-compact
  config:
    tiers:
      - name: primary
        models:
          - provider: openrouter
            model: openrouter/free
            maxConcurrent: 1
            cooldown: { mode: duration, hours: 1 }
```

`cooldown` 只有一种形态：`{ mode: duration, hours }`——失败后冷却的小时数
（正数，允许小数，如 `0.5` = 30 分钟），从失败时刻起算。`hours` 省略时默认
**1 小时**，`mode` 也可省略（写 `cooldown: {}` 即可）。`maxConcurrent` 默认 1。

原来的 `dailyReset`（固定 UTC 小时重置）已移除：它跨时区极易配错，会静默
产生长达十几小时的盲窗（`hour: 8` 在北京实际是 16:00 解冻）。

### 归并窗口（可选）

单级归并**没有专用模型池**（无 `mergeTiers`）：归并复用主 `tiers`，并在池内
**逐级下降**找上下文足够的模型——分块用便宜小模型，归并自动落到能装下全部
digest 的大窗口路由。归并前最多保留多少上下文用 `mergeMaxContextTokens`
（token 数）控制，**默认值就是 128k**（配置项恒有值，不存在"未设置"分支）：

```yaml
    mergeMaxContextTokens: 64000   # 归并前最多保留多少上下文（归并窗口），默认 128000
```

设置后归并窗口**精确等于该值**（不套下限、不随池推导）；未设置就是 128k。
**注意**：默认 128k 意味着若主池没有任何 ≥ 128k 的模型（例如全 8k 小模型），
多分块压缩会直接由会话模型兜底；此时把 `mergeMaxContextTokens` 调到池模型
装得下的大小（如 8000），单级归并就会真正发生。

### 分块

```yaml
    chunkRatio: 0.8        # 分块占用模型可用输入的比例
    chunkOverlapRatio: 0.1 # 相邻分块重叠占分块预算的比例
```

### Stage 0

```yaml
    preprocessing:
      dedup: true                              # 合并相邻重复行
      purgeErrors: true                        # 清除终端噪音（ANSI、光标标记、长分隔线等）
      astSkeleton: { enabled: true, maxDepth: 2 }  # 代码骨架化（按缩进层级保留结构行）
      logCondense: { mode: balanced, maxLines: 200 }  # 超长日志冷凝
```

### 运行记录

可选的质量评估记录，**默认关闭**：

```yaml
    runRecord:
      enabled: false      # 关闭时不产生任何运行记录
      maxEntries: 200     # 文件最多保留多少条（超出裁剪到最近 N 条）
      snapshotChars: 20000 # 每条记录里重放前缀的字符预算（0 = 全部）
      path: ''            # 固定文件位置；留空用 DSH storage 根目录
```

启用后，每次压缩追加一行 JSON 到
`<DSH home>/storages/dsh_quilt_compact_runs.jsonl`（非空 `$DSH_HOME` 优先，
否则 `~/.dsh`；`path` 可覆盖）。每条含统计（trigger、regionChars、
chunkCount、mergeLevels 等）、`snapshot`（重放的会话前缀，截断到
`snapshotChars`）和 `result`（最终摘要文本）。

### 失败诊断

压缩失败不再只留一句固定文案：

- **error 级日志** — summarize 失败时输出一行
  `dsh-quilt-compact summarize failed (trigger=…): <原因>`，原因是扁平化的
  错误链（顶层: 中间: 根因），含整批失败时的逐路由尝试摘要
  （`attempts: p1/m1 x1 (last: …); …`）。
- **事务层失败同样记录** — 归并/收缩检查、历史被改写、提交失败、持久化
  失败发生在 `summarize()` 返回之后，之前只留下宿主的固定文案；现在统一
  输出 `dsh-quilt-compact compaction failed (trigger=…, stage=…): <原因>`。
  同一失败跨层传播时只记一行（去重标记随错误链行走）。
- **失败也进运行记录** — runRecord 开启时，失败写入 `failed: true`、
  `route: 'error'`、`error`（扁平化原因）的记录，与成功记录同结构；成败
  比例与失败原因都可以直接在 JSONL 上统计。summarize 失败与事务层失败
  都写。
- **可行动的兜底报错** — "池中无路由装得下归并"的报错会列出
  `mergeWindow`、每个路由的 window 与冷却状态，并给出出路（调低
  `mergeMaxContextTokens` 或增加大窗口模型）。
- **手动 `/compact`** — `ManualCompactionError` 的 message 携带底层原因
  （会话日志的 `compaction/end` 事件与本插件的日志都会显示它）；自动
  压缩失败（step 压力、上下文溢出）的 warn 行也携带扁平化原因。

宿主的 `/compact` 命令按错误码输出固定文案并丢弃 `error.message`；真实原因
始终在本插件的 error 级日志（以及 runRecord 开启时的 JSONL）里可查，无需
改动宿主导包。

## 调度与兜底

- **模型驱动切块** — 每轮选定一个模型（同 tier 轮转公平），按该模型自己的
  contextWindow 现场切出一块再派发——块的大小永远等于处理它的模型的容量，
  不存在"模型装不下上下文"的常规路径。
- **容量默认值** — 模型容量（contextWindow/maxTokens）解析失败或缺失时，
  按 256k / 32k 的默认值参与容量匹配，而不是当作"无限制"。
- **冷却** — 模型调用失败后冷却配置的小时数（默认 1 小时，从失败时刻起算），
  冷却期内不再选它。
- **全池冷却自动恢复** — 如果**所有**路由都处于冷却（例如一次网络抖动让
  所有供应商同时失败），切块阶段会**清空全部冷却并重试一次**，而不是干等到
  最早的路由到期。冷却只是"别猛打故障供应商"的启发式，不是契约：整个池都
  没人能干活时它已经没有意义了。重试后仍然失败的路由会被重新冷却。
- **失败重试** — 摘要失败后冷却该模型；重派时**优先在同一 tier 换
  contextWindow 更大的健康模型**（上下文足够优先），同级都不够才把块切小，
  再降级到下一 tier。
- **降级** — 当前 tier 没有可用模型时，任务降级到下一 tier。
- **会话兜底** — 模型池无法完成当前任务时（如所有 tier 冷却、或归并时池中
  没有任何模型装得下全部 digest），由会话模型直接压缩整个区域（直接调 `dsh-compaction-basic`，可 `fallbackToSessionModel: false` 关闭）。归并因"池中无足够窗口的健康模型" 而兜底时记录带 `fallbackReason: no-merge-model` 以便与模型故障区分。
- **兜底到底** — 连一个块都切不出来时（全池冷却且清空重试后依然不可用），
  不再抛错，而是直接把整个区域交给默认压缩插件出摘要——压缩仍然完成，不会
  只剩宿主那句固定文案。这条路径在日志里以
  `model pool cannot serve this compaction (…)` 标注。

## 隐私

**默认不记录**：默认的持久化状态仅用于记录路由冷却时间，不保存会话消息、
提示词或摘要。

**开启 runRecord 后**：每次压缩（成功的和失败的）会把 `snapshot`（重放的
会话前缀）与结果/原因写入 JSONL 运行记录文件——**这会保存对话内容**。

## 已知限制

- 仅在 DSH `0.1.7-rc.1` 上实际验证过，没有测试过其他版本兼容。
- web/desktop profile 的模型池是 `preset-standard` 内的拷贝：通过 Web UI
  设置页修改时由插件桥接统一写入，无需手工处理；只有直接编辑
  `cordis.patch.yml` 或 preset 重述时才需要注意两份配置的一致性（或重跑
  生成器），否则两处会漂移。
- 基准中的 episode/probe 由作者提供 ground truth，**不是**真实用户会话数据；
  真实 agent 压缩后的任务成功率尚未在基准内覆盖。
- 真实模型验证 lane 因模型波动与限流，只报告结果、不进 CI 门槛。

## Benchmark / 验证

`test/bench/` 提供两层验证：

- **确定性 lane（CI）**——`npm test`：脚本化 summarizer persona
  （`perfect` / `leak` / `forgetful`），结果跨机器稳定；回归阈值对照
  `test/bench/baseline.json`（配 tolerance），并断言每次发出的请求都满足
  `input + maxTokens <= contextWindow`。
- **真实模型 lane（periodic / release）**——`npm run bench -- --real`：用真实
  `ctx.llm` 跑同一管线，结果**只报告、不设阈值**。

另有 e2e（真实会话事务路径）、smoke（patch 组合 / 容器挂载 / 配置交付 / 池
校验 / web 渲染）与基准质量回归测试。