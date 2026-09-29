# dsh-quilt-compact 设计 v4（激活与设置页重设计）

> 本文档是项目在"参考同类插件、重新设计激活方式"之后的权威架构规格。
> 引擎核心（Stage 0、ModelChain、冷却、持久化）沿用 [design-v3](./design-v3.md)，不在此重复；
> 本文覆盖 **v4 新增/变更**：三类 profile 的激活矩阵、bundle 双分支结构、预设组内行的设置页 bridge。
>
> **v4.1 定稿**（基于对官方插件指南 + 已装第三方插件的完整调研；调研证据链见 §8）：
> 设置页通道最终选定 **方案 A：自建 bridge**（web/desktop 下 configForms 不可用，见 §4.1）。

---

## 0. 为什么需要 v4

旧设计（v3）只在**宿主平面**替换 `compaction`：禁用 `compaction-basic` 行 + 插入 `dsh-quilt-compact` 行。
这在 headless/sdk/custom 等"宿主平面拥有 compaction"的 profile 下正确，但对 **web/desktop** profile 完全无效：

- `dsh-web-app` 禁用宿主平面的 `compaction-basic`/`command-compact`/`tool-result-pruner`，
  真正的压缩后端被 **standard 预设**重挂在 agent 的隔离 realm（`preset-standard` 行的 `compaction` 组）。
- 因此 v3 的宿主平面插入行在 web 下**挂着却不被 agent 使用**；同时若宿主平面也有引擎，
  两个引擎会**同时订阅同一批 `agent/pre-step` / `agent/request-error` 事件**（隔离只管服务解析、不管事件）。

v4 的三个目标：

1. **激活矩阵化**：web/desktop 走预设组内替换；host 平面 profile 走宿主平面替换；同一 bundle 文件内条件分支。
2. **设置页可用**：web/desktop 下设置页必须能改到预设组内的引擎配置（configForms 做不到，见 §4）。
3. **配置单一来源不漂移**：预设组内行与宿主行携带同一份 config，生成器保证初始一致。

---

## 1. 已确认的机制事实（源码逐行核实）

| # | 事实 | 证据 |
|---|---|---|
| M1 | `dsh-agent-preset` 是一个普通 Cordis 插件行（`name: '@deepseek-ai/dsh-agent-preset'`），`[Service.init]` 里 `ctx.agentPresets.register(config)`；`config = {id, name?, description?, order?, plugins[]}` | `dsh-agent-preset/lib/index.js:7-27` |
| M2 | preset 声明行的 Loader 行 id 约定为 `preset-<id>`；**改 preset 必须整行 restate**——patch 对 `config` 是**整对象赋值**，无深度合并 | `dsh-app-boot/lib/index.js:61-110`（`applyEntryPatches`） |
| M3 | patch 的 entryMap 只递归组合层 `group: true` 行的 children；`preset-standard` 不是 group，其 `config.plugins` 对 patch 完全不透明——**组内子行无法被 `- id:` 定位** | `dsh-app-boot/lib/index.js:64-70` |
| M4 | 重复 `insert` 同名 preset 行会触发 registry `Duplicate agent preset`；**改内置 preset 只能 override（按行 id restate），不能 insert** | `dsh-agent-preset-registry/lib/index.js:511` |
| M5 | 预设插件树**急切挂载**；preset 行若把服务"泄露"到 root realm 直接拒绝挂载（"Preset services require isolate realms"），所以组必须 `isolate` | `dsh-agent-preset-registry/lib/types/mount.js:262-285, 271-273` |
| M6 | `isolate` 只隔离**服务解析**（Context.isolate 生成 realm 私有 Symbol）；**事件过滤走 scope carrier tag**：宿主平面（无 tag）监听者全局放行，preset 组监听者因 standing key 是 agent 祖先也放行——**两处引擎都会收到同一批 agent 事件** | `cordis/lib/index.js:1723-1727`、`dsh-scope/lib/index.js:327-338` |
| M7 | 双引擎后果：waterfall 串行 + session 持久锁（`assertCompactionInactive`）避免双提交，但产生竞争与 warn 噪音；**web bundle 实际无双引擎**是因为 web-app 禁用了宿主三行 | `dsh-compaction-basic/lib/index.js:535-538, 843-849` |
| M8 | patch 的 `!!js` disabled 表达式在 Loader 上下文求值，可访问 `ctx.get('profileContext')`（web/desktop 存在，`name` 为 `web`/`desktop`；headless/sdk 亦为 profile，name 不同） | `dsh-web-app/cordis.patch.yml:488-495` 的 `disabled: !!js "!ctx.get('profileContext')"` 先例 |
| M9 | `command-compact` 的 `inject = ["commands", "compaction"]`——与后端同 realm 消费；它必须与 compaction 服务同时在场 | `dsh-command-compact/lib/index.js:9,55` |
| M10 | **没有任何官方/第三方插件替换过 preset 组内服务**；最接近先例是 `dsh-experimental-agent-team-profile`（宿主平面整行替换）与 `dsh-free-search`/`auto-approval-llm`（按 id 覆盖官方行 config） | 全树 grep |
| M11 | `configEditor.entries()` 只返回 **include 树**上唯一 id 的 entry；preset 组内行在独立 PresetTree，**不在其中**；`configEditor.edit()` 按 entry 整行写回 profile patch 并热应用 | `dsh-config-editor/lib/index.js:30-35,63-129` |
| M12 | `dsh-settings.describe()` 枚举 `configEditor.configuration()`，需要 schema + fiber 激活 + 唯一 id；preset 组内行不可寻址；宿主行（id=`dsh-quilt-compact`）在 include 树，configForms 可服务但**编辑它不影响预设组引擎** | `dsh-settings/lib/index.js:413-445` |
| M13 | 第三方设置页现行通道：`plugins.row.config` seat，key = `<包名>#<patch 行 id>`；配置读写走**自建 bridge**（`webServer.register` 的 `{kind:"exact", path, handler}` 路由，loopback-only + POST），不依赖 configForms | `dsh-client-ui-plugin-manager/lib/client.js:27-29,1742`；`dsh-free-search/lib/index.js:1497-1790` |
| M14 | `ctx.llm.listProviders()/listModels()` 运行时权威枚举；provider 由 `registerAdapter`/`registerConfigurableProviders` 动态注册 | `dsh-llm-pi-ai`、`dsh-connect-*`（调研报告 A） |

