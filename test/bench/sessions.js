/**
 * Synthetic agentic episode builders for the faithfulness benchmark.
 *
 * Each builder replays one realistic multi-step coding session as a DURABLE,
 * append-only event log (turn/step user/assistant/tool-call/tool-result/user),
 * exactly like dsh-session/Session does. It returns THREE layers because a
 * compression episode needs all three to be answerable:
 *
 * - `session`: real {@link Session} whose surface can be compacted by the
 *   engine under test.
 * - `surfaceEvents`: the full seeding log, i.e. the LOST context — the probe
 *   grader uses it to build ground truth.
 * - `facts`: the author-supplied ground truth (probe -> required tokens).
 *
 * @module dsh-quilt-compact/test/bench/sessions
 */
import { Session, SessionId } from '@deepseek-ai/dsh-session';

/** Trim trailing whitespace per line so seeded text matches on newline joins. */
const W = (s) => s.replace(/\s+$/gm, '');
/** Tool call arguments are raw JSON strings, exactly as the model produces them. */
const JSON_ARGS = (o) => JSON.stringify(o);

/**
 * Filler prose that makes one episode large enough to be worth compacting.
 *
 * A benchmark that measures compression needs something TO compress: with a
 * 2 KB episode every approach trivially passes the engine's shrink check and
 * nothing distinguishes them. Real agent transcripts are verbosity-heavy —
 * tool results carry hundreds of lines of output whose load-bearing content is
 * a handful of tokens — so this reproduces that shape without pretending to be
 * real content.
 *
 * Every generated line is explicitly marked as filler, so a grader can never
 * mistake padding for a fact.
 *
 * @param count - number of filler lines to emit.
 * @param topic - word used in each line so the filler stays on-topic.
 * @returns filler text lines joined by newlines.
 */
export function fillerBlock(count, topic) {
  return Array.from(
    { length: count },
    (_, index) => `[filler ${index}] ${topic}: routine progress update; nothing load-bearing in this line.`,
  ).join('\n');
}

/**
 * Seed a durable session from one flat script and return the three layers.
 * @param name - episode id, used to derive a unique session id.
 * @param script - the seeding script (see {@link Script}).
 * @returns `{ session, surfaceEvents, facts }`.
 */
