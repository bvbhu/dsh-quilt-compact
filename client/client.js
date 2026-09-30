/**
 * Browser half of dsh-quilt-compact: the settings page for the compaction-chain
 * model pool.
 *
 * Registers one card into the Plugins page's `plugins.row.config` seat under
 * `<package>#<row id>` and edits the backend's Config through the settings
 * bridge (`/api/dsh-quilt-compact/*`), writing the WHOLE `tiers` array as one
 * payload because the config layer replaces arrays wholesale rather than
 * merging them.
 *
 * Why a bridge rather than `configForms`: in web/desktop profiles the backend
 * runs inside the `standard` agent preset's `compaction` group, and
 * `dsh-settings` only exposes active include-tree entries — the preset-group
 * row is not one, so configForms cannot serve it. The bridge is registered by
 * the engine instance itself and persists through `configEditor`, exactly like
 * the official editor.
 *
 * Provider and model are always chosen from the models actually configured in
 * this installation (the bridge's runtime catalog), never typed by hand. A
 * saved route that is no longer in the catalog stays visible, marked
 * unavailable, so the user can see it and remove it.
 *
 * Style follows the host: `--dsw-alias-*` tokens only, and every visible string
 * goes through `ctx.locale`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quilt-compact',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');

    // --- namespace + locale --------------------------------------------------
    /** Locale dictionary namespace for this page. */
    const LOCALE_NS = 'settings.dsh-quilt-compact';
    /**
     * Config namespace: the profile entry id, which is the package name because
     * the bundle's patch inserts the row under exactly that id.
     */
    const CONFIG_NS = 'dsh-quilt-compact';

    const zh = {
      title: '压缩链模型池',
      description: '分层模型池、分块比例与 Stage 0 预处理。改动立即生效，无需重启。',
      poolHeading: '模型池（按顺序尝试）',
      poolHint: '同一层内按顺序尝试；该层全部冷却时进入下一层。',
      tier: '层',
      tierName: '层名称',
      tierRemove: '删除此层',
      tierAdd: '添加层',
      modelAdd: '添加模型',
      modelRemove: '删除',
      provider: '提供方',
      model: '模型',
      maxConcurrent: '并发数',
      cooldownMode: '冷却方式',
      cooldownDuration: '按小时',
      cooldownDaily: '每日重置',
      cooldownHours: '小时数',
      cooldownHour: 'UTC 小时',
      unavailable: '当前不可用',
      unavailableHint: '该模型已不在已配置列表中，请删除或改选。',
      catalogLoading: '正在读取已配置的模型…',
      catalogFailed: '无法读取已配置的模型列表。',
      catalogPartial: '部分提供方读取失败；已保存的选择仍可删除。',
      catalogEmpty: '当前没有任何已配置的模型。',
      retry: '重试',
      tuningHeading: '分块与兜底',
      chunkRatio: '分块比例',
      chunkRatioHint: '单个分块占模型上下文窗口的比例。',
      chunkOverlapRatio: '分块重叠比例',
      chunkOverlapHint: '相邻分块的重叠比例，必须小于 1。',
      fallbackToSessionModel: '会话模型兜底',
      fallbackHint: '所有层都冷却时，改用当前会话模型压缩。',
      chunkPromptSuffix: '分块提示词后缀',
      mergePromptSuffix: '合并提示词后缀',
      preprocessingHeading: 'Stage 0 预处理',
      dedup: '去重',
      purgeErrors: '清理错误输出',
      astSkeleton: 'AST 骨架',
      maxDepth: '最大深度',
      logCondense: '日志压缩',
      logCondenseMode: '模式',
      maxLines: '最大行数',
      modeBalanced: '均衡',
      modeHead: '保留头部',
      modeTail: '保留尾部',
      runRecordHeading: '运行记录',
      runRecordEnabled: '记录每次压缩（快照 + 结果）',
      runRecordMaxEntries: '保留条数',
      runRecordSnapshotChars: '快照字符上限',
      runRecordHint: '每次压缩写入一行 JSON 到 ~/.dsh/storages/dsh_quilt_compact_runs.jsonl：输入快照、输出摘要、路由与统计。用于事后评价压缩质量。',
      enabled: '启用',
      save: '保存',
      discard: '放弃更改',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败，请重试。',
      conflict: '配置已在别处更改。请放弃草稿后重试。',
      readonly: '当前 profile 不接受表单写入。',
      loading: '正在读取配置…',
      loadFailed: '无法读取配置。',
      invalidTierName: '层名称不能为空，且不能重复。',
      invalidPool: '至少需要一个层，且每层至少需要一个模型。',
      invalidCooldown: '冷却时长必须大于 0，UTC 小时必须是 0–23 的整数。',
      invalidRatio: '分块比例必须在 (0, 1] 之间，重叠比例必须小于 1。',
      sourcePreset: '当前引擎在标准预设的压缩组内运行（web 桌面版）。',
      sourceHost: '当前引擎在宿主平面运行。',
      sourceNone: '未检测到激活的压缩引擎。',
    };

    const en = {
      title: 'Compaction-chain model pool',
      description: 'Tiered model pool, chunking ratios, and Stage 0 preprocessing. Changes apply immediately — no restart.',
      poolHeading: 'Model pool (tried in order)',
      poolHint: 'Models are tried in order within a tier; a fully cooled tier falls through to the next.',
      tier: 'Tier',
      tierName: 'Tier name',
      tierRemove: 'Remove this tier',
      tierAdd: 'Add tier',
      modelAdd: 'Add model',
      modelRemove: 'Remove',
      provider: 'Provider',
      model: 'Model',
      maxConcurrent: 'Concurrency',
      cooldownMode: 'Cooldown',
      cooldownDuration: 'For hours',
      cooldownDaily: 'Daily reset',
      cooldownHours: 'Hours',
      cooldownHour: 'UTC hour',
      unavailable: 'Currently unavailable',
      unavailableHint: 'This model is no longer configured. Remove it or pick another.',
      catalogLoading: 'Reading the configured models…',
      catalogFailed: 'The configured model list could not be read.',
      catalogPartial: 'Some providers could not be read; saved choices can still be removed.',
      catalogEmpty: 'No model is currently configured.',
      retry: 'Retry',
      tuningHeading: 'Chunking and fallback',
      chunkRatio: 'Chunk ratio',
      chunkRatioHint: 'Share of a model context window one chunk may occupy.',
      chunkOverlapRatio: 'Chunk overlap ratio',
      chunkOverlapHint: 'Overlap between adjacent chunks; must be less than 1.',
      fallbackToSessionModel: 'Session-model fallback',
      fallbackHint: 'When every tier is cooled, compact with the current session model.',
      chunkPromptSuffix: 'Chunk prompt suffix',
      mergePromptSuffix: 'Merge prompt suffix',
      preprocessingHeading: 'Stage 0 preprocessing',
      dedup: 'Deduplicate',
      purgeErrors: 'Purge error output',
      astSkeleton: 'AST skeleton',
      maxDepth: 'Max depth',
      logCondense: 'Log condense',
      logCondenseMode: 'Mode',
      maxLines: 'Max lines',
      modeBalanced: 'Balanced',
      modeHead: 'Head',
      modeTail: 'Tail',
      runRecordHeading: 'Run log',
      runRecordEnabled: 'Record every compaction (snapshot + result)',
      runRecordMaxEntries: 'Entries kept',
      runRecordSnapshotChars: 'Snapshot char cap',
      runRecordHint: 'Each compaction appends one JSON line to ~/.dsh/storages/dsh_quilt_compact_runs.jsonl: input snapshot, output digest, route, and stats — for evaluating compression quality later.',
      enabled: 'Enabled',
      save: 'Save',
      discard: 'Discard changes',
      saving: 'Saving…',
      saved: 'Saved',
      failed: 'Save failed. Please try again.',
      conflict: 'The configuration changed elsewhere. Discard your draft and try again.',
      readonly: 'This profile does not accept form writes.',
      loading: 'Reading configuration…',
      loadFailed: 'Configuration could not be read.',
      invalidTierName: 'Tier names must be non-empty and unique.',
      invalidPool: 'At least one tier is required, each with at least one model.',
      invalidCooldown: 'Duration must be greater than 0; the UTC hour must be an integer 0–23.',
      invalidRatio: 'Chunk ratio must be in (0, 1]; overlap ratio must be less than 1.',
      sourcePreset: 'The engine runs inside the standard preset\'s compaction group (web/desktop).',
      sourceHost: 'The engine runs on the host plane.',
      sourceNone: 'No active compaction engine detected.',
    };

    // --- styles (host theme tokens only) -------------------------------------
    // Card language mirrors dsh-connect-trae's plugin card: a collapsible shell
    // with a pure-CSS caret (the host primitives' chevron icon names are not a
    // stable contract across DSH releases — a border caret is version-proof),
    // a tab bar, and token-only surfaces. No literal colors anywhere.
    const CSS = `
.qc{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.qc-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;align-items:center;gap:12px;padding:14px 16px;display:flex}
.qc-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.qc-head-copy{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.qc-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.qc-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.qc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;width:16px;height:16px;position:relative;transition:transform .16s}
.qc-chevron::before{content:"";display:block;position:absolute;left:4px;top:5px;width:7px;height:7px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}
.qc-chevron-open{transform:rotate(180deg)}
.qc-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding:0 0 14px;flex-direction:column;gap:14px;display:flex}
.qc-tabs{flex-direction:row;gap:6px;margin-top:12px;padding:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);display:flex}
.qc-tab{appearance:none;font:inherit;cursor:pointer;flex:1;min-width:0;border:0;border-radius:7px;padding:7px 10px;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:500;line-height:18px;background:transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qc-tab:hover:not(.qc-tab-active){color:var(--dsw-alias-label-primary)}
.qc-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.qc-tab-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}
.qc-panel{flex-direction:column;gap:14px;display:flex}
.qc-section{flex-direction:column;gap:10px;display:flex}
.qc h3{font:inherit;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.qc-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin:0}
.qc-notice{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.qc-warn{color:var(--dsw-alias-label-primary);font-size:12px;margin:0}
.qc-error{color:var(--dsw-alias-label-primary);font-size:12px;margin:0}
.qc-list{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;flex-direction:column;display:flex}
.qc-tierHead{align-items:center;gap:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-wrap:wrap}
.qc-model{grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:7px;padding:10px 12px;display:grid}
.qc-model+.qc-model{border-top:.5px solid var(--dsw-alias-border-l2)}
.qc-model-head{grid-column:1/-1;align-items:center;gap:8px;min-width:0;display:flex;flex-wrap:wrap}
.qc-field{flex-direction:column;gap:4px;min-width:0;display:flex}
.qc-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.qc-field input,.qc-field select{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 6px;min-width:0}
.qc-grow{flex:1 1 160px}
.qc-num{flex:0 0 96px}
.qc-unavailable{align-items:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.qc-badge{border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.qc-actions{gap:8px;flex-wrap:wrap;align-items:center;display:flex}
.qc-btn{appearance:none;font:inherit;cursor:pointer;border:.5px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.qc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.qc-btn:disabled{opacity:.4;cursor:default}
.qc-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.qc-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.qc-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.qc-btn-primary:hover:not(:disabled){opacity:.9}
.qc-btn-sm{font-size:12px;padding:3px 10px}
.qc-toggle{align-items:center;gap:8px;display:flex}
.qc-toggle input{accent-color:var(--dsw-alias-brand-primary)}
.qc-grid{grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:10px;display:grid}
.qc-footer{gap:8px;flex-wrap:wrap;align-items:center;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px;display:flex}
`;
    const CSS_TAG_ID = 'dsh-quilt-compact/settings.css';
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-quilt-compact';
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // --- config <-> form model ----------------------------------------------
    /** Cooldown defaults applied when a model row is first created. */
    const DEFAULT_COOLDOWN = { mode: 'duration', hours: 5 };
    /** Fallback values used when the stored config omits a field. */
    const FALLBACK = {
      chunkRatio: 0.8,
      chunkOverlapRatio: 0.1,
      fallbackToSessionModel: true,
      chunkPromptSuffix: '',
      mergePromptSuffix: '',
      preprocessing: {
        dedup: true,
        purgeErrors: true,
        astSkeleton: { enabled: true, maxDepth: 2 },
        logCondense: { mode: 'balanced', maxLines: 200 },
      },
      runRecord: { enabled: false, maxEntries: 200, snapshotChars: 20000, path: '' },
    };

    /** A finite number, or the fallback. */
    const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
    /** A boolean, or the fallback. */
    const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
    /** A string, or the fallback. */
    const str = (value, fallback) => (typeof value === 'string' ? value : fallback);

    /** Route key for one pool entry. */
    const routeKey = (entry) => `${entry.provider}/${entry.model}`;

    /**
     * Normalize one stored cooldown into exactly one legal mode.
     * @param raw - the stored value.
     * @returns `{mode:'duration',hours}` or `{mode:'dailyReset',hour}`.
     */
    function readCooldown(raw) {
      if (raw !== null && typeof raw === 'object') {
        if (raw.mode === 'dailyReset') {
          const hour = num(raw.hour, 0);
          return { mode: 'dailyReset', hour: Math.min(23, Math.max(0, Math.trunc(hour))) };
        }
        if (raw.mode === 'duration') {
          const hours = num(raw.hours, DEFAULT_COOLDOWN.hours);
          return { mode: 'duration', hours: hours > 0 ? hours : DEFAULT_COOLDOWN.hours };
        }
      }
      return { ...DEFAULT_COOLDOWN };
    }

    /**
     * Project the stored config into the editable draft.
     * @param value - the namespace's current value, possibly `undefined`.
     * @returns a fully populated draft.
     */
    function toDraft(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      const pre = source.preprocessing !== null && typeof source.preprocessing === 'object' ? source.preprocessing : {};
      const ast = pre.astSkeleton !== null && typeof pre.astSkeleton === 'object' ? pre.astSkeleton : {};
      const log = pre.logCondense !== null && typeof pre.logCondense === 'object' ? pre.logCondense : {};
      const rr = source.runRecord !== null && typeof source.runRecord === 'object' ? source.runRecord : {};
      const tiers = Array.isArray(source.tiers) ? source.tiers : [];
      return {
        chunkRatio: num(source.chunkRatio, FALLBACK.chunkRatio),
        chunkOverlapRatio: num(source.chunkOverlapRatio, FALLBACK.chunkOverlapRatio),
        fallbackToSessionModel: bool(source.fallbackToSessionModel, FALLBACK.fallbackToSessionModel),
        chunkPromptSuffix: str(source.chunkPromptSuffix, FALLBACK.chunkPromptSuffix),
        mergePromptSuffix: str(source.mergePromptSuffix, FALLBACK.mergePromptSuffix),
        tiers: tiers.map((tier, index) => ({
          name: str(tier?.name, `tier ${index + 1}`),
          models: (Array.isArray(tier?.models) ? tier.models : []).map((model) => ({
            provider: str(model?.provider, ''),
            model: str(model?.model, ''),
            maxConcurrent: num(model?.maxConcurrent, 1),
            cooldown: readCooldown(model?.cooldown),
          })),
        })),
        preprocessing: {
          dedup: bool(pre.dedup, FALLBACK.preprocessing.dedup),
          purgeErrors: bool(pre.purgeErrors, FALLBACK.preprocessing.purgeErrors),
          astSkeleton: {
            enabled: bool(ast.enabled, FALLBACK.preprocessing.astSkeleton.enabled),
            maxDepth: num(ast.maxDepth, FALLBACK.preprocessing.astSkeleton.maxDepth),
          },
          logCondense: {
            mode: ['balanced', 'head', 'tail'].includes(log.mode) ? log.mode : FALLBACK.preprocessing.logCondense.mode,
            maxLines: num(log.maxLines, FALLBACK.preprocessing.logCondense.maxLines),
          },
        },
        runRecord: {
          enabled: bool(rr.enabled, FALLBACK.runRecord.enabled),
          maxEntries: num(rr.maxEntries, FALLBACK.runRecord.maxEntries),
          snapshotChars: num(rr.snapshotChars, FALLBACK.runRecord.snapshotChars),
          path: str(rr.path, FALLBACK.runRecord.path),
        },
      };
    }

    /**
     * Serialize the draft into clean JSON for the write.
     *
     * The host rejects `undefined` array entries, non-finite numbers, cycles and
     * class instances, so every value is built explicitly here rather than
     * spread from React state.
     *
     * @param draft - the edited draft.
     * @returns a JSON-shaped config object.
     */
    function toConfig(draft) {
      return {
        chunkRatio: num(draft.chunkRatio, FALLBACK.chunkRatio),
        chunkOverlapRatio: num(draft.chunkOverlapRatio, FALLBACK.chunkOverlapRatio),
        fallbackToSessionModel: draft.fallbackToSessionModel === true,
        chunkPromptSuffix: String(draft.chunkPromptSuffix ?? ''),
        mergePromptSuffix: String(draft.mergePromptSuffix ?? ''),
        tiers: draft.tiers.map((tier) => ({
          name: String(tier.name ?? ''),
          models: tier.models.map((model) => {
            const entry = {
              provider: String(model.provider ?? ''),
              model: String(model.model ?? ''),
              maxConcurrent: Math.max(1, Math.trunc(num(model.maxConcurrent, 1))),
            };
            // Exactly one cooldown shape, never both.
            entry.cooldown = model.cooldown.mode === 'dailyReset'
              ? { mode: 'dailyReset', hour: Math.min(23, Math.max(0, Math.trunc(num(model.cooldown.hour, 0)))) }
              : { mode: 'duration', hours: num(model.cooldown.hours, DEFAULT_COOLDOWN.hours) };
            return entry;
          }),
        })),
        preprocessing: {
          dedup: draft.preprocessing.dedup === true,
          purgeErrors: draft.preprocessing.purgeErrors === true,
          astSkeleton: {
            enabled: draft.preprocessing.astSkeleton.enabled === true,
            maxDepth: Math.max(0, Math.trunc(num(draft.preprocessing.astSkeleton.maxDepth, 0))),
          },
          logCondense: {
            mode: draft.preprocessing.logCondense.mode,
            maxLines: Math.max(0, Math.trunc(num(draft.preprocessing.logCondense.maxLines, 0))),
          },
        },
        runRecord: {
          enabled: draft.runRecord.enabled === true,
          maxEntries: Math.max(1, Math.trunc(num(draft.runRecord.maxEntries, FALLBACK.runRecord.maxEntries))),
          snapshotChars: Math.max(0, Math.trunc(num(draft.runRecord.snapshotChars, FALLBACK.runRecord.snapshotChars))),
          path: String(draft.runRecord.path ?? ''),
        },
      };
    }

    /** Structural equality of two drafts, by serialized form. */
    const sameDraft = (a, b) => JSON.stringify(toConfig(a)) === JSON.stringify(toConfig(b));

    /** Validate the draft; returns an error key or `undefined`. */
    function validate(draft) {
      if (draft.tiers.length === 0) return 'invalidPool';
      const names = new Set();
      for (const tier of draft.tiers) {
        const name = String(tier.name ?? '').trim();
        if (name === '' || names.has(name)) return 'invalidTierName';
        names.add(name);
        if (tier.models.length === 0) return 'invalidPool';
        for (const model of tier.models) {
          if (String(model.provider ?? '') === '' || String(model.model ?? '') === '') return 'invalidPool';
          const cooldown = model.cooldown;
          if (cooldown.mode === 'duration') {
            if (!(num(cooldown.hours, 0) > 0)) return 'invalidCooldown';
          } else if (!Number.isInteger(num(cooldown.hour, -1)) || num(cooldown.hour, -1) < 0 || num(cooldown.hour, -1) > 23) {
            return 'invalidCooldown';
          }
        }
      }
      if (!(num(draft.chunkRatio, 0) > 0) || num(draft.chunkRatio, 0) > 1) return 'invalidRatio';
      if (!(num(draft.chunkOverlapRatio, -1) >= 0) || num(draft.chunkOverlapRatio, 1) >= 1) return 'invalidRatio';
      return undefined;
    }

    // --- bridge scope --------------------------------------------------------
    /**
     * The settings bridge remote (`/api/dsh-quilt-compact/...`), shaped like the
     * configForms scope the controller understands (`getSnapshot`/`subscribe`/
     * `mutate`), so the rest of the page is channel-agnostic.
     *
     * Why a bridge at all: in web/desktop profiles the backend runs inside the
     * `standard` agent preset's `compaction` group, and `dsh-settings` only
     * exposes active include-tree entries — the preset-group row is not one, so
     * configForms cannot serve it. The host registers these routes from the
     * engine instance (whichever realm it mounts in), and they read/write the
     * profile layer through `configEditor`, exactly like the official editor.
     */
    const BRIDGE_PREFIX = '/api/dsh-quilt-compact';

    /**
     * @param {object} opts
     * @param {(groups: unknown[], failures: unknown[]) => void} [opts.onCatalog]
     *   Receives the catalog the bridge returned (provider/model choices).
     * @param {(status: object | undefined) => void} [opts.onStatus]
     *   Receives the engine-serving status for the banner, if any.
     */
    function createBridgeScope(opts = {}) {
      let listeners = [];
      let state = { status: 'loading', writable: false, value: undefined, revision: undefined, source: undefined, error: undefined };

      const publish = () => { for (const fn of listeners) fn(); };
      const push = (next) => { state = next; publish(); };

      const remote = async (path, body) => {
        const response = await fetch(BRIDGE_PREFIX + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`bridge ${path} failed: HTTP ${response.status}`);
        const payload = await response.json();
        if (payload?.ok !== true) {
          const error = new Error(payload?.message ?? `bridge ${path} rejected`);
          error.code = payload?.code;
          throw error;
        }
        return payload;
      };

      return {
        getSnapshot: () => state,
        subscribe: (fn) => {
          listeners.push(fn);
          return () => { listeners = listeners.filter((f) => f !== fn); };
        },
        /** Reload the config (+ catalog + status) from the bridge. */
        async refresh() {
          push({ ...state, status: 'loading' });
          try {
            const payload = await remote('/describe');
            const value = payload.value;
            opts.onCatalog?.(value.catalog?.groups ?? [], value.catalogError ? [value.catalogError] : []);
            opts.onStatus?.(value.status);
            push({
              status: 'ready',
              writable: true,
              value: value.config,
              revision: value.revision,
              source: value.source,
              error: undefined,
            });
          } catch (error) {
            push({ status: 'error', writable: false, value: undefined, revision: undefined, source: undefined, error: error.code ?? 'loadFailed' });
          }
        },
        /** Persist the whole config, guarded by the revision fence. */
        async mutate(ops, expectedRevision) {
          // The controller emits one `set` op per top-level field; their values
          // are already clean JSON config shapes, so collect them directly.
          const config = {};
          for (const op of ops) {
            if (op?.op === 'set' && Array.isArray(op.path) && op.path.length === 1) config[op.path[0]] = op.value;
          }
          await remote('/mutate', { config, revision: expectedRevision });
          await this.refresh();
          return { ok: true };
        },
      };
    }

    // --- controller ----------------------------------------------------------
    /**
     * Owns the draft, the model catalog, and the save lifecycle for one config
     * namespace. Deliberately plain: React state is published through a
     * snapshot store, and every async step is generation-guarded so a stale
     * response can never overwrite newer input.
     */
    class CardController {
      constructor(scope, ctx) {
        this.scope = scope;
        this.ctx = ctx;
        this.disposed = false;
        this.store = createSnapshotStore();
        this.draft = undefined;
        this.draftRevision = undefined;
        this.saving = false;
        this.failed = false;
        this.conflicted = false;
        this.catalogStatus = 'idle';
        this.catalogGroups = [];
        this.catalogFailures = [];
        this.saveGeneration = 0;
        this.catalogGeneration = 0;
        this.error = undefined;
        // Card view state (collapsible shell + section tabs) lives on the
        // controller so the smoke harness can drive it like any other state
        // and the card stays a pure projection of the store.
        this.view = { open: true, tab: 'pool' };
        this.unsubscribe = this.scope.subscribe(() => this.sync());
        this.sync();
        // The bridge scope is pull-based (unlike the configForms scope, which
        // the Host keeps up to date); load the first snapshot explicitly.
        if (typeof this.scope.refresh === 'function') void this.scope.refresh();
      }

      /** Rebuild the draft when the namespace changes underneath us. */
      sync() {
        if (this.disposed) return;
        const snapshot = this.scope.getSnapshot();
        if (snapshot.status !== 'ready') {
          this.publish();
          return;
        }
        // A draft survives its own save; an external change replaces it.
        if (this.draft === undefined || (this.draftRevision !== snapshot.revision && !this.saving)) {
          this.draft = toDraft(snapshot.value);
          this.draftRevision = snapshot.revision;
          this.conflicted = false;
        }
        this.publish();
      }

      /**
       * Load the models this installation actually has configured. The bridge
       * describe response already carries the runtime catalog, delivered via
       * the scope's `onCatalog` callback; this method exists so a retry or an
       * adapter change can re-pull the bridge snapshot (and with it, the
       * catalog).
       */
      async loadCatalog() {
        if (this.disposed || this.catalogStatus === 'loading') return;
        const generation = this.catalogGeneration;
        this.catalogStatus = 'loading';
        this.publish();
        try {
          if (typeof this.scope.refresh === 'function') await this.scope.refresh();
          if (generation !== this.catalogGeneration) return;
          if (this.catalogStatus === 'idle' || this.catalogStatus === 'loading') this.catalogStatus = 'ready';
        } catch {
          if (generation !== this.catalogGeneration) return;
          this.catalogStatus = 'error';
        }
        this.publish();
      }

      /** Re-read the catalog (adapters or the settings document changed). */
      refreshCatalog() {
        if (this.disposed) return;
        this.catalogGeneration += 1;
        this.catalogStatus = 'idle';
        this.loadCatalog();
      }

      /** Toggle the card shell. */
      toggleOpen() {
        if (this.disposed) return;
        this.view = { ...this.view, open: !this.view.open };
        this.publish();
      }

      /** Switch the visible section tab. */
      setTab(tab) {
        if (this.disposed) return;
        if (tab !== 'pool' && tab !== 'tuning' && tab !== 'pre' && tab !== 'runrecord') return;
        this.view = { ...this.view, tab };
        this.publish();
      }

      /** Drop the draft and adopt the stored value. */
      discard() {
        if (this.disposed) return;
        this.saveGeneration += 1;
        const snapshot = this.scope.getSnapshot();
        this.draft = toDraft(snapshot.value);
        this.draftRevision = snapshot.revision;
        this.saving = false;
        this.failed = false;
        this.conflicted = false;
        this.error = undefined;
        this.publish();
      }

      /** Apply a mutation to the draft. */
      edit(mutator) {
        if (this.disposed || this.draft === undefined) return;
        const next = structuredClone(this.draft);
        mutator(next);
        this.draft = next;
        this.error = validate(next);
        this.failed = false;
        this.publish();
      }

      /** Write the whole draft as one config revision. */
      async save() {
        if (this.disposed || this.draft === undefined) return;
        const snapshot = this.scope.getSnapshot();
        if (snapshot.status !== 'ready' || !snapshot.writable || this.saving) return;
        const invalid = validate(this.draft);
        if (invalid !== undefined) {
          this.error = invalid;
          this.publish();
          return;
        }
        if (snapshot.revision !== this.draftRevision) {
          this.conflicted = true;
          this.publish();
          return;
        }
        const generation = this.saveGeneration;
        this.saving = true;
        this.failed = false;
        this.conflicted = false;
        this.error = undefined;
        this.publish();
        try {
          // The config layer replaces arrays wholesale, so every field is sent
          // in full; a partial array edit is not expressible as a path op.
          const config = toConfig(this.draft);
          await this.scope.mutate([
            { op: 'set', path: ['chunkRatio'], value: config.chunkRatio },
            { op: 'set', path: ['chunkOverlapRatio'], value: config.chunkOverlapRatio },
            { op: 'set', path: ['fallbackToSessionModel'], value: config.fallbackToSessionModel },
            { op: 'set', path: ['chunkPromptSuffix'], value: config.chunkPromptSuffix },
            { op: 'set', path: ['mergePromptSuffix'], value: config.mergePromptSuffix },
            { op: 'set', path: ['tiers'], value: config.tiers },
            { op: 'set', path: ['preprocessing'], value: config.preprocessing },
            { op: 'set', path: ['runRecord'], value: config.runRecord },
          ], this.draftRevision);
        } catch {
          if (generation === this.saveGeneration) {
            this.saving = false;
            this.failed = true;
            this.publish();
          }
          return;
        }
        if (generation !== this.saveGeneration) return;
        const after = this.scope.getSnapshot();
        const landed = after.status === 'ready' && sameDraft(toDraft(after.value), this.draft);
        this.saving = false;
        this.failed = !landed;
        if (landed) {
          this.draft = toDraft(after.value);
          this.draftRevision = after.revision;
        }
        this.publish();
      }

      /** Publish the projection the card renders. */
      publish() {
        if (this.disposed) return;
        const snapshot = this.scope.getSnapshot();
        this.store.set({
          status: snapshot.status,
          writable: snapshot.writable,
          source: snapshot.source,
          draft: this.draft,
          saving: this.saving,
          failed: this.failed,
          conflicted: this.conflicted,
          error: this.error,
          catalogStatus: this.catalogStatus,
          catalogGroups: this.catalogGroups,
          catalogFailures: this.catalogFailures,
          view: this.view,
        });
      }

      /** Release the subscription. */
      dispose() {
        this.disposed = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    }

    // --- small field helpers -------------------------------------------------
    /** A labelled text input. */
    function TextField({ label, value, onChange, disabled, numeric, className }) {
      return h('label', { className: `qc-field ${className ?? ''}` },
        h('span', null, label),
        h('input', {
          type: 'text',
          value: value === undefined || value === null ? '' : String(value),
          inputMode: numeric ? 'numeric' : undefined,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.value),
        }));
    }

    /** A labelled select over `options` (`[{value, label}]`). */
    function SelectField({ label, value, options, onChange, disabled, className }) {
      return h('label', { className: `qc-field ${className ?? ''}` },
        h('span', null, label),
        h('select', {
          value: String(value ?? ''),
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.value),
        }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label))));
    }

    /** A labelled checkbox. */
    function CheckField({ label, checked, onChange, disabled }) {
      return h('label', { className: 'qc-toggle' },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', null, label));
    }

    /** A numeric text field that reports a parsed number. */
    function NumberField({ label, value, onChange, disabled, className }) {
      return h(TextField, {
        label,
        value,
        disabled,
        numeric: true,
        className,
        onChange: (text) => {
          const parsed = Number(text);
          onChange(text.trim() === '' || !Number.isFinite(parsed) ? undefined : parsed);
        },
      });
    }

    // --- card ----------------------------------------------------------------
    /**
     * Render the settings card, mirroring dsh-connect-trae's plugin card: a
     * collapsible shell whose header carries title + description and a
     * pure-CSS caret (icon names are not a stable contract across DSH
     * releases, so no primitives icon is imported), a tab bar over the three
     * sections, and token-only surfaces. View state lives on the controller.
     */
    function Card(props) {
      const { t } = props;
      const state = props.state ?? {};
      const draft = state.draft;
      const disabled = state.writable !== true || state.saving === true;
      const view = state.view ?? { open: true, tab: 'pool' };

      const head = h('button', {
        type: 'button',
        className: 'qc-head',
        'aria-expanded': view.open === true,
        onClick: props.toggleOpen,
      },
        h('span', { className: 'qc-head-copy' },
          h('span', { className: 'qc-title' }, t('title')),
          h('span', { className: 'qc-desc' }, t('description'))),
        h('span', { className: `qc-chevron ${view.open === true ? 'qc-chevron-open' : ''}` }));

      if (state.status !== 'ready' || draft === undefined) {
        return h('div', { className: 'qc' },
          head,
          h('div', { className: 'qc-body' },
            h('p', { className: 'qc-notice' }, state.status === 'ready' ? t('loading') : t('loadFailed'))));
      }

      // Banner: where the backend the page edits actually runs.
      const sourceBanner = state.source === 'preset'
        ? h('p', { className: 'qc-hint', key: 'src-preset' }, t('sourcePreset'))
        : state.source === 'host'
          ? h('p', { className: 'qc-hint', key: 'src-host' }, t('sourceHost'))
          : h('p', { className: 'qc-error', key: 'src-none' }, t('sourceNone'));

      // Catalog lookups: which routes exist, and the provider list.
      const known = new Set();
      const providerOptions = [];
      for (const group of state.catalogGroups ?? []) {
        providerOptions.push({ value: group.id, label: group.name ?? group.id });
        for (const model of group.models ?? []) known.add(`${group.id}/${model.id}`);
      }
      const modelsOf = (provider) => {
        const group = (state.catalogGroups ?? []).find((entry) => entry.id === provider);
        return (group?.models ?? []).map((model) => ({ value: model.id, label: model.name ?? model.id }));
      };

      const edit = props.edit;
      const setField = (field) => (value) => edit((next) => { next[field] = value; });
      const editPre = (mutator) => edit((next) => { mutator(next.preprocessing); });

      const poolPanel = h('div', { className: 'qc-panel', key: 'panel-pool' },
        h('section', { className: 'qc-section' },
          h('h3', null, t('poolHeading')),
          h('p', { className: 'qc-hint' }, t('poolHint')),
          state.catalogStatus === 'loading' ? h('p', { className: 'qc-notice' }, t('catalogLoading')) : null,
          state.catalogStatus === 'error'
            ? h('p', { className: 'qc-error' }, t('catalogFailed'), ' ',
                h('button', { className: 'qc-btn qc-btn-outline qc-btn-sm', type: 'button', onClick: props.retryCatalog }, t('retry')))
            : null,
          state.catalogStatus === 'ready' && (state.catalogFailures ?? []).length > 0
            ? h('p', { className: 'qc-warn' }, t('catalogPartial'))
            : null,
          state.catalogStatus === 'ready' && providerOptions.length === 0
            ? h('p', { className: 'qc-warn' }, t('catalogEmpty'))
            : null,
          draft.tiers.map((tier, tierIndex) => h('div', { className: 'qc-list', key: `tier-${tierIndex}` },
            h('div', { className: 'qc-tierHead' },
              h(TextField, {
                label: `${t('tier')} ${tierIndex + 1} — ${t('tierName')}`,
                value: tier.name,
                disabled,
                className: 'qc-grow',
                onChange: (value) => edit((next) => { next.tiers[tierIndex].name = value; }),
              }),
              h('button', {
                className: 'qc-btn qc-btn-outline qc-btn-sm',
                type: 'button',
                disabled: disabled || draft.tiers.length <= 1,
                title: t('tierRemove'),
                onClick: () => edit((next) => { next.tiers.splice(tierIndex, 1); }),
              }, t('tierRemove'))),
            tier.models.map((model, modelIndex) => {
              const missing = model.provider !== '' && model.model !== '' && !known.has(routeKey(model));
              const providerChoices = providerOptions.some((option) => option.value === model.provider) || model.provider === ''
                ? providerOptions
                : [{ value: model.provider, label: model.provider }, ...providerOptions];
              const modelChoices = modelsOf(model.provider);
              const modelOptions = modelChoices.some((option) => option.value === model.model) || model.model === ''
                ? modelChoices
                : [{ value: model.model, label: model.model }, ...modelChoices];
              return h('div', { className: `qc-model ${missing ? 'qc-unavailable' : ''}`, key: `model-${tierIndex}-${modelIndex}` },
                h(SelectField, {
                  label: t('provider'),
                  value: model.provider,
                  options: providerChoices,
                  disabled,
                  className: 'qc-grow',
                  onChange: (value) => edit((next) => {
                    next.tiers[tierIndex].models[modelIndex].provider = value;
                    // A model id belongs to one provider; refill it with the
                    // new provider's first model so the draft stays valid and
                    // Save is never silently disabled by a cleared pairing.
                    next.tiers[tierIndex].models[modelIndex].model = modelsOf(value)[0]?.value ?? '';
                  }),
                }),
                h(SelectField, {
                  label: t('model'),
                  value: model.model,
                  options: modelOptions,
                  disabled,
                  className: 'qc-grow',
                  onChange: (value) => edit((next) => { next.tiers[tierIndex].models[modelIndex].model = value; }),
                }),
                h(NumberField, {
                  label: t('maxConcurrent'),
                  value: model.maxConcurrent,
                  disabled,
                  className: 'qc-num',
                  onChange: (value) => edit((next) => {
                    next.tiers[tierIndex].models[modelIndex].maxConcurrent = value === undefined ? 1 : value;
                  }),
                }),
                h(SelectField, {
                  label: t('cooldownMode'),
                  value: model.cooldown.mode,
                  disabled,
                  className: 'qc-num',
                  options: [
                    { value: 'duration', label: t('cooldownDuration') },
                    { value: 'dailyReset', label: t('cooldownDaily') },
                  ],
                  onChange: (value) => edit((next) => {
                    next.tiers[tierIndex].models[modelIndex].cooldown = value === 'dailyReset'
                      ? { mode: 'dailyReset', hour: 0 }
                      : { ...DEFAULT_COOLDOWN };
                  }),
                }),
                model.cooldown.mode === 'duration'
                  ? h(NumberField, {
                      label: t('cooldownHours'),
                      value: model.cooldown.hours,
                      disabled,
                      className: 'qc-num',
                      onChange: (value) => edit((next) => {
                        next.tiers[tierIndex].models[modelIndex].cooldown.hours = value;
                      }),
                    })
                  : h(NumberField, {
                      label: t('cooldownHour'),
                      value: model.cooldown.hour,
                      disabled,
                      className: 'qc-num',
                      onChange: (value) => edit((next) => {
                        next.tiers[tierIndex].models[modelIndex].cooldown.hour = value;
                      }),
                    }),
                h('div', { className: 'qc-model-head' },
                  missing ? h('span', { className: 'qc-badge', title: t('unavailableHint') }, t('unavailable')) : null,
                  h('button', {
                    className: 'qc-btn qc-btn-outline qc-btn-sm',
                    type: 'button',
                    disabled,
                    title: t('modelRemove'),
                    onClick: () => edit((next) => { next.tiers[tierIndex].models.splice(modelIndex, 1); }),
                  }, t('modelRemove'))));
            }),
            h('div', { className: 'qc-actions', key: `add-model-${tierIndex}` },
              h('button', {
                className: 'qc-btn qc-btn-outline qc-btn-sm',
                type: 'button',
                disabled,
                onClick: () => edit((next) => {
                  const provider = providerOptions[0]?.value ?? '';
                  const first = modelsOf(provider)[0]?.value ?? '';
                  next.tiers[tierIndex].models.push({
                    provider,
                    model: first,
                    maxConcurrent: 1,
                    cooldown: { ...DEFAULT_COOLDOWN },
                  });
                }),
              }, t('modelAdd'))))),
          h('div', { className: 'qc-actions' },
            h('button', {
              className: 'qc-btn qc-btn-outline qc-btn-sm',
              type: 'button',
              disabled,
              onClick: () => edit((next) => {
                const provider = providerOptions[0]?.value ?? '';
                const first = modelsOf(provider)[0]?.value ?? '';
                next.tiers.push({
                  name: `tier ${next.tiers.length + 1}`,
                  models: [{ provider, model: first, maxConcurrent: 1, cooldown: { ...DEFAULT_COOLDOWN } }],
                });
              }),
            }, t('tierAdd')))));


      const tuningPanel = h('div', { className: 'qc-panel', key: 'panel-tuning' },
        h('section', { className: 'qc-section' },
          h('h3', null, t('tuningHeading')),
          h('div', { className: 'qc-grid' },
            h(NumberField, {
              label: t('chunkRatio'), value: draft.chunkRatio, disabled,
              onChange: setField('chunkRatio'),
            }),
            h(NumberField, {
              label: t('chunkOverlapRatio'), value: draft.chunkOverlapRatio, disabled,
              onChange: setField('chunkOverlapRatio'),
            }),
            h(TextField, {
              label: t('chunkPromptSuffix'), value: draft.chunkPromptSuffix, disabled,
              onChange: setField('chunkPromptSuffix'),
            }),
            h(TextField, {
              label: t('mergePromptSuffix'), value: draft.mergePromptSuffix, disabled,
              onChange: setField('mergePromptSuffix'),
            })),
          h('p', { className: 'qc-hint' }, t('chunkRatioHint')),
          h('p', { className: 'qc-hint' }, t('chunkOverlapHint')),
          h(CheckField, {
            label: t('fallbackToSessionModel'),
            checked: draft.fallbackToSessionModel,
            disabled,
            onChange: setField('fallbackToSessionModel'),
          }),
          h('p', { className: 'qc-hint' }, t('fallbackHint'))));

      const rr = draft.runRecord;
      const runRecordPanel = h('div', { className: 'qc-panel', key: 'panel-runrecord' },
        h('section', { className: 'qc-section' },
          h('h3', null, t('runRecordHeading')),
          h(CheckField, {
            label: t('runRecordEnabled'),
            checked: rr.enabled,
            disabled,
            onChange: (value) => edit((next) => { next.runRecord.enabled = value; }),
          }),
          h('div', { className: 'qc-grid' },
            h(NumberField, {
              label: t('runRecordMaxEntries'), value: rr.maxEntries, disabled,
              onChange: (value) => edit((next) => { next.runRecord.maxEntries = value; }),
            }),
            h(NumberField, {
              label: t('runRecordSnapshotChars'), value: rr.snapshotChars, disabled,
              onChange: (value) => edit((next) => { next.runRecord.snapshotChars = value; }),
            })),
          h('p', { className: 'qc-hint' }, t('runRecordHint'))));

      const pre = draft.preprocessing;
      const prePanel = h('div', { className: 'qc-panel', key: 'panel-pre' },
        h('section', { className: 'qc-section' },
          h('h3', null, t('preprocessingHeading')),
          h('div', { className: 'qc-grid' },
            h(CheckField, {
              label: t('dedup'), checked: pre.dedup, disabled,
              onChange: (value) => editPre((next) => { next.dedup = value; }),
            }),
            h(CheckField, {
              label: t('purgeErrors'), checked: pre.purgeErrors, disabled,
              onChange: (value) => editPre((next) => { next.purgeErrors = value; }),
            }),
            h(CheckField, {
              label: `${t('astSkeleton')} — ${t('enabled')}`, checked: pre.astSkeleton.enabled, disabled,
              onChange: (value) => editPre((next) => { next.astSkeleton.enabled = value; }),
            })),
          h('div', { className: 'qc-grid' },
            h(NumberField, {
              label: `${t('astSkeleton')} — ${t('maxDepth')}`, value: pre.astSkeleton.maxDepth, disabled,
              onChange: (value) => editPre((next) => { next.astSkeleton.maxDepth = value; }),
            }),
            h(SelectField, {
              label: `${t('logCondense')} — ${t('logCondenseMode')}`,
              value: pre.logCondense.mode,
              disabled,
              options: [
                { value: 'balanced', label: t('modeBalanced') },
                { value: 'head', label: t('modeHead') },
                { value: 'tail', label: t('modeTail') },
              ],
              onChange: (value) => editPre((next) => { next.logCondense.mode = value; }),
            }),
            h(NumberField, {
              label: `${t('logCondense')} — ${t('maxLines')}`, value: pre.logCondense.maxLines, disabled,
              onChange: (value) => editPre((next) => { next.logCondense.maxLines = value; }),
            }))));


      const notices = [];
      if (state.error !== undefined) notices.push(h('p', { className: 'qc-error', key: 'err' }, t(state.error)));
      if (state.conflicted) notices.push(h('p', { className: 'qc-error', key: 'conflict' }, t('conflict')));
      if (state.failed) notices.push(h('p', { className: 'qc-error', key: 'failed' }, t('failed')));
      if (state.writable !== true) notices.push(h('p', { className: 'qc-notice', key: 'ro' }, t('readonly')));

      const tabBtn = (name, label) => h('button', {
        type: 'button',
        className: `qc-tab ${view.tab === name ? 'qc-tab-active' : ''}`,
        onClick: () => props.setTab(name),
      }, label);

      const panel = view.tab === 'tuning' ? tuningPanel : view.tab === 'pre' ? prePanel : view.tab === 'runrecord' ? runRecordPanel : poolPanel;

      return h('div', { className: 'qc' },
        head,
        view.open === true
          ? h('div', { className: 'qc-body' },
              h('div', { className: 'qc-tabs' },
                tabBtn('pool', t('poolHeading')),
                tabBtn('tuning', t('tuningHeading')),
                tabBtn('pre', t('preprocessingHeading')),
                tabBtn('runrecord', t('runRecordHeading'))),
              sourceBanner,
              panel,
              h('div', { className: 'qc-footer' },
                ...notices,
                // The save button is never disabled by a validation error:
                // clicking it surfaces the reason (save() re-validates and
                // publishes the message) — an edit that temporarily clears a
                // field must not look like a dead button.
                h('button', {
                  className: 'qc-btn qc-btn-primary',
                  type: 'button',
                  disabled,
                  onClick: props.save,
                }, state.saving ? t('saving') : t('save')),
                h('button', {
                  className: 'qc-btn qc-btn-outline',
                  type: 'button',
                  disabled: state.saving === true,
                  onClick: props.discard,
                }, t('discard'))))
          : null);
    }

    /**
     * Guarded card: a throw must not blank the whole slot. Reads the live
     * snapshot from the controller's store via useSyncExternalStore (the store
     * is a real dsh-client-store snapshot store: getSnapshot/subscribe/set —
     * NOT a `get()`-based zustand handle). Subscribing here, instead of
     * snapshotting in the inject face, keeps the card current across
     * save/discard/catalog refreshes.
     */
    function SafeCard(props) {
      const controller = props.controller;
      const state = controller === undefined
        ? (props.state ?? {})
        : react.useSyncExternalStore(
            (fn) => controller.store.subscribe(fn),
            () => controller.store.getSnapshot(),
            () => controller.store.getSnapshot(),
          ) ?? {};
      try {
        return Card({ ...props, state });
      } catch (error) {
        console.error('[dsh-quilt-compact] settings card failed to render:', error);
        return h('div', { className: 'qc' },
          h('h3', null, props.t('title')),
          h('p', { className: 'qc-error' }, props.t('loadFailed')));
      }
    }

    // --- plugin --------------------------------------------------------------
    const inject = ['slots', 'locale', 'remote'];

    /**
     * Mount the settings card through the settings bridge. The card is
     * registered into the Plugins page's `plugins.row.config` seat under the
     * `<package>#<row id>` key (the row the bundle's patch declares), and reads
     * config + catalog + status from the bridge.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS);
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-quilt-compact: dictionaries');

      let controller;
      try {
        // The bridge replaces configForms: web/desktop profiles run the engine
        // inside the agent preset, which `dsh-settings` cannot serve.
        const scope = createBridgeScope({
          onCatalog: (groups, failures) => {
            controller.catalogGroups = groups;
            controller.catalogFailures = failures;
            // A describe that succeeded but carried a catalog error shows the
            // partial state, not a dead page.
            controller.catalogStatus = failures.length > 0 ? 'error' : 'ready';
            controller.publish();
          },
          onStatus: () => {},
        });
        controller = new CardController(scope, ctx);
      } catch (error) {
        console.error('[dsh-quilt-compact] settings page unavailable:', error);
        return;
      }
      ctx.effect(() => () => { controller.dispose(); }, 'dsh-quilt-compact: form subscription');

      // The catalog is the set of models this installation actually has, so it
      // is refreshed whenever an adapter or the settings document changes.
      ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { controller.refreshCatalog(); }), 'dsh-quilt-compact: adapter invalidations');
      ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { controller.scope.refresh?.(); }), 'dsh-quilt-compact: settings invalidations');
      ctx.effect(() => ctx.on('connection/reset', () => { controller.refreshCatalog(); }), 'dsh-quilt-compact: connection generation');

      const face = () => ({
        t,
        // The controller is a STABLE reference; the card subscribes to its
        // store itself (useSyncExternalStore), so a live snapshot is read per
        // render. Never read state here: runInject caches the inject result
        // per entry (rootInjectCache), so a snapshot captured here would be
        // the FIRST render's forever, and calling a nonexistent method (the
        // real dsh-client-store has getSnapshot(), not get()) throws inside
        // the slot render pipeline, which the SlotErrorBoundary turns into an
        // abdicated entry and a blank settings area.
        controller,
        edit: (mutator) => controller.edit(mutator),
        save: () => controller.save(),
        discard: () => controller.discard(),
        retryCatalog: () => controller.refreshCatalog(),
        reload: () => { if (controller.scope.refresh) void controller.scope.refresh(); },
        toggleOpen: () => controller.toggleOpen(),
        setTab: (tab) => controller.setTab(tab),
      });

      // Mirror dsh-connect-trae: register the card into both config-card
      // seats (`plugins.row.config` keyed `<package>#<row id>`, plus the
      // bundle seat), each independently guarded so an absent seat on some
      // host line cannot take the other's registration down with it.
      const registerCard = (slotName, key) => {
        try {
          ctx.effect(() => ctx.slots.inject(slotName, () => ctx.slots.register({
            name: slotName,
            key,
            order: 40,
            label: () => t('title'),
            locale: LOCALE_NS,
            inject: face,
          }, SafeCard)), `dsh-quilt-compact: settings page (${slotName})`);
        } catch (error) {
          console.error(`[dsh-quilt-compact] card slot "${slotName}" failed to register:`, error);
        }
      };
      registerCard('plugins.row.config', `${CONFIG_NS}#${CONFIG_NS}`);
      registerCard('plugins.bundle.config', CONFIG_NS);
    }

    exports.LOCALE_NS = LOCALE_NS;
    exports.CONFIG_NS = CONFIG_NS;
    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'dsh-quilt-compact';
    return module.exports;
  },
});
