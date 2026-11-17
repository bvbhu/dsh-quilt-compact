# dsh-quilt-compact

DeepSeek Harness 的上下文压缩增强插件。

**不禁用宿主自带的压缩，不替换 `ctx.compaction`，不注册 adapter。** 只拦截 `purpose === 'compaction'` 的那一次模型调用，把「整段历史一次性交给模型」换成「分块摘要 → 归并」的分层压缩，并在压缩结果里写入 **会话搜索锚点**，便于以后按需找回原文。

- 与 `dsh-compaction-basic` 共存：压力触发、范围选择、压缩事务、`summary is not smaller` 校验全由宿主负责。
- 与 `dsh-connect-*` 类提供模型的插件兼容：不注册 adapter、不重写路由，辅助调用照常走 `ctx.llm.stream`。
- 与 `as-one` 不冲突：as-one 拦截的是网关/适配器层，本插件只在 `llm/stream` waterfall 上改写压缩请求本身，二者不争夺同一个后端。
- 任一环节失败都**回退到宿主原本的摘要**，压缩不会因此失败。

## 工作方式

```
宿主触发压缩（pressure / overflow / /compact）
        │
        └─ dsh-compaction-basic 组装摘要请求（system + 被压缩区间 + 压缩指令）
                │  purpose = 'compaction'
                ▼
        dsh-quilt-compact 拦截 llm/stream
                │
        Stage 0 → 按模型窗口切块 → 逐块摘要 → 归并 → 附加锚点
                │
                ▼
        返回合成流，宿主照常写入 compaction/summary 与检查点
```

失败（分块、归并、池全冷却、摘要不比原文短……）时直接 `next()`，宿主原本的摘要照旧生效。

## 分块与归并

1. **Stage 0** — 摊平消息为行文档，合并重复行、清终端噪音；破坏性变换默认关闭。
2. **切块** — 每块大小按**处理它的那个模型**的可用输入预算现算；块与块之间有重叠。
3. **逐块摘要（Capture）** — 每块产出一个小 digest，并带上 2–5 个**检索关键词**（项目名、型号、分支、错误原文）。
4. **归并（Distill）** — 所有 digest 一次归并为一份检查点。

## 会话搜索锚点

压缩结果末尾附一个机器可读的锚点块：

```xml
<session-search-anchors>
{"id":"QC-XXXX","sessionId":"...","seqStart":12,"seqEnd":40,"chunks":[{"i":1,"lines":[0,120],"tokens":9000,"anchor":"QC-XXXX-1"}]}
</session-search-anchors>
```

配合 `@deepseek-ai/dsh-experimental-session-search`：

- 该插件的全文索引覆盖会话的**全部事件，包括被压缩隐藏（shadowed）的原文**；
- 因此用 `session_event_search(session_id, seq_from, seq_to, query)` 能**精确定位**原文，再用 `session_event_read` 读回完整事件；
- 锚点把这一步从「靠关键词猜」变成「按 seq 区间取」，避免 `session_search` 对通用词（如工具名）的噪声问题。

锚点块是单行 JSON，体积很小；若加上锚点后摘要不比被压缩区间短，本次改写会**主动放弃**并交回宿主，以免触发宿主的收缩校验。

## 安装

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-quilt-compact
```

随包层只插入一行拦截器，不修改 `compaction-basic`，也不重述 `preset-standard`。

## 配置

```yaml
- id: dsh-quilt-compact
  name: 'dsh-quilt-compact/intercept'
  config:
    chunkRatio: 0.8            # 单块占用模型可用输入的比例
    chunkOverlapRatio: 0.1     # 相邻块重叠比例
    mergeMaxContextTokens: 128000
    chunkPromptSuffix: ''
    mergePromptSuffix: ''
    tiers:
      - name: primary
        models:
          - provider: openrouter
            model: openrouter/free
            maxConcurrent: 1
            cooldownHours: 1
    preprocessing:
      dedup: true
      purgeErrors: true
      astSkeleton: { enabled: false, maxDepth: 2 }
      logCondense: { mode: balanced, maxLines: 200 }
```

模型池只用于压缩调用的分块/归并；路由是普通 `provider/model`，所以 `dsh-connect-*` 注册的 provider 可直接填入。

## 兼容性

- 需要 `@deepseek-ai/dsh-llm` 的 `llm/stream` waterfall（当前 desktop `0.2.2-rc.3` 已实测）。
- 旧版「替换 `ctx.compaction`」的实现仍保留在 `lib/engine.js`（`QuiltCompactEngine`）供参考与旧测试使用，但随包层不再挂载它。

## 验证

```sh
node tools/verify-bundle.mjs   # 随包层经 dsh 自己的 loadOverlayPatches 解析
node test/smoke/patch.mjs      # 用 dsh 自己的 composer 断言：不禁用 basic、不重述 preset
node --test test/unit/*.test.js test/e2e/*.test.js
```

## 隐私

默认不保存对话原文。压缩结果只保留摘要、少量检索关键词，以及指向会话自身事件日志的 `session_id` + `seq` 引用。
