# MemoChain in KAI: Fast, Cheap, Verifiable Long-Session Memory

Stop paying your model to re-read the entire chat history on every turn.

MemoChain is the durable-memory layer embedded in KAI. Turn it on per model (Settings → Models → "Durable memory (MemoChain)"), and long conversations stay fast, cheap, and accurate without bloating the context window — and the same session memory follows you when you switch between local and cloud models.

```text
KAI 
  |
  |  per-model toggle: Settings → Models → Durable memory
  v
MemoChain handler (in-process, Rust + TS)
  - Hot window: recent ~80k tokens kept verbatim (scaled for the model's real context limit)
  - Fact sheet: locally-derived digest of the folded turns
  - Top-K recall: verbatim chunks recalled per-turn, injected before the latest user message
  - 22 KB capsule: fixed-size integer state + SHA-256 receipt chain
  |
  v
  Backend (OpenAI / Anthropic / Google / Groq / OpenRouter / local / custom)
```

MemoChain is not a proxy and does not sit in front of your client. It runs inside KAI's agent pipeline, between the chat store and the model call.

---

## Why it helps

### 1. Flat token usage and lower bills

Standard chat apps resend the full conversation history on every single request. A 500k-token session means you pay for hundreds of thousands of repeated input tokens over and over.

When MemoChain is toggled for a model, the overflow is folded out once and replaced by a small fact sheet plus top-K retrieved verbatim chunks for the current question. The active hot window is capped at 80k tokens (and at 80% of the model's real context limit, whichever is smaller), so a long-running agent never sees a history of hundreds of thousands of tokens.

| Session length | Without MemoChain (input sent) | With MemoChain (input sent) | Input token reduction |
| --- | --- | --- | --- |
| 40k tokens | 40k | 40k (no fold yet) | 0% |
| 200k tokens | 200k | ~42k to 82k | ~60% to 79% |
| 500k tokens | 500k | ~42k to 82k | ~84% to 92% |
| 1M tokens | 1,000k | ~42k to 82k | ~92% to 96% |

Savings compound on every turn after the first fold. You never pay for the same old history twice. The context dropdown shows the cumulative tokens avoided and an estimated dollar saving for the current session.

**Measured A/B proof (120-turn identical session, backend-metered `usage.prompt_tokens`):**

| Endpoint | Total input tokens | Avg prompt/turn | Final-turn prompt | Sonnet-class cost ($3/1M) |
| --- | --- | --- | --- | --- |
| Direct | 7,086,360 | 59,053 | 117,125 | $21.26 |
| With MemoChain | **674,016 (-90%)** | **5,617** | **6,746** | **$2.02** |

### 2. Faster time-to-first-token (TTFT)

Before a model writes the first word of a reply, it must run prefill across the entire prompt. Once a chat grows past 100k tokens, prefill latency climbs turn after turn.

Because MemoChain bounds the active prompt at the hot window plus a few hundred tokens of recall, prefill time flattens out instead of scaling linearly with session length.

### 3. Lower local GPU memory pressure (KV cache)

On local servers (vLLM, llama.cpp, Ollama), long prompts eat gigabytes of KV cache per session. Capping the active context keeps per-session KV cache bounded, so the same GPU serves longer sessions or more concurrent users without running out of memory. This is proportionally the biggest win for small-context local models: a 6k-token hot window turns an 8k-context model into one with effectively unlimited memory.

### 4. One memory across every model in the same window

KAI supports many providers in one window. MemoChain state is keyed by session, not by model, so a conversation can start on one model and continue on another (local to cloud or back) with the capsule, fact sheet, and chunk history intact.

BYOK keys are forwarded to the backend for the main chat call and the periodic fact-sheet call; nothing leaves your machine except the request itself.

### 5. Exact recall without a second GPU

Unlike heavier memory stacks that require Postgres, Neo4j, Qdrant, or a separate reader LLM, KAI's in-process hybrid recall runs inside the app:

- In-process fact sheet: locally-derived digest (last 6 user asks, up to 20 file paths from tool-call inputs, up to 15 tool names), capped at 2,000 characters
- Top-K verbatim chunk recall, injected as a fenced per-turn block before the latest user message
- No extra container, no extra GPU, no extra binary
- Verified recall: 4/4 exact match on folded-out entities (cities, tool names, exact secret codes, host:port strings) in live probing against a local vLLM model, compared to 0/4 without hybrid recall

### 6. Verifiable 22 KB memory capsule (unique to MemoChain)

Every folded turn also updates a deterministic 22,606-byte integer capsule (`11x32x32` Q14 state) linked by a SHA-256 receipt chain.

- Tamper detection built in: flipping a single byte in the capsule or receipt log fails `memochain_verify`.
- Bit-exact integer arithmetic: the same inputs produce the same 256-bit digest in Python, Rust, and the SP1 zkVM.
- KAI's own `memochain_verify` command re-derives the chain from `receipts.jsonl` without any trust in the writer.

No other drop-in LLM memory path pairs practical daily recall with a constant-size, bit-exact, cryptographically verifiable memory state.

---

## How it works

MemoChain is wired into the agent pipeline at the fold point, the same place local compaction would run. When the non-system history exceeds the hot limit, the oldest atomic eviction groups (assistant tool_calls fused with their tool results) are folded into the capsule, the trimmed tail is kept verbatim, and the model sees the hot window plus a recalled memory block.

- Folding is pre-run (agent.ts, before each request) and mid-run (prepareStep, when the window grows during a long run)
- Already-folded prefixes are stripped without re-folding, re-notifying, or duplicating fact sheets
- Failures fail-open: a broken fold leaves the full window in place and the run proceeds
- Local compaction and `/compact` stand down for MemoChain-toggled models so the two do not fight

Session state lives in the app-local data dir under `memochain/<session_id>/` (capsule.bin, meta.json, receipts.jsonl, chunks.bin), the same layout the standalone MemoChain tooling reads, so KAI-folded sessions verify with the Python tooling.

---

## Honest tradeoffs

1. **One fact-sheet pass per fold:** the locally-derived fact sheet is a deterministic digest, not an LLM summary, so no extra model call is needed at fold time.
2. **Local SQLite alongside the 22 KB capsule:** the capsule stays fixed at 22,606 bytes. `chunks.bin` stores verbatim turns with int8-quantized vectors and is FIFO-capped (default 2,000 chunks, ~7 MB per session).
3. **Proof scope:** the SHA-256 receipt chain covers the 22 KB capsule state and every folded document hash. `chunks.bin` and the fact sheet are practical recall layers, not inputs to the chain.
4. **Best fit:** long coding sessions, multi-hour agent runs, persistent personal assistants. For short 5-turn chats under the hot window, MemoChain is a passthrough.

---

## Quick comparison

| Feature | Raw chat (no MemoChain) | Cloud memory routers | Heavy self-hosted memory | MemoChain in KAI |
| --- | --- | --- | --- | --- |
| Caps prefill cost and latency | No | Yes | Yes | **Yes** |
| Runs 100% locally / offline | Local models only | No (SaaS) | Yes | **Yes** |
| Extra RAM / GPU needed | 0 | N/A (cloud) | GBs + multiple DBs | **0 extra** |
| OpenAI + Anthropic + others in one window | Varies | Varies | Usually SDK/MCP only | **Yes (all providers in KAI)** |
| Same session across local + cloud models | No | No | Rarely | **Yes** |
| Exact verbatim recall | Only inside window | Yes | Yes | **Yes (top-K chunks, int8)** |
| Tamper-evident 22 KB capsule + SHA-256 chain | No | No | No | **Yes** |
