const DEFAULT_BYTE_CAP = 256 * 1024;
const DEFAULT_CHUNK_CAP = 256;

const OVERFLOW_NOTICE = new TextEncoder().encode(
  "\x1bc\x1b[2m[Kai: dropped output during hibernation]\x1b[0m\r\n",
);

export class DormantRing {
  private chunks: (Uint8Array | null)[] = [];
  private head = 0;
  private size = 0;
  private total = 0;
  private overflowed = false;

  constructor(
    private readonly byteCap = DEFAULT_BYTE_CAP,
    private readonly chunkCap = DEFAULT_CHUNK_CAP,
  ) {}

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (bytes.length >= this.byteCap) {
      this.chunks = [OVERFLOW_NOTICE, bytes.subarray(bytes.length - this.byteCap)];
      this.head = 0;
      this.size = 2;
      this.total = OVERFLOW_NOTICE.length + this.byteCap;
      this.overflowed = true;
      return;
    }
    this.chunks.push(bytes);
    this.size++;
    this.total += bytes.length;
    while (
      (this.total > this.byteCap || this.size > this.chunkCap) &&
      this.size > 1
    ) {
      const dropped = this.chunks[this.head]!;
      this.chunks[this.head] = null;
      this.head++;
      this.size--;
      this.total -= dropped.length;
      this.overflowed = true;
    }
    if (this.head > 1024 && this.head > this.chunks.length / 2) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  drain(write: (bytes: Uint8Array) => void): void {
    if (this.overflowed) {
      const first = this.chunks[this.head];
      if (first !== OVERFLOW_NOTICE) write(OVERFLOW_NOTICE);
    }
    const end = this.head + this.size;
    for (let i = this.head; i < end; i++) {
      const c = this.chunks[i];
      if (c) write(c);
    }
    this.chunks = [];
    this.head = 0;
    this.size = 0;
    this.total = 0;
    this.overflowed = false;
  }

  /** Drain into a bounded POP-UP ITERATOR instead of a single write burst
   *  (2026-10-31 smooth-switch fix A+B): yields the next chunk and the
   *  REMAINING byte count, letting the caller pace writes across frames.
   *
   *  `budgetBytes` bounds what will EVER be replayed (fix B): a backlog
   *  accumulated while the project was hidden is build-log spam — only the
   *  TAIL matters. When the backlog exceeds the budget, the head is dropped
   *  up-front with the overflow notice, and the iterator yields the tail.
   *  Callers that want the old all-at-once behavior pass Infinity (the
   *  single-shot `drain` above stays untouched for that contract).
   *
   *  Consuming the iterator (or abandoning it) always resets the ring. */
  *drainChunked(budgetBytes = Infinity): Generator<{ bytes: Uint8Array; remaining: number }> {
    if (this.total > budgetBytes && this.size > 0) {
      // Drop from the head until within budget (keep at least one chunk).
      while (this.total > budgetBytes && this.size > 1) {
        const dropped = this.chunks[this.head];
        if (dropped) this.total -= dropped.length;
        this.chunks[this.head] = null;
        this.head++;
        this.size--;
      }
      this.overflowed = true;
    }
    if (this.overflowed) {
      const first = this.chunks[this.head];
      if (first !== OVERFLOW_NOTICE) {
        yield { bytes: OVERFLOW_NOTICE, remaining: this.total };
      }
    }
    const startTotal = this.total;
    let yielded = 0;
    try {
      const end = this.head + this.size;
      for (let i = this.head; i < end; i++) {
        const c = this.chunks[i];
        if (!c) continue;
        yielded += c.length;
        yield { bytes: c, remaining: Math.max(0, startTotal - yielded) };
      }
    } finally {
      // Fully consumed OR abandoned: the ring is spent either way. Abandoned
      // iterators drop the un-yielded backlog - replays must be one-shot.
      this.chunks = [];
      this.head = 0;
      this.size = 0;
      this.total = 0;
      this.overflowed = false;
    }
  }

  byteLength(): number {
    return this.total;
  }
}
