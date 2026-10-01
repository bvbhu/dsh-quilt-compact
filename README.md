# dsh-quilt-compact

DeepSeek Harness 的上下文压缩插件。

替代默认的 `compaction-basic` ：**用指定的低价/免费小模型压缩对话内容，节省成本**。
部分模型的上下文窗口较短、装不下完整对话，所以采用分块与归并：切块逐个交给小模型摘要，再把所有摘要**一次归并**成最终结果。

- 支持配置多档模型（不同 tier 放不同规格），按容量自动选用、自动降级。
- 模型调用失败会冷却一段时间；模型池无法完成当前任务时由会话模型兜底。
- 分块、摘要、归并全流程自动完成，最终产出一个小而全的检查点。

## 工作方式

一次压缩按以下流程进行：

```
Stage 0 → (选模型 → 切块 → 摘要) × N → 归并 → Checkpoint
```

1. **Stage 0** — 对要压缩的区域做预处理：展平为行文档、合并相邻重复行、压缩连续空行、清除终端噪音（ANSI 转义、光标标记、长分隔线等）、保留文件/图片附件的名称而非匿名化成裸标记；可选地做代码骨架化（按缩进层级保留结构行）与日志精简。
2. **选模型 → 切块** — 每轮选定一个可用模型，**按该模型contextWindow 切出一段上下文**。每块同时带上摘要长度上限`cap_i`（按块大小占区域总长的比例分配），保证最终归并不会超出上下文限制。
3. **Summarize** — 每个分块经模型池的一次模型调用摘要成一个小 digest（不超过 `cap_i`）。
4. **单级归并** — 所有 digest **一次调用**整合成最终检查点。归并窗口由配置 `mergeMaxContextTokens`（归并前最多保留多少上下文，默认128k）控制。
5. **Checkpoint** — 最终 digest 替换原区域，写入会话。

## 适用版本

**仅在 DSH `0.1.7-rc.1` 上验证**，依赖声明`>=0.1.7-alpha.2`。

## 安装

直接从 GitHub 仓库安装：

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
            cooldownHours: 1 
```

`cooldownHours` 失败后冷却的小时数 （正数，允许小数，如 `0.5` = 30 分钟），从失败时刻起算。默认1 小时。
`maxConcurrent` 默认 1。

### 归并窗口（可选）

归并前最多保留多少上下文用 `mergeMaxContextTokens`（token 数，默认128k）控制，归并时会在池内**逐级下降**找上下文足够的模型。

```yaml
    mergeMaxContextTokens: 64000   # 归并前最多保留多少上下文（归并窗口），默认 128000
```

**注意**：默认 128k 意味着若主池没有任何 ≥ 128k 的模型，可能会导致归并过程没有模型而失败。

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
      astSkeleton: { enabled: false, maxDepth: 2 }  # 代码骨架化（按缩进层级保留结构行）；默认关闭，需显式开启
      logCondense: { mode: balanced, maxLines: 200 }  # 超长日志冷凝
```

### 运行记录

可选的质量评估/诊断记录，**默认关闭**：

```yaml
    runRecord:
      enabled: false      # 关闭时不产生任何运行记录
      maxEntries: 200     # 文件最多保留多少条（超出裁剪到最近 N 条）
      snapshotChars: 0    # >0 时每条嵌入一段截断的对话原文（默认 0 = 不存原文）
      path: ''            # 固定文件位置；留空用 DSH storage 根目录
```

启用后，每次压缩追加一行 JSON 到
`<DSH home>/storages/dsh_quilt_compact_runs.jsonl`（非空 `$DSH_HOME` 优先，否则 `~/.dsh`；`path` 可覆盖）。每条含统计（trigger、regionChars、chunkCount、mergeLevels 等）和 `result`（最终摘要文本）。

**默认不保存对话原文**——记录的是"引用"而不是副本：

- `ref` — `{ sessionId, seqs }`：指向会话事件日志里的被压缩区间，需要原文时按 seq 读回（会话是原文唯一合法的存放处）。
- `chunks` — 每块模型归属 `{ chunk, model, lineStart, lineEnd, tokens }`，回答"哪段是谁处理的"，不含文本。
- `cooldowns` — **每次进入冷却的报错** `{ model, job, error, until, hours }`：哪个路由、在哪个任务上、因何错误、冷却到何时——排查"某路由为何失败"的第一手证据（聚合尝试计数无法区分真实供应商错误与归属错误）。
- `snapshotChars` > 0 才嵌入截断原文副本（隐私 opt-in）。

### 失败诊断

压缩失败不再只留一句固定文案：

