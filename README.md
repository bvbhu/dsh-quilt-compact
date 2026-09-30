# dsh-quilt-compact

DeepSeek Harness 的上下文压缩插件。

它替代默认的 `compaction` 后端：**用低价小模型分块完成上下文压缩**——把长
上下文切成多个小分块，逐个交给便宜的小模型摘要，再把摘要归并回一个检查点，
避免把整段上下文一次性喂给昂贵的大模型。

- 支持配置多档模型（不同 tier 放不同规格），按容量自动选用、自动降级。
- 模型调用失败会冷却一段时间，全部不可用时由会话模型兜底。
- 分块、摘要、归并全流程自动完成，最终产出一个小而全的检查点。

## 适用版本

DSH `0.1.7-rc.1`（peer 依赖锁定）。

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
profile 的 `cordis.patch.yml`（后层按行生效）。核心配置是模型池
（`tiers`）与分块参数：

```yaml
- id: dsh-quilt-compact
  config:
    # 分块占用模型窗口可用输入的比例、相邻分块重叠比例。
    chunkRatio: 0.8
    chunkOverlapRatio: 0.1
    # 所有 tier 都冷却时是否由会话模型兜底。
    fallbackToSessionModel: true
    # 有序模型池。cooldown 二选一：duration（小时）或 dailyReset（UTC 时）。
    tiers:
      - name: primary
        models:
          - provider: openrouter
            model: openrouter/free
            maxConcurrent: 1
            cooldown: { mode: dailyReset, hour: 0 }
```

## 隐私

状态文件只含路由冷却时间戳，不含任何会话消息、提示词或摘要。