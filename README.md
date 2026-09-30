# dsh-quilt-compact

DeepSeek Harness 的上下文压缩插件。

它替代默认的 `compaction` 后端：**用低价小模型分块完成上下文压缩**——把长
上下文切成多个小分块，逐个交给便宜的小模型摘要，再把摘要归并回一个检查点，
避免把整段上下文一次性喂给昂贵的大模型。

- 支持配置多档模型（不同 tier 放不同规格），按容量自动选用、自动降级。
- 模型调用失败会冷却一段时间；模型池无法完成当前任务时由会话模型兜底。
- 分块、摘要、归并全流程自动完成，最终产出一个小而全的检查点。

## 工作方式

一次压缩按以下管线进行：

```
Stage 0 → Chunk → Summarize → Hierarchical Merge → Checkpoint
```

1. **Stage 0** — 对要压缩的区域做预处理：展平为行文档、合并相邻重复行、
   压缩连续空行、清除终端噪音（ANSI 转义、光标标记、长分隔线等）、保留
   文件/图片附件的名称而非匿名化成裸标记；可选地做代码骨架化（按缩进层级
   保留结构行）与日志冷凝。
2. **Chunk** — 按模型可用输入预算把区域切成带重叠的分块（切分对齐整行）。
3. **Summarize** — 每个分块经模型池的一次模型调用摘要成一个小 digest。
4. **Hierarchical Merge** — digest 按容量预算分组归并，逐级收拢，直到剩下
   一个最终 digest（`N → N/k → … → 1`），而不是一次性把所有 digest 拼进一个大请求。
5. **Checkpoint** — 最终 digest 替换原区域，写入会话。

## 适用版本

peer 依赖只声明**明确无法使用**的下界：`>=0.1.7-alpha.2`。该下界来自代码
的实际深导入 `@deepseek-ai/dsh-token-meter/estimate`——`estimate` 子路径从
`0.1.7-alpha.2` 起才存在，更早版本会在模块加载时直接失败。**不设上界**：
`0.2.x` 及更高版本未验证，适配与否由使用者自行测试。

**当前仅在 DSH `0.1.7-rc.1` 上实际验证过**（dev 依赖锁定该版本）；其他满足
下界的版本按兼容假设放行，尚未逐版测试。

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
            cooldown: { mode: dailyReset, hour: 0 }
```

`cooldown` 二选一：`duration`（正小时数，允许小数）或 `dailyReset`
（整数 UTC 小时 0–23）。`maxConcurrent` 默认 1。

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

## 调度与兜底

- **容量选择** — 调度按模型已知的 contextWindow 选模型；容量装不下当前任务的
  模型被跳过（视为调度约束而非故障，不写冷却、不增加失败计数）。
- **冷却** — 模型调用失败后冷却配置的时长，冷却期内不再选它。
- **降级** — 当前 tier 没有可用模型时，任务降级到下一 tier。
- **会话兜底** — 模型池无法完成当前任务时（如所有 tier 冷却、或没有任何模型
  装得下真实请求），由会话模型直接压缩整个区域（可 `fallbackToSessionModel:
  false` 关闭）。若因 digest 层级无法合法收缩而兜底，记录带
  `fallbackReason: unmergeable-merge-level` 以便与模型故障区分。

## 隐私

**默认不记录**：默认的持久化状态仅用于记录路由冷却时间，不保存会话消息、
提示词或摘要。

**开启 runRecord 后**：每次压缩会把 `snapshot`（重放的会话前缀）与 `result`
（最终摘要）写入 JSONL 运行记录文件——**这会保存对话内容**。这是刻意的隐私
边界：正因为记录包含内容，它默认关闭；只有确实需要事后再看"压了什么、压出
什么"时才启用。

## 已知限制

- 仅在 DSH `0.1.7-rc.1` 上实际验证过；peer 只声明下界 `>=0.1.7-alpha.2`，
  其他满足下界的版本未逐版测试，`0.2.x` 及更高版本是否适配由使用者
  自行测试确认。
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