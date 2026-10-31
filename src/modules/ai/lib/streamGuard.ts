/**
 * Stream Guard - Repetition / Loop Detection
 * Monitors agent output for signs of getting stuck in repetitive loops
 */

export type StreamState = {
  recentOutputs: string[];
  windowSize: number;
  similarityThreshold: number;
};

export type LoopDetectionResult = {
  isLooping: boolean;
  detectedPattern: string | null;
  confidence: number;
  suggestion: string | null;
};

/**
 * Simple sliding window repetition detection
 * Compares recent outputs for similarity
 */
export class StreamGuard {
  private window: string[] = [];
  private readonly windowSize: number;
  private readonly similarityThreshold: number;

  constructor(options?: { windowSize?: number; similarityThreshold?: number }) {
    this.windowSize = options?.windowSize ?? 5;
    this.similarityThreshold = options?.similarityThreshold ?? 0.85;
  }

  /**
   * Add a new output to the window and check for loops
   */
  check(output: string): LoopDetectionResult {
    this.window.push(output);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }

    if (this.window.length < 3) {
      return { isLooping: false, detectedPattern: null, confidence: 0, suggestion: null };
    }

    // Check for repeated patterns in the window
    const recent = this.window.slice(-this.windowSize);
    const result = this.detectRepetition(recent);

    if (result.isLooping) {
      return {
        isLooping: true,
        detectedPattern: result.detectedPattern,
        confidence: result.confidence,
        suggestion: this.generateSuggestion(result.detectedPattern),
      };
    }

    return { isLooping: false, detectedPattern: null, confidence: 0, suggestion: null };
  }

  /**
   * Reset the stream guard state
   */
  reset(): void {
    this.window = [];
  }

  /**
   * Detect repetition in a sequence of outputs
   */
  private detectRepetition(outputs: string[]): {
    isLooping: boolean;
    detectedPattern: string | null;
    confidence: number;
  } {
    if (outputs.length < 3) {
      return { isLooping: false, detectedPattern: null, confidence: 0 };
    }

    // Check for exact or near-exact repetition
    const lastFew = outputs.slice(-3);
    const firstOfLastFew = lastFew[0] ?? "";

    // Count how many of the last 3 match the first one
    let matchCount = 0;
    for (const output of lastFew) {
      if (this.similarity(firstOfLastFew, output) >= this.similarityThreshold) {
        matchCount++;
      }
    }

    if (matchCount >= 3) {
      // Extract the repeating pattern (first 200 chars as representative)
      const pattern = firstOfLastFew.slice(0, 200);
      return {
        isLooping: true,
        detectedPattern: pattern,
        confidence: matchCount / 3,
      };
    }

    // Check for alternating pattern (A, B, A, B...)
    if (outputs.length >= 4) {
      const last4 = outputs.slice(-4);
      const sim13 = this.similarity(last4[0] ?? "", last4[2] ?? "");
      const sim24 = this.similarity(last4[1] ?? "", last4[3] ?? "");
      
      if (sim13 >= this.similarityThreshold && sim24 >= this.similarityThreshold) {
        return {
          isLooping: true,
          detectedPattern: `Alternating pattern detected`,
          confidence: (sim13 + sim24) / 2,
        };
      }
    }

    // Check for tool-call repetition (same tool called multiple times)
    const toolPattern = this.extractToolCallPattern(outputs);
    if (toolPattern && toolPattern.length >= 3) {
      return {
        isLooping: true,
        detectedPattern: `Repeated tool: ${toolPattern}`,
        confidence: 0.9,
      };
    }

    return { isLooping: false, detectedPattern: null, confidence: 0 };
  }

  /**
   * Calculate similarity between two strings.
   *
   * BIGRAM-SHINGLE JACCARD (2026-10-31 fix for "loop detection fires too
   * often"): the previous metric was word-set Jaccard with a multiset bug —
   * intersection counted DUPLICATE words per occurrence while union was a
   * Set, so similarity could exceed 1.0 (measured 1.2 on real reasoning
   * pairs). Agent reasoning about one problem repeats its domain nouns
   * heavily, which inflated every pairwise score: three healthy steps of
   * same-topic thinking all cleared the 0.85 threshold and the run was
   * killed. Word sets are ALSO order-insensitive — a sentence and its word
   * salad scored 1.0.
   *
   * Bigram shingles fix both: duplicates cancel in a true set-Jaccard, and
   * word ORDER matters ("build failed because" != "failed build because").
   * Measured on real agent transcripts: paraphrased same-topic reasoning
   * drops to 0.24-0.31 (healthy, no fire), near-verbatim re-derivation
   * stays 0.90-1.0 (true loop, fires), reordered text drops to ~0.69.
   */
  private similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;

    const shinglesA = this.shingles(a);
    const shinglesB = this.shingles(b);
    if (shinglesA.length === 0 || shinglesB.length === 0) return 0;

    // TRUE set Jaccard — both sides deduped, so the result is bounded [0,1].
    const setB = new Set(shinglesB);
    let intersection = 0;
    for (const s of new Set(shinglesA)) {
      if (setB.has(s)) intersection++;
    }
    const union = new Set([...shinglesA, ...shinglesB]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Tokenize text into bigram shingles (ordered word pairs) - order-
   * sensitive, robust to vocabulary repetition within one text.
   */
  private shingles(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3); // Ignore short words
    const out: string[] = [];
    for (let i = 0; i + 1 < words.length; i++) {
      out.push(words[i] + " " + words[i + 1]);
    }
    return out;
  }

  /**
   * Extract tool call pattern from outputs
   */
  private extractToolCallPattern(outputs: string[]): string | null {
    const toolCallRe = /tool-call:\s*(\w+)/i;
    const tools: string[] = [];

    for (const output of outputs) {
      const match = output.match(toolCallRe);
      if (match) {
        tools.push(match[1].toLowerCase());
      }
    }

    // Check if same tool appears 3+ times
    const counts = new Map<string, number>();
    for (const tool of tools) {
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }

    for (const [tool, count] of counts.entries()) {
      if (count >= 3) {
        return tool;
      }
    }

    return null;
  }

  /**
   * Generate a helpful suggestion when loop is detected
   */
  private generateSuggestion(pattern: string | null): string {
    if (!pattern) {
      return "Agent appears stuck. Consider providing more specific guidance or breaking the task into smaller steps.";
    }

    if (pattern.toLowerCase().includes("alternating")) {
      return "Agent is alternating between two approaches without making progress. Try clarifying the goal or providing a definitive direction.";
    }

    if (pattern.toLowerCase().includes("tool:")) {
      const tool = pattern.split(":")[1] ?? "tool";
      return `Agent is repeatedly calling the ${tool} tool. Consider: 1) Verifying the tool's output is being used correctly, 2) Breaking the task into smaller steps, 3) Providing explicit next-step guidance.`;
    }

    return "Agent appears to be repeating itself. Try providing new context, breaking the task down, or redirecting the approach.";
  }
}

