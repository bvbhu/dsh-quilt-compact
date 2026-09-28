# dsh-quilt-compact 设计 v3（定稿）

> 本文档为项目权威设计规格。**v3.1 修订（按实际代码）**：§1 决策表新增兜底压缩方式；§3.4 重写兜底实现——**直接调用默认压缩插件**（`dsh-compaction-basic` 的 `summarize`，重放会话前缀复用 KV 缓存、单次调用、单分块足够时一次完成），并新增 peer 依赖 `@deepseek-ai/dsh-compaction-basic`。
>
> **v3.2 修订（阈值与兜底值来源）**：§1 新增"自动压缩阈值"与"模型能力兜底"两行。自动压缩策略（阈值/保留/headroom/压缩重试/溢出重试）**不再在本插件内固定**，改为运行时读取 `dsh-compaction-basic` 的解析后默认值（`readBasicPolicy()`，见 `lib/default-compression.js`），使替换 `compaction` 服务不改变"何时触发压缩"；`test/unit/policy.test.js` 断言该一致性。生成上限常量改名为 `DEFAULT_MAX_TOKENS` 并由 4096 改为 `32768`、分块窗口兜底由 32768 改为 `262144`，均取 `dsh-llm` 对"未显式配置参数"的假设值（256k 上下文 / 32k 输出）。实现与偏差记录见 [README](../README.md)。

## 1. 已确认的决策

| 决策点 | 结论 |
|---|---|
| 限额判定 | 不做主动判定。DSH retryPolicy 失败 → 按该模型配置冷却 |
| 请求重试 | 完全复用 DSH `retryPolicy`，插件不配置任何重试参数 |
| 会话模型兜底 | 可关闭，默认开启 |
| 兜底压缩方式 | **直接调用默认压缩插件**（`dsh-compaction-basic` 的 `summarize`）：重放会话前缀 + 末尾追加指令（复用 KV 缓存），单次调用覆盖整个区域；若单分块足够则一次完成（v3.1 新增） |
| 持久化 | `ctx.storage.domain` |
| 并发语义 | 默认所有分块一起压缩；`maxConcurrent` 是**单模型**并发上限 |
| 降级条件 | 当前 Tier 无健康模型时，整体降级到下一 Tier |
| 冷却模式 | 两种：`duration`（固定小时数，支持小数）和 `dailyReset`（每日固定 UTC 小时） |
| 周/月套餐 | 用 `dailyReset` 每日探测一次 |
| 5 小时窗口 | `duration, hours: 5` |
| OpenRouter | 只配置一条 `openrouter/free` 路由 |
| 分块 | 核心区间 + 边界重叠；移除 `chunkCapTokens` 和 `maxTokens` |
| chunkTokens | 模型上下文窗口 × `chunkRatio`（默认 0.8） |
| 补充提示词 | chunk 级 + 归并级，均可选、默认空 |
| 默认压缩插件依赖 | `@deepseek-ai/dsh-compaction-basic`（peer，v3.1 新增） |
| 自动压缩阈值 | **运行时读取 `dsh-compaction-basic` 的解析后默认值**（`readBasicPolicy()`），不在本插件内固定：阈值、保留比例、headroom、压缩重试次数、溢出重试次数全部跟随默认插件（v3.2；`test/unit/policy.test.js` 断言该一致性） |
| 模型能力兜底 | 生成上限 `DEFAULT_MAX_TOKENS = 32768`、分块窗口兜底 `262144`（256k）——取 `dsh-llm` 对"未显式配置参数"的假设值（v3.2） |

---

## 2. 持久化规范

### 2.1 根路径

- 数据根：`resolveDshHome()` → `~/.dsh`（遵守 `$DSH_HOME` 覆盖）
- 所有用户数据单根，不落 cwd/workspace

### 2.2 机制：`ctx.storage.domain`

用 `defineDomain` 声明域，通过 `ctx.storage.domain.open(spec)` 打开，路由到 json 后端（root 配置在 `dshHomePath('storage')`）。

```ts
const chainStateSpec = defineDomain({
  // 实际落地名：UNIT_NAME_RE (/^[a-z][a-z0-9_]*$/) 禁止连字符，
  // 故包名 dsh-quilt-compact 下划线化为 dsh_quilt_compact_state。
  name: 'dsh_quilt_compact_state',
  version: 1,
  global: z.object({
    schemaVersion: z.literal(1),
  }).nullable(),
  tables: {
    routes: z.record(z.string(), z.object({
      cooldownUntil: z.number(),   // epoch ms，唯一字段
    })),
  },
});
```

在 `ctx.effect` disposer 中 `Domain.close()`。写入走 zod 校验 + 原子落盘，变更有事件可审计。

**已知限制**：`domain/changed` 是进程内事件，跨进程可见性依赖单实例假设。

### 2.3 写入节流

只在**冷却状态转换时**落盘：失败后写入 `cooldownUntil`。到期后懒清理（读取时发现已过期即视为健康，不主动写回）。