function materialize(name, script) {
  const surfaceEvents = [];
  let turn = 0;
  let step = 0;
  let callId = 0;
  let seq = 0;
  const timeBase = Date.now();
  // Seed events must carry the full durable envelope (`seq`, `time`) — the
  // Session constructor validates each one, and it also rejects stray top-level
  // keys, so seeding is done through exactly this one pusher.
  const push = (type, data, extra) => {
    const event = {
      type,
      seq: seq++,
      time: timeBase + seq,
      data,
      ...(extra ?? {}),
    };
    surfaceEvents.push(event);
    return event;
  };

  push('turn/start', { turn: (turn += 1) });
  push('system/message', {
    turn,
    step: (step += 1),
    message: {
      role: 'system',
      id: 'msg-sys',
      content: [{ type: 'text', text: 'You are a coding agent.' }],
      source: { kind: 'system-prompt' },
    },
  }, { surfaceOp: 'append' });

  for (const entry of script) {
    if (entry.kind === 'user') {
      push('user/message', {
        role: 'user',
        id: entry.id,
        content: [{ type: 'text', text: W(entry.content) }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' });
      continue;
    }
    // assistant turn: one message carrying its tool-call blocks plus the
    // matched tool results. `dsh-compaction`'s pairing balance counts exactly
    // these content blocks (+1 each) against `tool/result` events (-1 each), so
    // a seed that omits them is an unbalanced surface and cannot be compacted.
    const content = [{ type: 'text', text: W(entry.content) }];
    for (const call of entry.calls ?? []) {
      const id = String(callId + 1);
      content.push({ type: 'tool-call', id, name: call.name, arguments: JSON_ARGS(call.args) });
      callId += 1;
    }
    push('assistant/message', {
      turn,
      step: (step += 1),
      stream: [],
      message: {
        role: 'assistant',
        id: `msg-a${step}`,
        content,
        // `assistant/message` must carry a model source naming its route.
        source: { kind: 'model', provider: 'bench-agent', model: 'bench-agent-m' },
      },
    }, { surfaceOp: 'append' });
    let callIndex = 0;
    for (const call of entry.calls ?? []) {
      callIndex += 1;
      const id = String(callId - (entry.calls.length - callIndex));
      push('tool/call', { turn, step, callId: id, name: call.name, arguments: JSON_ARGS(call.args) });
      push('tool/result', {
        turn,
        step,
        message: {
          role: 'tool',
          id: `msg-tr${id}`,
          content: [{ type: 'text', text: W(call.result) }],
          toolCallId: id,
          source: { kind: 'tool', callId: id },
          ...(call.error === true ? { isError: true } : {}),
        },
      }, { surfaceOp: 'append' });
    }
  }
  // NOTE: the turn is deliberately left OPEN. An automatic compaction must be
  // enclosed in a turn (`engine.compactRegion` checks for one), and the
  // benchmark exercises exactly that path — closing it here would make every
  // episode uncompactable.
  const session = Session.create(SessionId(`s-bench-${name}`), surfaceEvents);
  return { session, surfaceEvents, facts: {} };
}

/**
 * Build one coding session around a small Fastify service whose task was to
 * fix a flaky test suite; everything after the fix must be recoverable from
 * the checkpoint. The interesting property is that the answer to every probe
 * is DISTRIBUTED: the decision lives in one assistant turn, the file touching
 * it in a tool result, the numbers in a log block.
 * @param overrides - per-field overrides applied to the built object.
 * @returns `{ session, surfaceEvents, facts }`.
 */
export function buildCodeDebugEpisode(overrides = {}) {
  const { session, surfaceEvents } = materialize('code-debug', [
    {
      kind: 'user',
      id: 'u1',
      content: `
Please fix the flaky JWT test suite in this repo. npm test fails about 1 run in 4 with:
"Token has expired" even though we mint tokens with a 15m expiry.
`,
    },
    {
      kind: 'assistant',
      content: `
I'll reproduce first, then read the failing test and the token helper.
`,
      calls: [
        {
          name: 'runBash',
          args: { command: 'npm test -- --repeat 20' },
          result: `
 FAIL  auth/token.test.ts > mints a valid token for 15 minutes
   Expected: valid
   Received: Token has expired
 20 runs, 6 failed
${fillerBlock(60, 'jest')}`,
          error: true,
        },
        {
          name: 'readFile',
          args: { path: 'src/auth/token.ts' },
          result: `
export function mintToken(user: User, opts: MintOptions = {}): SignedToken {
  const ttlSeconds = opts.ttlSeconds ?? 15 * 60;
  return sign({ sub: user.id, tenant: user.tenantId }, ttlSeconds);
}
export const DEFAULT_TTL_SECONDS = 15 * 60;
${fillerBlock(80, 'token.ts')}`,
        },
        {
          name: 'readFile',
          args: { path: 'src/auth/clock.ts' },
          result: `
let skewMs = 0;
export function nowMs(): number { return Date.now() + skewMs; }
export function setSkew(ms: number): void { skewMs = ms; }
${fillerBlock(80, 'clock.ts')}`,
        },
      ],
    },
    {
      kind: 'assistant',
      content: `
Root cause found: the suite your CI runs sets a clock skew BEFORE the token is
minted. \`nowMs()\` adds \`skewMs\`, so when a previous case leaves skewMs at
120000 the freshly minted token is already ~2 minutes old at birth, and the
verifier rejects it. It is not the 15m TTL; it is leaked skew state between
cases. I will (a) reset skew in beforeEach, (b) add helpers.idOf for the new
tenant field. Verified locally with 20 consecutive green runs.
`,
      calls: [
        {
          name: 'editFile',
          args: { path: 'src/auth/token.ts', mode: 'patch' },
          result: `Applied 1 edit to src/auth/token.ts (added verifier nbf tolerance of 5000 ms).`,
        },
        {
          name: 'editFile',
          args: { path: 'auth/token.test.ts', mode: 'patch' },
          result: `Applied 1 edit to auth/token.test.ts (beforeEach now calls setSkew(0)).`,
        },
        {
          name: 'runBash',
          args: { command: 'npm test -- --repeat 20' },
          result: `20 runs, 0 failed. Suite green.`,
        },
      ],
    },
    {
      kind: 'assistant',
      content: `
Also note: helpers.userId was ambiguous once we added multi-tenant support, so
I renamed it to helpers.idOf across the following call sites: src/auth/session.ts,
src/http/middleware.ts, and test/helpers/factories.ts.
`,
      calls: [
        {
          name: 'searchReplace',
          args: { from: 'helpers.userId', to: 'helpers.idOf' },
          result: `Replaced 14 occurrences across 3 files: src/auth/session.ts, src/http/middleware.ts, test/helpers/factories.ts. "helpers.idOf" is the new canonical name; "helpers.userId" is gone.`,
        },
      ],
    },
  ]);
  const facts = {
    probes: [
      {
        id: 'recall-error',
        type: 'recall',
        ask: 'What was the original error that started this debugging session?',
        need: ['Token has expired'],
      },
      {
        id: 'decision-ttl',
        type: 'decision',
        ask: 'We discussed whether the TTL was wrong. What did we decide?',
        need: ['not the TTL', 'clock skew', '15m'],
      },
      {
        id: 'artifact-files',
        type: 'artifact',
        ask: 'Which files were modified or inspected?',
        need: ['src/auth/token.ts', 'auth/token.test.ts', 'src/auth/clock.ts'],
      },
      {
        id: 'artifact-rename',
        type: 'artifact',
        ask: 'A helper was renamed. From what to what, and is the old name still valid?',
        need: ['helpers.idOf', 'helpers.userId', 'gone'],
      },
      {
        id: 'continuation-next',
        type: 'continuation',
        ask: 'What is left to do? Anything still unverified?',
        need: ['nothing left', 'green', '20 runs'],
      },
    ],
  };
  return { session, surfaceEvents, facts, ...overrides };
}

/**
 * Build one long CI-log-heavy episode: hundreds of lines, most of them
 * boilerplate, three of them load-bearing. This is the episode that separates
 * a compaction that PRESERVES from one that merely SHRINKS.
 * @param overrides - per-field overrides applied to the built object.
 * @returns `{ session, surfaceEvents, facts }`.
 */
export function buildCiLogStreamEpisode(overrides = {}) {
  const { session, surfaceEvents } = materialize('ci-log', [
    { kind: 'user', id: 'u1', content: 'Please get the release pipeline green.' },
    {
      kind: 'assistant',
      content: 'Checking recent job history for this pipeline before reading the failing log.',
      calls: [
        {
          name: 'runBash',
          args: { command: 'cictl jobs list --pipeline release --limit 5' },
          result: `release/5388 green (9m12s)
release/5389 green (9m40s)
release/5390 failed step=test exit=1
release/5391 failed step=test exit=1
${fillerBlock(80, 'job-history')}`,
        },
        {
          name: 'readFile',
          args: { path: 'ci/pipeline.yml' },
          result: `name: release
on: push: branches: [release/**]
jobs:
  test:
    runs-on: gh-large-04
    strategy:
      matrix: workers: [4]
${fillerBlock(80, 'pipeline.yml')}`,
        },
      ],
    },
    {
      kind: 'assistant',
      content: 'Reading the failing job log first.',
      calls: [
        {
          name: 'readFile',
          args: { path: 'ci/release.log' },
          result: `
2026-08-14T02:11:03.112Z INFO  [runner] job=release/5391 agent=gh-large-04
2026-08-14T02:11:04.118Z INFO  [runner] checkout depth=1 ref=refs/heads/release/2026.08
2026-08-14T02:11:09.442Z INFO  [runner] cache key=node-modules-a91f3c MISS
2026-08-14T02:11:09.901Z INFO  [runner] restoring fallback cache node-modules-master
2026-08-14T02:12:41.007Z INFO  [install] added 1184 packages in 91s
2026-08-14T02:12:41.510Z INFO  [install] postinstall script run for esbuild@0.25.1
2026-08-14T02:13:02.771Z INFO  [build] tsc --noEmit passed (0 errors)
2026-08-14T02:13:44.219Z INFO  [build] vite bundle emitted dist/app.css (141 kB)
2026-08-14T02:14:59.882Z INFO  [test] unit suite started workers=8
2026-08-14T02:18:20.114Z INFO  [test] unit suite finished passed=1218 failed=0 skipped=3
2026-08-14T02:18:21.004Z INFO  [test] integration suite started workers=4
2026-08-14T02:24:11.660Z INFO  [test] integration case auth/refresh-token ... ok
2026-08-14T02:24:12.771Z INFO  [test] integration case billing/webhook-retry ... ok
2026-08-14T02:26:03.118Z WARN  [test] integration case billing/proration exceeded soft timeout (30s)
2026-08-14T02:26:41.902Z ERROR [test] integrate suite aborted: worker 3 exited signal=SIGKILL code=137
2026-08-14T02:26:41.903Z INFO  [runner] job failed reason=step-test exit=1 durationMs=878791
`,
        },
      ],
    },
    {
      kind: 'assistant',
      content: `
OOM: memory ceiling is 7 GiB. worker 3 was killed with SIGKILL/137 during
billing/proration. Decision: split the integration suite by SHARD_INDEX, drop
workers from 4 to 2, and raise the runner class to gh-xlarge-08 (14 GiB).
`,
      calls: [
        {
          name: 'runBash',
          args: { command: 'cictl set runner-class --job release --value gh-xlarge-08' },
          result: `Updated job release: runner-class gh-large-04 -> gh-xlarge-08. Note: gh-large-04 had 7 GiB; gh-xlarge-08 has 14 GiB.
${fillerBlock(70, 'cictl')}`,
        },
        {
          name: 'editFile',
          args: { path: 'ci/integration.yml', mode: 'patch' },
          result: `Applied 1 edit to ci/integration.yml (workers: 4 -> 2, added SHARD_INDEX: \${{ matrix.shard }}).
${fillerBlock(70, 'integration.yml')}`,
        },
      ],
    },
    {
      kind: 'assistant',
      content: `
Both edits applied. Verifying the change took effect.
`,
      calls: [
        {
          name: 'runBash',
          args: { command: 'cictl jobs trigger --pipeline release' },
          result: `Queued release/5392 on gh-xlarge-08 (14 GiB) with workers=2 per shard.
${fillerBlock(80, 'trigger')}`,
        },
      ],
    },
  ]);
  const facts = {
    probes: [
      { id: 'recall-error', type: 'recall', ask: 'Why did the release job fail?', need: ['SIGKILL', '137', 'worker 3'] },
      { id: 'decision-shard', type: 'decision', ask: 'What did we decide to change about the CI config?', need: ['workers 4 to 2', 'SHARD_INDEX', 'gh-xlarge-08'] },
      { id: 'recall-numbers', type: 'recall', ask: 'What are the memory ceilings involved?', need: ['7 GiB', '14 GiB'] },
      { id: 'artifact-files', type: 'artifact', ask: 'Which config file was edited?', need: ['ci/integration.yml'] },
      { id: 'continuation-next', type: 'continuation', ask: 'What should we do next?', need: ['re-run', 'green'] },
    ],
  };
  return { session, surfaceEvents, facts, ...overrides };
}

/**
 * Build one REFACTOR episode whose key property is NEGATIVE knowledge: the
 * team explicitly rejected a tempting approach, and a checkpoint that forgets
 * the rejection will re-propose it. Faithfulness includes refusals, not only
 * facts.
 * @param overrides - per-field overrides applied to the built object.
 * @returns `{ session, surfaceEvents, facts }`.
 */
export function buildRefactorEpisode(overrides = {}) {
  const { session, surfaceEvents } = materialize('refactor', [
    { kind: 'user', id: 'u1', content: 'Please split up our giant UserService god class.' },
    {
      kind: 'assistant',
      content: `
Surveying call sites before choosing a decomposition.
`,
      calls: [
        {
          name: 'runBash',
          args: { command: 'rg -l "UserService" src tests | head -40' },
          result: `src/http/middleware.ts
src/auth/session.ts
src/billing/invoice.ts
src/admin/user Admin.ts
test/helpers/factories.ts
${fillerBlock(85, 'rg-hits')}`,
        },
        {
          name: 'readFile',
          args: { path: 'src/services/UserService.ts' },
          result: `1841 lines, 34 public methods, 6 direct SQL call sites.
${fillerBlock(90, 'UserService.ts')}`,
        },
      ],
    },
    {
      kind: 'assistant',
      content: `
Two candidate decompositions. Option A: pure strategy objects injected into a
thin facade. Option B: one class per storage backend sharing an abstract base.

Decision: User chose Option A (composition over inheritance) explicitly and
rejected Option B (inheritance) —
the base class would leak the Postgres dialect into the Mongo implementation.
Do not introduce an abstract base class.

Migration state after this pass: 21 of 34 methods migrated. Still ON the old
god class: deleteUser, mergeAccounts, exportGdprBundle, purgeSessions.
`,
      calls: [
        {
          name: 'writeFile',
          args: { path: 'src/services/user/UserFacade.ts' },
          result: `Created src/services/user/UserFacade.ts (thin facade, 62 lines).
${fillerBlock(60, 'UserFacade.ts')}`,
        },
        {
          name: 'writeFile',
          args: { path: 'src/services/user/PasswordResetPolicy.ts' },
          result: `Created src/services/user/PasswordResetPolicy.ts (strategy, 88 lines).
${fillerBlock(60, 'PasswordResetPolicy.ts')}`,
        },
        {
          name: 'writeFile',
          args: { path: 'src/services/user/ProfileReadPolicy.ts' },
          result: `Created src/services/user/ProfileReadPolicy.ts (strategy, 71 lines).
${fillerBlock(60, 'ProfileReadPolicy.ts')}`,
        },
      ],
    },
    {
      kind: 'assistant',
      content: `
Verification complete: 812 passed, 0 failed. Remaining work is the four methods
named above, and the old src/services/UserService.ts stays until they move.
`,
      calls: [
        {
          name: 'runBash',
          args: { command: 'git diff --stat' },
          result: ` src/services/user/UserFacade.ts | 62 ++++++++++
 src/services/user/PasswordResetPolicy.ts | 88 ++++++++++
 src/services/user/ProfileReadPolicy.ts | 71 ++++++++++
 ${fillerBlock(40, 'diffstat')}`,
        },
      ],
    },
  ]);
  const facts = {
    probes: [
      { id: 'decision-rejected', type: 'decision', ask: 'Which decomposition did we reject, and why?', need: ['Option B', 'inheritance', 'rejected'] },
      {
        id: 'artifact-created',
        type: 'artifact',
        ask: 'Which new files were created in this refactor?',
        need: ['UserFacade.ts', 'PasswordResetPolicy.ts', 'ProfileReadPolicy.ts'],
      },
      {
        id: 'artifact-remaining',
        type: 'artifact',
        ask: 'Which methods are still on the old class?',
        need: ['deleteUser', 'mergeAccounts', 'exportGdprBundle', 'purgeSessions'],
      },
      { id: 'continuation-next', type: 'continuation', ask: 'What is the very next step?', need: ['move the four', 'deleteUser'] },
    ],
  };
  return { session, surfaceEvents, facts, ...overrides };
}

/**
 * Every shipped episode, keyed by id: `{ build }`.
 *
 * Adding an episode here is how the suite grows; nothing else needs to know
 * about it, because {@link buildCube} reads this map by name.
 */
export const EPISODES = {
  'code-debug': { build: buildCodeDebugEpisode, title: 'Flaky JWT suite debugging' },
  'ci-log': { build: buildCiLogStreamEpisode, title: 'CI failure triage over a long job log' },
  refactor: { build: buildRefactorEpisode, title: 'God-class refactor with a rejected option' },
};

/**
 * Build one named episode.
 * @param name - key of {@link EPISODES}.
 * @returns `{ session, surfaceEvents, facts }`.
 */
export function buildEpisode(name) {
  const entry = EPISODES[name];
  if (entry === undefined) {
    throw new Error(`unknown benchmark episode "${name}" (available: ${Object.keys(EPISODES).join(', ')})`);
  }
  return entry.build();
}
