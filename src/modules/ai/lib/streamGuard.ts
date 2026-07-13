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
   * Calculate similarity between two strings using a simple metric
   */
  private similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;

    // Normalize to lowercase for comparison
    const aNorm = a.toLowerCase();
    const bNorm = b.toLowerCase();

    // Use Jaccard similarity on word sets
    const wordsA = this.tokenize(aNorm);
    const wordsB = this.tokenize(bNorm);

    const intersection = wordsA.filter((w) => wordsB.includes(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;

    return union > 0 ? intersection / union : 0;
  }

  /**
   * Tokenize text into words
   */
  private tokenize(text: string): string[] {
    return text
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3); // Ignore short words
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