### 2.4 隐私边界

状态文件**只含路由冷却时间戳**——没有会话消息、没有提示词、没有摘要。日志只打印冷却写入事件，不打印状态文件原文。

---

## 3. 模型池与调度

### 3.1 结构

```
模型池（配置化）
├── Tier 1: [model_A, model_B, model_C, model_D]
├── Tier 2: [model_E, model_F]
└── 兜底: 会话模型（可关闭，默认开启）
```

每个 Tier 内的模型**独立计费、独立冷却**，互不影响。

### 3.2 分块与并发

**默认所有分块一起压缩**——不设批次。所有 chunk 同时进入调度，受**单个模型的并发上限**约束。

每个模型可配置自己的 `maxConcurrent`（默认 1）：

```yaml
- provider: openrouter
  model: openrouter/free
  maxConcurrent: 1
  cooldown: { mode: dailyReset, hour: 0 }
```

调度流程：

1. 所有 chunk 进入待分配队列。
2. 每个 chunk 从当前 Tier 的健康模型池中选一个模型，条件是该模型当前并发数 < `maxConcurrent`。
3. 若所有健康模型都达到并发上限，chunk 排队等待，直到有模型释放槽位或冷却到期。
4. 若当前 Tier 无健康模型（全部冷却），整体降级到下一 Tier。

### 3.3 单 chunk 失败处理

```
chunk 选定模型 → 调用
  ├─ 成功 → 标记完成，释放并发槽位
  └─ DSH retryPolicy 耗尽 → 插件介入
       ├─ 读该模型 cooldown 配置 → 写入 cooldownUntil
       ├─ 释放并发槽位
       ├─ 当前 Tier 仍有健康模型 → 该 chunk 换一个模型重试
       └─ 当前 Tier 无健康模型 → 进入降级队列
```

单个 chunk 失败不会导致整个 Tier 降级。只有当前 Tier 所有模型都不可用时，才触发 Tier 降级。

### 3.4 降级与兜底

```
当前 Tier 健康模型集合 = { m | m.cooldownUntil <= now }
若集合为空 → 降级到下一 Tier
若集合非空 → 失败的 chunk 继续从集合中分配模型
```

若所有 Tier 都无健康模型：

- 兜底开启（默认）→ **直接调用默认压缩插件**（`dsh-compaction-basic` 的 `summarize`）。实现方式：把原始区域输入（`buildSummarizationInput` 的 `{ tools?, messages }`，即 system + 区域消息，**未修改**，与最近 routed 请求保持相同消息前缀）交给默认插件；其内部在末尾追加压缩指令作为最后一条 user 消息——即默认的 KV 缓存复用压缩（"按照默认的行为压缩"）。该调用是覆盖整个区域的**单次调用**：若区域本可单分块覆盖，则一次完成（不经过分块/归并）。兜底**不经过 Stage 0/分块**（保前缀一致性，否则会破坏 KV 缓存前缀）。
- 兜底关闭 → 直接向上抛，交给内置 `compaction/summary-error` 恢复

若会话模型也失败 → 向上抛。

> v3.1：默认压缩插件通过 `lib/default-compression.js` 在一次性 scratch context 上以 `auto: false` 实例化，再重定向到宿主 context 使用其 `llm`——其 `compaction` 服务注册落在 scratch context 上，绝不会顶掉本插件持有的 `ctx.compaction`。

---

## 4. 冷却规范

每个模型二选一：

```yaml
# 模式 1：固定时长冷却
cooldown: { mode: duration, hours: 5 }

# 模式 2：每日固定时刻重置（UTC）
cooldown: { mode: dailyReset, hour: 0 }
```

- **`duration`**：`cooldownUntil = now + hours × 3600 × 1000`。单位小时，支持小数（`0.5` = 30 分钟）。
- **`dailyReset`**：`cooldownUntil = 下一个 UTC hour 点`（若今天该时刻已过，则为明天该时刻）。

无论错误是什么（429/402/401/5xx/TIMEOUT/EMPTY_RESPONSE），DSH retryPolicy 耗尽后统一按该模型配置冷却。不做错误分类，不解析响应头，不区分临时故障与永久故障。周/月套餐用 `dailyReset` 每日探测一次；5 小时窗口用 `duration, hours: 5`。

---

## 5. Stage 0 预处理管线

顺序：

1. **0a 确定性修剪**：去重 → 错误净化 → head-middle-tail（`thresholdChars: 8192, headChars: 4096, tailChars: 1024`）→ 块跳过
2. **0b 语义压缩**：AST 骨架化（`maxDepth: 2`）+ 日志冷凝（`mode: balanced, maxLines: 200`，保留 `[condensed: N lines removed]` 元信息行）
3. **0c 重叠分块**（见 5.1）
4. 每块走 ModelChain
5. 归并走 ModelChain

全部内嵌算法（MIT 思想），不安装 dsh-dcp/dshx/dsh-context-lens，避免与内置 toolResultPruner/compaction 接缝双重重叠。

