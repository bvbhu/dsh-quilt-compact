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
   清除终端噪音（ANSI 转义等）、保留文件/图片附件的名称而非匿名化成裸标记；
   超深代码块做 AST 骨架化、超长日志做冷凝。
2. **Chunk** — 按模型可用输入预算把区域切成带重叠的分块（切分对齐整行）。
3. **Summarize** — 每个分块经模型池的一次模型调用摘要成一个小 digest。
4. **Hierarchical Merge** — digest 按容量预算分组归并，逐级收拢，直到剩下
   一个最终 digest（`N → N/k → … → 1`），而不是一次性把所有 digest 拼进一个大请求。
5. **Checkpoint** — 最终 digest 替换原区域，写入会话。

## 适用版本

peer 依赖接受整个 DSH `0.1.x` 系列（`>=0.1.7-rc.1 <0.2.0-0`）——DSH 主包与
各 `dsh-*` 子包同步发版（`0.1.0-rc` → `0.1.1-rc` → … → `0.1.7-rc` →
`0.2.0-rc`），同一系列内的 rc 补丁视为兼容。范围上界 `<0.2.0-0` 同时排除
`0.2.0` 及其所有 rc 预发布。

**但仅在 DSH `0.1.7-rc.1` 上实际测试过**（dev 依赖锁定该版本）；其他 0.1.x
版本按兼容假设放行，尚未逐版验证。`0.2.0` 未放行：minor 升级可能有破坏性
变更，需先重跑兼容性检查再放开。

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
      purgeErrors: true                        # 清除终端噪音/错误输出
      astSkeleton: { enabled: true, maxDepth: 2 }  # 超深代码块 AST 骨架化
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

**默认不记录**：状态文件只含路由冷却时间戳，不含任何会话消息、提示词或摘要。

**开启 runRecord 后**：每次压缩会把 `snapshot`（重放的会话前缀）与 `result`
（最终摘要）写入 JSONL 运行记录文件——**这会保存对话内容**。这是刻意的隐私
边界：正因为记录包含内容，它默认关闭；只有确实需要事后再看"压了什么、压出
什么"时才启用。

## 已知限制

- 仅在 DSH `0.1.7-rc.1` 上实际验证过；peer 范围虽放行整个 `0.1.x` 系列，其他
  版本未逐版测试，`0.2.0` 及更高版本需重跑兼容性检查后再放开。
- web/desktop profile 的模型池是 `preset-standard` 内的拷贝：改池配置需同时
  改宿主行与 preset 重述（或重跑生成器），否则两处会漂移。
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