---

## 2. 激活架构矩阵

```
                        compaction 所有权           我们的激活点
─────────────────────────────────────────────────────────────────────
headless / sdk /       宿主平面（dsh-base 注册      宿主平面：禁用 compaction-basic
sdk-minimal / custom   compaction-basic）           + insert dsh-quilt-compact
（无 web-app bundle）                                （无 !!js 门，或门口求值为 false）

web / desktop          预设组（preset-standard 的   预设组内：整行 restate
（挂 dsh-web-app        compaction 组，isolate      preset-standard，把组内
 bundle）              realm，每 agent 一份）       compaction-basic 换成
                                                    dsh-quilt-compact；
                                                    宿主 insert 行由 !!js 门禁用
                                                    （避免双引擎，M6/M7）
```

### 2.1 分界条件（M8）

- 宿主平面的 `dsh-quilt-compact` insert 行：
  ```yaml
  disabled: !!js "['web', 'desktop'].includes(ctx.get('profileContext')?.name)"
  ```
  web/desktop → true → 宿主行禁用（preset 组接管）；headless/sdk/custom（name 非 web/desktop）→
  宿主行启用。与 `dsh-web-app` 自身的 `disabled: !!js "!ctx.get('profileContext')"` 同一方言。

- `preset-standard` restate 行天然自选：web/desktop 存在该行（restate 生效）；
  host 平面 profile 无该行 → `- id: preset-standard` 报 "not found" 跳过（无害）。
  两分支互斥，同一文件安全共存。

### 2.2 为什么不能只 insert（M3/M4）

`- id: compaction-basic`（组内行）在 patch 引擎中 **not found 跳过**；`insert` 同名 preset 撞
Duplicate。唯一官方通道 = **整行 restate `preset-standard` 的 `config`**：
restate 全部 19 个插件行（persona/agent-instructions/工具/planning 组/compaction 组/delegation
组/...），只把 compaction 组第一行由 `@deepseek-ai/dsh-compaction-basic` 换成
`dsh-quilt-compact`；**组内其余行（command-compact、tool-result-pruner）与 isolate 键原样保留**（M9）。

代价（已知、可接受）：restate 冻结了 standard 预设内容，DSH 升级改 standard 时需重新生成
（`tools/generate-preset-restate.mjs`，文本级替换，绝不手抄）。

---

## 3. Bundle 结构（cordis.patch.yml，已落地并验证）

