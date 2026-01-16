import type { TerminalDataChunk } from '../types';

interface SequenceBufferConfig {
  maxPendingChunks: number;
  maxSequenceGap: number;
  cleanupIntervalMs: number;
  forceCleanupThreshold: number;
}

const defaultConfig: SequenceBufferConfig = {
  maxPendingChunks: 40,
  maxSequenceGap: 32,
  cleanupIntervalMs: 5000,
  forceCleanupThreshold: 60
};

// SequenceBuffer reorders chunks based on sequence numbers while limiting memory growth.
export class SequenceBuffer {
  private expectedSequence = 1;
  private pending = new Map<number, TerminalDataChunk>();
  private lastCleanupMs = Date.now();
  private config: SequenceBufferConfig;

  constructor(config: Partial<SequenceBufferConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  reset(startSequence: number): void {
    this.expectedSequence = Math.max(1, startSequence);
    this.pending.clear();
    this.lastCleanupMs = Date.now();
  }

  push(chunk: TerminalDataChunk, now = Date.now()): TerminalDataChunk[] {
    const sequence = chunk.sequence;
    const ready: TerminalDataChunk[] = [];

    if (!Number.isInteger(sequence) || sequence < 1) {
      ready.push(chunk);
      return ready;
    }

    this.cleanupIfNeeded(now);

    if (sequence === this.expectedSequence) {
      ready.push(chunk);
      this.expectedSequence += 1;

      while (this.pending.has(this.expectedSequence)) {
        const next = this.pending.get(this.expectedSequence);
        if (next) {
          ready.push(next);
        }
        this.pending.delete(this.expectedSequence);
        this.expectedSequence += 1;
      }

      return ready;
    }

    const withinGap = sequence > this.expectedSequence && sequence <= this.expectedSequence + this.config.maxSequenceGap;
    if (withinGap && this.pending.size < this.config.maxPendingChunks) {
      this.pending.set(sequence, chunk);
      return ready;
    }

    if (sequence > this.expectedSequence) {
      this.expectedSequence = sequence + 1;
      this.pending.clear();
    }

    ready.push(chunk);
    return ready;
  }

  private cleanupIfNeeded(now: number): void {
    if (this.pending.size >= this.config.forceCleanupThreshold) {
      this.pending.clear();
      this.lastCleanupMs = now;
      return;
    }

    if (now-this.lastCleanupMs < this.config.cleanupIntervalMs) {
      return;
    }

    const cutoff = this.expectedSequence + this.config.maxSequenceGap;
    for (const seq of this.pending.keys()) {
      if (seq < this.expectedSequence || seq > cutoff) {
        this.pending.delete(seq);
      }
    }

    this.lastCleanupMs = now;
  }
}