- **error 级日志** — summarize 失败输出一行 `dsh-quilt-compact summarize failed (trigger=…): <原因>`，原因是扁平化错误链（顶层: 中间: 根因），含整批失败的逐路由尝试摘要（`attempts: p1/m1 x1 (last: …); …`）。
- **事务层失败同样记录** — 收缩检查、提交、持久化等 `summarize()` 之后的失败统一输出 `dsh-quilt-compact compaction failed (trigger=…, stage=…): <原因>`；跨层传播的同一失败只记一行。
- **失败也进运行记录** — runRecord 开启时失败写入 `failed: true`、`route: 'error'`、`error`（扁平化原因），与成功同结构；成败比例与失败原因可直接在 JSONL 上统计。
- **可行动的兜底报错** — "池中无路由装得下归并"的报错会列出 `mergeWindow`、每个路由的 window 与冷却状态，并给出出路（调低 `mergeMaxContextTokens` 或增加大窗口模型）。
- **手动 `/compact`** — `ManualCompactionError` 的 message 携带底层原因（会话日志的 `compaction/end` 事件与本插件的日志都会显示它）；自动压缩失败（step 压力、上下文溢出）的 warn 行也携带扁平化原因。

宿主的 `/compact` 命令按错误码输出固定文案并丢弃 `error.message`；真实原因始终在本插件的 error 级日志（以及 runRecord 开启时的 JSONL）里可查，无需改动宿主导包。

## 调度与兜底

- **模型驱动切块** — 每轮选定一个模型（同 tier 轮转公平），按该模型自己的contextWindow 现场切出一块再派发——块的大小永远等于处理它的模型的容量，不存在"模型装不下上下文"的常规路径。
- **容量默认值** — 模型容量（contextWindow/maxTokens）解析失败或缺失时，按 256k / 32k 的默认值参与容量匹配，而不是当作"无限制"。
- **冷却** — 模型调用失败后冷却配置的小时数（默认 1 小时，从失败时刻起算），冷却期内不再选它。
- **全池冷却自动恢复** — 如果**所有**路由都处于冷却（例如一次网络抖动让所有供应商同时失败），切块阶段会**清空全部冷却并重试一次**，而不是干等到最早的路由到期。冷却只是"别猛打故障供应商"的启发式，不是契约：整个池都没人能干活时它已经没有意义了。重试后仍然失败的路由会被重新冷却。
- **失败重试** — 摘要失败后冷却该模型；重派时优先在同一 tier 换 contextWindow 足够的健康模型，同级都不够才把块切小，再降级到下一 tier。
- **降级** — 当前 tier 没有可用模型时，任务降级到下一 tier。
- **会话兜底** — 模型池无法完成当前任务时（如所有 tier 冷却、或归并时池中
  没有任何模型装得下全部 digest），由会话模型直接压缩整个区域（直接调 `dsh-compaction-basic`，可 `fallbackToSessionModel: false` 关闭）。归并因"池中无足够窗口的健康模型" 而兜底时记录带`fallbackReason:no-merge-model` 以便与模型故障区分。
- **兜底到底** — 连一个块都切不出来时（全池冷却且清空重试后依然不可用），不再抛错，而是直接把整个区域交给默认压缩插件出摘要——压缩仍然完成，不会只剩宿主那句固定文案。这条路径在日志里以 `model pool cannot serve this compaction (…)` 标注。

## 隐私

**默认不记录**：默认的持久化状态仅用于记录路由冷却时间，不保存会话消息、提示词或摘要。
**开启 runRecord 后**：每次压缩（成功的和失败的）写入 JSONL 运行记录——
**默认仍不保存对话原文**：记录的是 `ref`（会话 + seq 引用）、每块模型归属和冷却报错，需要原文时按引用从会话读回。只有把 `snapshotChars` 显式设成正数，记录里才会嵌入一段截断的对话副本（**这是保存对话内容的 opt-in**）。

## 已知限制

- 仅在 DSH `0.1.7-rc.1` 上实际验证过，没有测试过其他版本兼容。
- web/desktop profile 的模型池是 `preset-standard` 内的拷贝：通过 Web UI设置页修改时由插件桥接统一写入，无需手工处理；只有直接编辑 `cordis.patch.yml` 或 preset 重述时才需要注意两份配置的一致性（或重跑生成器），否则两处会漂移。
- 基准中的 episode/probe 由作者提供 ground truth，**不是**真实用户会话数据；真实 agent 压缩后的任务成功率尚未在基准内覆盖。
- 真实模型验证 lane 因模型波动与限流，只报告结果、不进 CI 门槛。

## Benchmark / 验证

`test/bench/` 提供两层验证：

- **确定性 lane（CI）**——`npm test`：脚本化 summarizer persona（`perfect` / `leak` / `forgetful`），结果跨机器稳定；回归阈值对照 `test/bench/baseline.json`（配 tolerance），并断言每次发出的请求都满足 `input + maxTokens <= contextWindow`。
- **真实模型 lane（periodic / release）**——`npm run bench -- --real`：用真实 `ctx.llm` 跑同一管线，结果**只报告、不设阈值**。