```
- id: compaction-basic                       # 宿主平面：禁用默认后端
  disabled: true                             #（web 下 web-app 已禁用，幂等）

- insert:
    - id: dsh-quilt-compact                  # 宿主平面：我们的引擎
      name: 'dsh-quilt-compact'
      disabled: !!js "['web','desktop'].includes(...)"   # M8 门
      config: { chunkRatio, tiers, preprocessing, ... }  # 完整默认配置

- id: preset-standard                        # web/desktop：整行 restate
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      - ...（19 行，逐字来自官方 standard.patch.yml）
        - id: compaction                     # 组不变
          group: true
          isolate: { compaction: true, toolResultPruner: true }
          config:
            - id: dsh-quilt-compact          # ← 唯一改动：后端行
              name: 'dsh-quilt-compact'
              config: { 与宿主行完全一致 }    # ← 生成器注入，防漂移
            - id: command-compact            # 原样
            - id: tool-result-pruner         # 原样
```

**关键保障**：预设组内行的 config **由生成器从宿主行复制**（`tools/generate-preset-restate.mjs`
读 cordis.patch.yml 宿主行的 config 注入 restate），并对官方文件做**文本级**编辑——用 YAML 库
重序列化会破坏 `!!js` 表达式（必须保留原始 loader 语法）。`tools/verify-bundle.mjs` 断言：
19 插件、组内三行、isolate、tiers 双份 config 逐字段一致、plan-mode 逐字保留。

**双配置副本语义**：web profile 下 agent 读 preset 组内行；宿主行被门禁用（配置仍可被
configForms 读，但**不影响 agent**）。两处必须同步——生成器 + §5 桥的"预置值"字段共同保证。

---

## 4. 设置页架构（v4 核心新增）

### 4.1 问题：configForms 在 web/desktop 下编辑不到激活引擎（M11/M12）

- headless/sdk：无 web UI，设置页不适用；配置走 profile patch。
- web/desktop：agent 用的引擎是 **preset 组内行**（PresetTree），不在 `configEditor.entries()`
  （include 树）→ `dsh-settings.describe()` 枚举不到 → `whileServed` 永不满足 → 卡片不显示；
  即使显示，编辑宿主行也不影响预设组引擎。

**结论**：web profile 设置页必须走**自建 bridge**（M13 官方先例），它直接读写
`preset-standard` 行的嵌套 config，绕开 configForms 的寻址限制。

### 4.2 Bridge API（host 侧，`webServer.register`）

三个路由（`{kind:"exact", path, handler}`，loopback-only + POST，同 free-search 守卫）：

```
POST /api/dsh-quilt-compact/describe
  → { ok: true, value: { config, source: 'preset'|'host', revision, catalog } }
    config   当前激活引擎的完整配置（web → preset 组内行；host 平面 → 宿主行）
    source   写入路径选择器
    revision mutation 的乐观锁（config 内容哈希）
    catalog  { groups: [{id, name, models:[{id, name}]}] }  ← ctx.llm 运行时枚举（M14），
             设置页 provider/model 下拉只从这里取值（用户要求的"只读已配置模型"）

POST /api/dsh-quilt-compact/mutate
  body: { revision, config }
  → { ok: true } | { ok: false, code: 'conflict'|'invalid'|'rejected', message }
  流程：
    1. 校验 revision 与当前一致（冲突 → 'conflict'）
    2. schema 校验（tier 名唯一 / cooldown 二选一 / ratio 范围等，复用 lib/config.js）
    3. web → 定位 profile patch 中 preset-standard 行 → 构造新 config（改 plugins 内
       compaction 组 dsh-quilt-compact 行的 config）→ configEditor.edit(entry, ...)
       （M11：该行在 include 树、有 fiber、可编辑；整行写回 + 热应用）
    4. host 平面 → configEditor.edit(dsh-quilt-compact entry, ...)

POST /api/dsh-quilt-compact/status
  → { ok: true, value: { engineServing: 'preset'|'host'|'none', basicDisabled: bool, presetOverridden: bool } }
  诊断：设置页显示"当前生效路径"，避免用户误以为在编辑生效配置。
```

### 4.3 Client 接线（client/client.js 改造）

- seat：`ctx.slots.inject('plugins.row.config', ...)`，`key: 'dsh-quilt-compact#dsh-quilt-compact'`
  （M13 的 `<包名>#<patch 行 id>`；patch 行 id = insert 行的 `dsh-quilt-compact`）。
