import type { TerminalDataChunk } from '../types.js';

interface SequenceBufferConfig {
  maxPendingChunks: number;
  maxPendingBytes: number;
}

const defaultConfig: SequenceBufferConfig = {
  maxPendingChunks: 4096,
  maxPendingBytes: 8 * 1024 * 1024,
};

const normalizePositiveInteger = (value: number | undefined, fallback: number): number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
);

// Reliable transports may reorder delivery across the history/live handoff, but
// they must never infer or skip a missing sequence. Recovery owns gap resolution.
export class SequenceBuffer {
  private expectedSequence = 1;
  private readonly pending = new Map<number, TerminalDataChunk>();
  private pendingBytes = 0;
  private readonly config: SequenceBufferConfig;

  constructor(config: Partial<SequenceBufferConfig> = {}) {
    this.config = {
      maxPendingChunks: normalizePositiveInteger(config.maxPendingChunks, defaultConfig.maxPendingChunks),
      maxPendingBytes: normalizePositiveInteger(config.maxPendingBytes, defaultConfig.maxPendingBytes),
    };
  }

  reset(startSequence: number): void {
    this.expectedSequence = Number.isSafeInteger(startSequence) && startSequence > 0
      ? startSequence
      : 1;
    this.pending.clear();
    this.pendingBytes = 0;
  }

  flushPending(): TerminalDataChunk[] {
    const ready: TerminalDataChunk[] = [];
    while (this.pending.has(this.expectedSequence)) {
      const chunk = this.pending.get(this.expectedSequence)!;
      this.pending.delete(this.expectedSequence);
      this.pendingBytes -= chunk.data.byteLength;
      ready.push(chunk);
      this.expectedSequence += 1;
    }
    return ready;
  }

  push(chunk: TerminalDataChunk, _now = Date.now()): TerminalDataChunk[] {
    const sequence = chunk.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      return [chunk];
    }
    if (sequence < this.expectedSequence || this.pending.has(sequence)) {
      return [];
    }
    if (sequence === this.expectedSequence) {
      this.expectedSequence += 1;
      return [chunk, ...this.flushPending()];
    }

    if (
      this.pending.size + 1 > this.config.maxPendingChunks
      || this.pendingBytes + chunk.data.byteLength > this.config.maxPendingBytes
    ) {
      throw new Error('terminal output reorder queue limit exceeded');
    }
    this.pending.set(sequence, chunk);
    this.pendingBytes += chunk.data.byteLength;
    return [];
  }

  assertCoveredThrough(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('terminal output replay boundary is invalid');
    }
    if (this.expectedSequence <= sequence) {
      throw new Error(`missing terminal output sequence ${this.expectedSequence} before replay boundary ${sequence}`);
    }
  }

  coverThrough(sequence: number): TerminalDataChunk[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('terminal output replay coverage is invalid');
    }
    if (sequence < this.expectedSequence - 1) {
      return [];
    }

    const covered = [...this.pending.entries()]
      .filter(([pendingSequence]) => pendingSequence <= sequence)
      .sort(([left], [right]) => left - right)
      .map(([pendingSequence, chunk]) => {
        this.pending.delete(pendingSequence);
        this.pendingBytes -= chunk.data.byteLength;
        return chunk;
      });
    this.expectedSequence = sequence + 1;
    return [...covered, ...this.flushPending()];
  }
}