> v3.1：Stage 0 与重叠分块作用于 **ModelChain 路径**。**兜底路径不经过 Stage 0/分块**——直接调用默认压缩插件，重放未修改的会话前缀以复用 KV 缓存，单次调用完成（区域单分块足够时即一次完成）。

**最终摘要仍须小于原区域**（内置校验不变）。

### 5.1 重叠分块

核心区间按 `chunkTokens = 模型上下文窗口 × chunkRatio` 切分，相邻 chunk 之间保留 `chunkTokens × chunkOverlapRatio` 的重叠：

```
core_1: [========]
core_2:          [========]
core_3:                   [========]

chunk_1 = [core_1 + 后向 overlap]
chunk_2 = [前向 overlap + core_2 + 后向 overlap]
chunk_3 = [前向 overlap + core_3]
```

- 首 chunk 无前向 overlap，尾 chunk 无后向 overlap。
- overlap 边界对齐到**最近的换行符或句末标点**，避免切断词或代码行。
- 切割点附近的完整句子/代码行会同时出现在相邻两个 chunk 中，由归并模型去重。

分块本身不调用 LLM——纯计算操作，按 token 计数 + 换行对齐。

### 5.2 补充提示词

两个可选的补充提示词，追加到内置 prompt 之后，默认空：

- **`chunkPromptSuffix`**：追加到每个 chunk 的摘要 prompt 末尾。用于控制单块摘要风格（如"保留所有数字""代码块用 markdown 标注"）。
- **`mergePromptSuffix`**：追加到归并 prompt 末尾。用于控制合成行为（如去重说明、风格约束）。

放在 prompt 末尾的原因：模型对末尾的关注度通常更高，补充指令更容易被遵守。

---

## 6. 配置面（定稿）

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: dsh-quilt-compact
      name: 'dsh-quilt-compact'
      config:
        chunkRatio: 0.8              # chunkTokens = 模型上下文窗口 × chunkRatio
        chunkOverlapRatio: 0.1       # 相邻 chunk 重叠比例
        fallbackToSessionModel: true # 会话模型兜底，可关闭

        # 补充提示词（可选，默认空）
        chunkPromptSuffix: ''
        mergePromptSuffix: ''

        tiers:
          - name: primary
            models:
              - provider: openrouter
                model: openrouter/free
                maxConcurrent: 1
                cooldown: { mode: dailyReset, hour: 0 }
              - provider: sensenova-1
                model: sensenova-6.8-flash-lite
                maxConcurrent: 1
                cooldown: { mode: duration, hours: 5 }
              - provider: sensenova-1
                model: deepseek-v4-flash
                maxConcurrent: 1
                cooldown: { mode: duration, hours: 5 }
              - provider: trae
                model: deepseek-v4.1-flash
                maxConcurrent: 1
                cooldown: { mode: duration, hours: 5 }
          - name: fallback
            models:
              - provider: workbuddy
                model: glm-5.3-flash
                maxConcurrent: 1
                cooldown: { mode: dailyReset, hour: 8 }
              - provider: workbuddy
                model: hy3
                maxConcurrent: 1
                cooldown: { mode: dailyReset, hour: 8 }

        # 请求重试完全复用 DSH retryPolicy

        preprocessing:
          dedup: true
          purgeErrors: true
          headMiddleTail: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
          astSkeleton: { enabled: true, maxDepth: 2 }
          logCondense: { mode: balanced, maxLines: 200 }
```

---

## 7. 状态模型

```ts
{
  cooldownUntil: number,   // epoch ms，唯一字段
}
```

- `cooldownUntil <= now` → 健康
- 持久化只在写入时落盘
- 到期后懒清理，不主动写回
- `dailyReset` 模式的 `cooldownUntil` 本身就是下一个重置点，不需要额外清零

---

## 8. 实现清单

1. **包骨架** + cordis 注册
2. **Stage 0 算法**：去重、错误净化、head-middle-tail、AST 骨架化、日志冷凝、重叠分块
3. **ModelChain 状态机**：Tier 健康模型筛选、chunk 分配、单模型并发槽位管理、降级逻辑
4. **冷却状态管理**：两种模式的 `cooldownUntil` 计算、写入、懒清理
5. **持久化层**：`ctx.storage.domain`
6. **兜底**：会话模型接入（可关闭）——**直接调用默认压缩插件** `dsh-compaction-basic` 的 `summarize`（新增 peer 依赖），重放会话前缀复用 KV 缓存，单次调用；单分块足够时一次完成
7. **补充提示词注入**：chunk 级与归并级
8. **假 LLM 端到端验证**：模拟 DSH retryPolicy 失败、冷却写入、Tier 降级、兜底触发
9. **阈值一致性回归**（v3.2）：`readBasicPolicy()` 与 `dsh-compaction-basic` 默认值一致的断言（含缓存/冻结）；`DEFAULT_MAX_TOKENS = 32768` 与窗口兜底 `262144` 的取值断言