- 数据通道：**全部改 fetch bridge**，不再用 `configForms.getSnapshot()`/`scope.mutate()`。
  - 加载：`fetch('/api/dsh-quilt-compact/describe')` → 渲染
  - 保存：`fetch('/api/dsh-quilt-compact/mutate', {method:'POST', body:{revision, config}})`，
    revision 不一致 → 冲突提示 + 重载
  - 目录：describe 返回的 catalog 驱动 provider/model 下拉（无自由输入，延续现有 UI）
  - 保存成功 → `location.reload()` 或刷新 describe（Engine 监听 `loader/volatile-update` 复检）
- 保留现有 zh+en locale、表单校验、CSS token（仅 `--dsw-alias-*`）。
- **回退**：若 `/api/dsh-quilt-compact/*` 404（老版本 host 或非 webServer 环境），显示只读提示
  并引导用 profile patch。

### 4.4 为什么 bridge 必须读/写 preset-standard 顶层行而不是组内行

组内行不可寻址（M3/M11）；`preset-standard` 是 include 树的**顶层 entry**（id=`preset-standard`、
name=agent-preset、fiber 激活），`configEditor.edit()` 整行写回——这是**唯一**能被官方持久化
通道（锁 + 热应用 + 冲突检测）处理的写入路径。

---

## 5. 已知限制（如实记录）

1. **restate 冻结**：standard 预设内容随本 bundle 固定；DSH 升级改动 standard 时需重跑
   `tools/generate-preset-restate.mjs`。仅覆盖 `preset-standard`（默认预设）；用户在 Web 编辑器
   切换到 minimal/ptc/cordis 预设时，本插件不生效（README 注明）。
2. **双配置副本**：宿主行与预设组内行各一份 config；bridge 只写激活的那一份，另一份可能过期。
   缓解：生成器保证初始一致；README 提示改配置走设置页（写激活份）或重跑生成器。
3. **!!js 门基于 profile name**：自定义 profile 若手工挂 web-app bundle 且名字不是 web/desktop，
   !!js 门会放行宿主行 → 与预设组双引擎（M7 竞争噪音）。README 警告该场景手动禁用宿主行。
4. **bridge 依赖 webServer**：headless/sdk 无 webServer、无设置页；bridge 路由注册需条件化
   （`ctx.inject(['webServer', ...])` 存在才注册，同 free-search）。
5. **无自动表单渲染器**：dsh-settings 不带浏览器表单（README:39 官方确认）；设置页即
   client/client.js 本身，bridge 承担描述/校验/持久化。

---

## 8. 调研证据链（v4.1 新增，基于 dsh 0.1.7-rc.1）

### 8.1 官方插件指南（`dsh-agent-preset/skills/`）

| 指南 | 关键论断 | 对本设计的含义 |
|---|---|---|
| `cordis-plugin-development/SKILL.md` | 插件=workspace bundle → `plugin_manager install_bundle`；配置入口官方立场 "Put tunable values in the plugin's `Config` so users change them in `cordis.patch.yml`; the user's patch layer survives upgrades" | patch 层永远是配置真相源；设置页只是便利面 |
| `references/practices.md` | 扩展点强弱排序；`ctx.tools.restrict/guard` 最弱；瀑布监听器需 `next()`；可调值进 Config | 我们只替换 `compaction` 服务（最强机制），必须完整保留其他贡献 |
| `references/host-plugin.md` | `apply(ctx, config)` / 服务类导出；资源用 `ctx.effect`/`ctx.on`；Config 校验在激活时 | 我们的引擎即 `QuiltCompactEngine` 服务类 + `static Config` |
| `editing-cordis-compositions/SKILL.md` | **"A preset plugin that supplies a service must isolate the provider and all its consumers in the same realm. A service consumed by Host plugins belongs in the Host configuration."**；改预设=整行 restate（非 insert） | compaction 在 web = preset 作用域，必须组内替换并保留 isolate + 同 realm 消费者 |
| `cordis-composition-reference/SKILL.md` | insert/override-by-id/group/disabled/isolate/`!!js` 方言 | 组内子行不可 patch 定位；restate 是唯一通道 |

### 8.2 官方与第三方插件先例

| 插件 | 动官方服务吗 | 方式 | 设置页 |
|---|---|---|---|
| `dsh-experimental-agent-team-profile`（官方） | ✅ 宿主平面 | 禁用 4 官方行 + insert 替代 | 无 |
| `dsh-client-ui-settings-subagent`（官方） | 不碰服务 | — | **`plugins.item` + `configForms.whileServed`**（现行官方通道！） |
| `dsh-free-search`（已装） | 配置级覆盖官方 `web` 行 | id-config 行 | **自建 bridge** `{kind:'exact', path, handler}` 8 路由 |
| `@quill507/dsh-auto-approval-llm`（已装） | 覆盖官方 `permission` presets | id-config 行 | `plugins.row.config` + fetch bridge |
| `dsh-connect-workbuddy/-trae`（已装） | 不碰 | 只 insert | `configForms` + 双 slot（`plugins.bundle.config`/`plugins.row.config`） |