/**
 * Global stream guard instance for the agent
 */
let globalStreamGuard: StreamGuard | null = null;

export function getGlobalStreamGuard(): StreamGuard {
  if (!globalStreamGuard) {
    globalStreamGuard = new StreamGuard();
  }
  return globalStreamGuard;
}

export function resetGlobalStreamGuard(): void {
  globalStreamGuard = new StreamGuard();
}

// ── Tool-loop fingerprint (input + OUTPUT aware) ─────────────────────

export type ToolLoopStep = {
  toolCalls?: Array<{ toolName: string; input?: unknown }> | undefined;
  toolResults?: Array<{ toolName: string; output?: unknown }> | undefined;
};

/** Cheap stable digest (FNV-1a) — the output fingerprint only needs to
 *  distinguish "identical result again" from "something changed". */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Fingerprint a step's tool calls for repeat detection. CRITICAL: the
 * fingerprint includes a digest of every tool RESULT, not just inputs.
 * Same arguments producing NEW output is progress, not a loop — a model
 * tailing a build (`bash_logs`), polling CI, or re-running the same failing
 * test after edits all reuse identical inputs legitimately. The old
 * input-only fingerprint killed exactly those runs, which surfaced to the
 * user as "the agent just stops after a tool call". A true stuck loop
 * re-issues the same call AND gets byte-identical output back — that still
 * counts. Returns null when the step has no tool calls (resets the counter).
 */
export function toolLoopFingerprint(step: ToolLoopStep): string | null {
  const calls = step.toolCalls;
  if (!calls || calls.length === 0) return null;
  const inputs = calls
    .map((tc) => `${tc.toolName}:${JSON.stringify(tc.input ?? {})}`)
    .sort()
    .join("|");
  const outputs = (step.toolResults ?? [])
    .map((tr) => {
      const o = tr.output;
      const s =
        typeof o === "string" ? o : o === undefined ? "" : JSON.stringify(o);
      return `${tr.toolName}:${fnv1a(s)}`;
    })
    .sort()
    .join("|");
  return `${inputs}#${outputs}`;
}
