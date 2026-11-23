# KAI Local Reflex — Cactus / Needle 3 Benchmark Harness

Local evaluation suite and schema mapper for KAI's V1 Desktop-Controls pre-LLM fast path (`Needle 3`).

## Run #4 — live-hijack hard negatives + real-usage mining (IN FLIGHT, `ftjob-b0a0a02f-a0ad-496a-a8d7-99d6309dac92`)

Submitted 2026-11-23 from 1,000 rows: the Run #2 base dataset (961) + 6 hard negatives from
LIVE misfires discovered against the running engine + 25 weak-spot positives (real phrasings that
scored below the gate) + 8 mined real-usage rows. Files `file-2571fcdd` / `file-b0012709` /
`file-53bb48c4`.

The four live hijacks this run targets (all executed above gate with wrong tool/args):
1. "open the file src/lib.rs in the editor" -> open_preview (file vocab must be NO-CALL)
2. "what radio station is this" -> play_radio(station:"this") (questions must not act)
3. "wait 100000 seconds" -> set_terminal_webgl (wrong tool entirely)
4. "set font size to 300" -> font_size 30 (grammar clipping OOB, undetectable from the reply alone)

**Acceptance bar: only replaces Run #2's 12L if it fixes all four hijacks WITHOUT regressing the
frozen suite (Run #2 12L: 63.3% exact, 65.9% prefill saved at gate 0.75, 0/12 coding hijack).
Run #3 taught us that mining your own test suite can regress generalization; the bar is high.

## Run #3 - hard negatives (SUCCEEDED, `model-39306ca3-e6ac-4d47-8c5c-e2a182fddbb6`)

Dataset: 961/120/120 (fixed Run #2's `play_radio("")` relabel of list-questions to NO-CALL,
12 multi-call compositions, 30 negations, 15 OOB, 40 code negatives, extra TTS vocabulary).
Platform test: 20L 114/120 (95.0%), 12L 109/120, 8L 100/120.

Local frozen-suite results (`bench.py --mode narrow`):

| Weights | Exact Match | p50 / p95 | Peak RAM | Best gate |
| :--- | :---: | :---: | :---: | :--- |
| 20L | 66.7% (40/60) | 420 / 728 ms | 140 MB | conf >= 0.85: 68.2% prefill saved, 4.5% wrong-local, 0/12 coding hijack |
| 12L | 63.3% (38/60) | 284 / 489 ms | 99 MB | conf >= 0.90: 59.1% saved, 4.5% wrong-local, 0/12 coding hijack |
| 8L | 61.7% (37/60) | 211 / 375 ms | 78 MB | conf >= 0.85: 45.5% saved, 0.0% wrong-local, 2/12 coding hijack |

**Run #3 vs Run #2 read: platform test DROPPED (96.4% -> 95.0% at 20L) and the local suite did not
improve (12L stayed 63.3%; escalate safety got WORSE unthresholded, 0 hijacks only at conf 0.90+).
The latency also doubled at every depth (12L p50 102 ms -> 284 ms) - same binary size, so this is
model variance, not payload. Conclusion: the hard-negative pass did NOT pay off; **Run #2's 12L
(model-49064f9a, gate 0.75) remains the shipping model**. The 12L artifacts on disk were
re-downloaded from Run #3 before this analysis - restore Run #2's 12L from the platform
(model-49064f9a-d1b9-408b-ac4c-4d6cd79a1e6b, depth 12) when wiring serve-engine.ps1.
Lessons: (1) the platform's own test set is chat-format over OUR distribution - improvements there
do not transfer when the negatives change distribution; (2) hard negatives drawn from frozen-suite
failures push the model toward memorizing the suite's boundaries rather than generalizing.

## Run #2 — `kai-desktop-v1` (SUCCEEDED, `model-49064f9a-d1b9-408b-ac4c-4d6cd79a1e6b`)

The frontend hooks `classifyWithEngine` -> `decideReflex` -> `executeReflexCalls` into the send
flow (`src/modules/ai/lib/transport.ts` + `src/modules/ai/lib/localReflex*.ts`):

1. Start the engine (any time; the app falls back to the cloud LLM when it is absent):
   ```powershell
   scripts/cactus/serve-engine.ps1   # cactus --model models/kai-desktop-v1-12L.cact --tools narrow_tools.json --serve --port 8941
   ```
2. Short text-only prompts (<= 160 chars) are classified on every send. At confidence >= 0.75 and a
   grounded, auto-approve-safe call, the tool executes through `buildCoreTools` and a synthetic
   assistant message is returned as a UIMessageChunk stream - zero cloud tokens.
3. Anything else falls through untouched. Engine-down is cached for 60 s; disable with
   `localStorage["kai.localReflex"] = "off"`. (The `kai.localReflexEndpoint` override is
   OBSOLETE - classification goes through the Rust command with the port compiled in.)

The runtime mapper (`localReflex.ts`) range-validates every numeric argument BEFORE executing
(the Cactus decode grammar CLIPS out-of-range values like `font size 96` -> `9`), refuses
ungrounded slots (empty station, garbage dates), localhost-only previews, and unknown tools.

## Production wiring (2026-11-23, Option A shipped)

- **Rust owns the engine lifecycle** (`src-tauri/src/modules/reflex.rs`): `reflex_status`,
  `reflex_setup` (download w/ progress channel), `reflex_remove`, `reflex_ensure_running`
  (spawn if port 8941 not answering), `reflex_classify` (HTTP POST + reset; the webview can NOT
  fetch the engine directly - CORS: the engine serves no headers, WebView2 blocks the request;
  every classify goes through this command). Settings UI: Settings -> Local Reflex (tab id
  `reflex`). Artifacts live in `app_local_data_dir()/reflex/` (cactus.exe, kai-desktop-v1-12L.cact,
  narrow_tools.json, manifest.json versioned against GitHub release manifest for painless Run #4+
  model swaps via `publish_artifacts.py`).
- **STATEFUL ENGINE**: `cactus --serve` keeps ONE running conversation. Every classify / health
  probe MUST POST /reset after its turn or the 256-token KV window drifts into wrong tools
  (verified live: health-probe residue steered "stop radio" -> set_voice_settings).
- **Conversational-ack guard**: bare "yes"/"continue"/"stop" classify as confident commands
  ("continue" -> play_radio 0.88). `isConversationalAck()` in localReflex.ts falls them through
  before the engine is consulted.

## Files

- `schemas.json` — Three schema designs for comparison:
  - `narrow_tools` (22 single-action snake_case tools — **best accuracy & latency**)
  - `native_tools` (12 raw KAI desktop tool schemas)
  - `compact_5_tools` (5 broad multi-arg schemas avoiding retrieval)
- `kai_mapper.py` — Deterministic translator from Needle's narrow `snake_case` tool calls (`set_ui_theme`, `set_vim_mode`, `set_timer_reminder`, …) to canonical KAI runtime calls (`settings_update`, `reminder_create`, `voice_settings`, …).
- `build_eval_suite.py` — Generates `eval_suite.jsonl` (60 frozen prompts across settings, radio, voice, reminders, personas, preview, negations, OOB, and **coding/chat escalations**) + `platform_test_preview.jsonl` (Cactus `/v1/files` OpenAI chat format).
- `build_dataset.py` — Deterministic (seed 0) fine-tuning dataset generator. Strictly disjoint from `eval_suite.jsonl` (hard-enforced in the generator), ~15% no-call negatives (negations, out-of-bounds, missing args, hard developer negatives like "edit palettes.ts", "why is radio_now_playing failing in radio.ts?"), every line carries a `reasoning_content` span derivation. Emits `data/train.jsonl` (~890), `data/validation.jsonl` (~112), `data/test.jsonl` (~112).
- `mine_usage.py` — **The real-usage mining loop** (2026-11-23). Reads `kai-reflex-log.json`
  (KAI's local ring of the last 600 reflex decisions + main-LLM executions of reflex-capable
  tools; populated automatically by `reflexLog.ts` + the transport hook) and produces
  `data/mined_{train,validation,test}.jsonl`: positives from confirmed executions, negatives from
  prompts the reflex was unsure about but the LLM later handled. Merge for the next fine-tune:
  `cat data/train.jsonl data/mined_train.jsonl` (dedup), upload, submit. This is the loop that
  moves accuracy now that synthetic hard negatives have plateaued (Run #3).
- `platform_run.py` — Cactus Platform REST pipeline: `upload` (3-call file upload, accepts `--train/--validation/--test` filenames under `data/`), `submit` (fine-tune job, `--yes` gate), `status` / `wait` (poll), `download` (depth variants as `.cact`), `full`.
- `build_run4_data.py` - Builds the Run #4 mix: Run #2 base data + hand-labeled hard negatives from the live-engine hijack batteries + weak-spot positives with their correct calls. Emits `data/train4.jsonl` / `validation4.jsonl` / `test4.jsonl`.
- `live-reflex-test.mjs` / `live-reflex-variations.mjs` / `live-reflex-negatives.mjs` - Live-engine batteries (production protocol: POST /complete then POST /reset per prompt). Outputs `data/live-test-*.json` and double as Run #4 mining material.
- `publish_artifacts.py` - Packages a trained model into `publish/` (weights + manifest with SHA-256) for GitHub release attach; the app's `reflex_setup` re-downloads on manifest version bump.
- `bench.py` — Runs `cactus-compute` locally on CPU, reports exact-match accuracy, per-domain scores, p50/p95 latency, RAM, and a confidence-threshold sweep (`0.00` to `0.90`) measuring prefill saved vs. coding-prompt hijack rate.

## Quick Start

```powershell
# Rebuild the frozen 60-case eval suite + Cactus platform test JSONL
python scripts/cactus/build_eval_suite.py

# Benchmark base Needle 3 (20L) across narrow vs native vs compact5 schemas
python scripts/cactus/bench.py --mode all --show-failures 20

# Benchmark a smaller subnetwork depth (e.g. 8L, 15.4 MB)
python scripts/cactus/bench.py --mode narrow --fetch-depth 8

# Score a fine-tuned .cact downloaded from Cactus Platform
python scripts/cactus/bench.py --mode narrow --weights scripts/cactus/models/kai-desktop-v1-8L.cact
```

## Fine-tuning Pipeline (Cactus Platform, 1 run per submission)

```powershell
# Regenerate the dataset (deterministic; refuses eval-suite leakage)
python scripts/cactus/build_dataset.py

# Upload train/val/test (no allowance spent)
python scripts/cactus/platform_run.py upload

# Submit the fine-tune job (spends 1 run; --yes required)
python scripts/cactus/platform_run.py submit --train file-... --val file-... --test file-... --yes

# Poll / wait
python scripts/cactus/platform_run.py status ftjob-...
python scripts/cactus/platform_run.py wait ftjob-...

# Download depth variants
python scripts/cactus/platform_run.py download model-... --depths 20,12,8
```

## Baseline Results (Zero-Shot Base Needle 3, Before Run #1)

| Model / Schema Variant | Tools | Exact Match | Coding Escalation Safe (`[]`) | p50 CPU Latency | Peak RAM |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `needle-3` (20L, 29 MB) + **`narrow`** | 22 | **63.3% (38/60)** | **91.7% (11/12)** | 208 ms | 146 MB |
| `needle-3` (20L, 29 MB) + `native` | 12 | 45.0% (27/60) | 75.0% (9/12) | 235 ms | 147 MB |
| `needle-3` (20L, 29 MB) + `compact5` | 5 | 43.3% (26/60) | 91.7% (11/12) | 266 ms | 140 MB |
| `needle-3-depth-8` (8L, 15.4 MB) + `narrow` | 22 | 43.3% (26/60) | 58.3% (7/12) | **102 ms** | **78 MB** |

## Run #2 — `kai-desktop-v1` (SUCCEEDED, `model-49064f9a-d1b9-408b-ac4c-4d6cd79a1e6b`)

Platform eval (exact match, 112 held-out lines): 20L **108/112 (96.4%)**, 12L **106/112**,
8L **99/112**. Local frozen-suite results (`bench.py --mode narrow`, full 22-tool runtime schema):

| Weights | Exact Match | p50 / p95 | Peak RAM | Best gate (conf >= 0.75) |
| :--- | :---: | :---: | :---: | :--- |
| **20L** (35.3 MB) | **68.3%** (41/60) | 158 / 325 ms | 140 MB | 72.7% prefill saved, 11.4% wrong-local, 1/12 coding hijack |
| **12L** (22.5 MB) | 63.3% (38/60) | **102 / 198 ms** | 99 MB | 65.9% prefill saved, 9.1% wrong-local, **0/12 coding hijack** |
| 8L (16.2 MB) | 48.3% (29/60) | 73 / 155 ms | 78 MB | 47.7% prefill saved, 9.1% wrong-local, 2/12 coding hijack |

Base-model reference: 63.3% exact, p50 208 ms, but uncalibrated confidence (correct desktop calls
scored 0.16-0.29, so a safe gate saved only ~20% prefill).

**Ship recommendation: 12L at confidence >= 0.75** — half the RAM of 20L, 102 ms p50, zero
coding-prompt hijacks, and 2/3 of desktop prompts handled locally with zero cloud prefill. The
tuned model is trigger-happier than base on coding prompts (a known fine-tune effect), which the
confidence gate absorbs; residual wrong-local cases (`"github dark" -> set_color_mode dark`) are
the hard-negative targets for a Run #3.

## Run #1 — `kai-desktop-v1` (FAILED at step 2/5, refunded; Run #2 resubmitted)

- Job `ftjob-3cc23e5a-a273-4343-a58c-a36ca4a49547` — `execution_failed` after ~30 min. Run refunded.
- **Root cause analysis:** verified with the actual trainer tokenizer that the 22-tool full-schema
  block rendered to ~1,823 tokens in EVERY line (total ~1,914 tokens/line -> 2,048 bucket). A local
  CPU probe (20 lines, 1 epoch, batch 2) trained end-to-end cleanly, so the data was valid; the
  platform failure is consistent with peak cost of float32 depth-20 training at seq 2,048 with
  our oversized payload.
- **Fix for Run #2:** training schema reduced to 18 tools (dropped `reminder_cancel`,
  `radio_list_stations`, `radio_now_playing` — the latter two are runtime-resolved variants of
  `play_radio`), 30-char descriptions, NO parameter schemas (argument shapes are learned from the
  answers; the runtime is handed the FULL schemas.json narrow_tools at inference, where the decode
  grammar actually matters). Dataset regenerated: every line now renders to **619-662 tokens**
  (bucket 1,024, 3x smaller than Run #1). Same negative mix, zero eval leakage.
- Run #2 job: `ftjob-e9b72cd6-2c0e-40fa-8186-c07aaeb505f5` (files `file-2a3408f2…`,
  `file-6172af61…`, `file-74c579f3…`).
- If Run #2 also fails at depth 20, the next step is `max_depth: 12`.