### 8.3 决定性事实

1. `configEditor.entries()` 只含 include 树唯一 id entry（`dsh-config-editor/lib/index.js:30-35`）；preset 组内行在 PresetTree，不可寻址。
2. `dsh-settings.describe()` 要求 `entry.fiber.state === 2`（激活态）+ 唯一 id + schema（`dsh-settings/lib/index.js:417`）；web/desktop 下 host 行被 !!js 门禁用 → **configForms 完全不服务 `dsh-quilt-compact` namespace**（设置页不显示，连只读都没有）。
3. `dsh-settings` README 明言 "Nested Includes own separate configurations and are not editable through the active profile's form"。
4. 官方 `dsh-client-ui-settings-subagent` 自身用 `plugins.item` + configForms——**这是 0.1.7-rc.1 的现行官方设置页通道**，但只对 include 树激活行有效；对 preset 组内行失效（free-search 注释所称"废弃"者应是更旧的 slot 变体）。
5. `webserver`（dsh-host-webserver）由 **dsh-web-app 挂载**（patch：`- id: webserver`）；headless/sdk 无 webServer → bridge 路由条件注册（`ctx.inject(['webServer',...])` 存在才注册，同 free-search）。
6. 真实合成验证（`test/smoke/compose-web.mjs`）：web-app 6 个 patch 文件 + 用户 profile 17 patches + 我们的 bundle → 167 行合成，`preset-standard` 19 插件，compaction 组 = `dsh-quilt-compact, command-compact, tool-result-pruner`，isolate 保留，host 行 !!js 门原样存活。

### 8.4 由此确定的最合适方案

- **激活**：bundle 双分支（宿主平面禁用+insert / preset-standard 整行 restate）——官方指南唯一通道，合成验证通过。
- **设置页**：自建 bridge（方案 A）——因为 configForms 对 web/desktop 的 preset 组内行**无能为力**（非"只读"问题，而是 namespace 完全不可见），官方先例（free-search/auto-approval）均为自建 bridge + `plugins.row.config` seat。

---

## 9. 实现清单（v4 剩余）

1. [x] bundle 双分支（cordis.patch.yml）：host 门 + preset-standard restate
2. [x] 生成器 `tools/generate-preset-restate.mjs`（文本级，注入宿主 config）
3. [x] 验证器 `tools/verify-bundle.mjs`（19 插件/组/isolete/tiers 双份一致/plan-mode 逐字）
4. [x] host 侧 bridge：`lib/bridge.js`（describe/mutate/status + webServer 注册 + 守卫）
5. [x] `lib/bridge-host.js`：`createBridgeDeps`（locate/read/write/catalog/status）+ `registerQuiltBridge`（引擎挂载时注册，webServer 缺失 no-op）；Engine 保持 `loader/volatile-update` 复检
6. [x] client：`plugins.row.config` seat（key `dsh-quilt-compact#dsh-quilt-compact`）+ fetch bridge 数据层（替换 configForms）
7. [x] 测试：bridge 单测 21 个（describe/mutate/conflict/schema/守卫/定位）、client-render 适配新 seat + fetch 桩、compose-web 合成断言预设组含 dsh-quilt-compact
8. [x] 全量验证：77 单测 + 10 e2e + 7 smoke 全绿
9. [ ] README：激活矩阵、设置页（bridge）、Uninstalling（web 需一并撤 preset-standard restate）、已知限制
10. [ ] 提交（本地 commit，GitHub 由用户强推）

---

## 10. 验证计划

| 验证点 | 方法 |
|---|---|
| bundle 可被 dsh parser 解析 | `tools/verify-bundle.mjs`（已绿） |
| 双份 config 不漂移 | generate → verify 循环（已绿） |
| web 合成含 preset 组引擎 | 用 `composeEntries` 合成 web profile 全层，断言 compaction 组 |
| bridge describe/mutate | 单测：mock configEditor + llm；冲突/校验用例 |
| 设置页渲染/保存 | client-render smoke：新 seat + fetch 桩 |
| 事件无双引擎 | 断言 web 合成下宿主 insert 行 `disabled=true`（!!js 求值模拟） |