import { describe, expect, it } from 'vitest';
import {
  createTerminalOutputPipeline,
  type TerminalOutputPipelineCatchUpRequest,
  type TerminalOutputPipelineChunk,
  type TerminalOutputPipelineScheduler,
} from './TerminalOutputPipeline';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function chunk(sequence: number | undefined, payload: string): TerminalOutputPipelineChunk {
  return {
    data: bytes(payload),
    ...(typeof sequence === 'number' ? { sequence } : {}),
  };
}

function createManualFrameScheduler(): {
  scheduler: TerminalOutputPipelineScheduler;
  pendingFrames: () => number;
  flushFrame: () => void;
} {
  let nextId = 1;
  let now = 0;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    scheduler: {
      requestFrame: callback => {
        const id = nextId;
        nextId += 1;
        frames.set(id, callback);
        return id;
      },
      cancelFrame: handle => {
        frames.delete(handle);
      },
      now: () => now,
    },
    pendingFrames: () => frames.size,
    flushFrame: () => {
      now += 16;
      const callbacks = Array.from(frames.values());
      frames.clear();
      for (const callback of callbacks) {
        callback(now);
      }
    },
  };
}

describe('TerminalOutputPipeline', () => {
  it('flushes the first interactive live output on the next frame', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(1, 'a'));

    expect(writes).toEqual([]);
    expect(frames.pendingFrames()).toBe(1);

    frames.flushFrame();

    expect(writes).toEqual(['a']);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      flushedChunks: 1,
      lastAppliedSequence: 1,
    }));
  });

  it('merges large output into bounded frame batches', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const flushedBatchSizes: number[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: (data, batch) => {
        writes.push(text(data));
        flushedBatchSizes.push(batch.length);
      },
      scheduler: frames.scheduler,
      policy: {
        maxLiveBatchChunks: 2,
        maxLiveBatchBytes: 3,
      },
    });

    pipeline.enqueue(chunk(1, 'a'));
    pipeline.enqueue(chunk(2, 'b'));
    pipeline.enqueue(chunk(3, 'cd'));

    frames.flushFrame();

    expect(writes).toEqual(['ab']);
    expect(flushedBatchSizes).toEqual([2]);
    expect(frames.pendingFrames()).toBe(1);

    frames.flushFrame();

    expect(writes).toEqual(['ab', 'cd']);
    expect(flushedBatchSizes).toEqual([2, 1]);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      flushedChunks: 3,
      flushedBytes: 4,
    }));
  });

  it('buffers inactive output and drains it when the host becomes interactive', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    let interactive = false;
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      isInteractive: () => interactive,
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(1, 'a'));
    pipeline.enqueue(chunk(2, 'b'));

    expect(writes).toEqual([]);
    expect(frames.pendingFrames()).toBe(0);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      inactiveChunks: 2,
      inactiveBytes: 2,
    }));

    interactive = true;
    pipeline.flush();

    expect(frames.pendingFrames()).toBe(1);
    frames.flushFrame();

    expect(writes).toEqual(['ab']);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      inactiveChunks: 0,
      pendingChunks: 0,
      lastAppliedSequence: 2,
    }));
  });

  it('requests catch-up when the inactive buffer overflows', () => {
    const catchUps: TerminalOutputPipelineCatchUpRequest[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: () => {},
      isInteractive: () => false,
      requestCatchUp: request => catchUps.push(request),
      policy: {
        maxInactiveChunks: 1,
        maxInactiveBytes: 10,
      },
    });

    pipeline.enqueue(chunk(1, 'a'));
    pipeline.enqueue(chunk(2, 'b'));

    expect(catchUps).toEqual([
      expect.objectContaining({
        reason: 'inactive-buffer-overflow',
        startSequence: 1,
        firstBufferedSequence: 1,
        droppedChunks: 2,
        droppedBytes: 2,
      }),
    ]);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      catchUpPending: true,
      inactiveChunks: 0,
      catchUpRequests: 1,
      inactiveOverflows: 1,
    }));
  });

  it('detects sequence gaps and resumes only after reset', () => {
    const frames = createManualFrameScheduler();
    const catchUps: TerminalOutputPipelineCatchUpRequest[] = [];
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      requestCatchUp: request => catchUps.push(request),
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(2, 'b'));
    pipeline.enqueue(chunk(3, 'c'));
    frames.flushFrame();

    expect(writes).toEqual([]);
    expect(catchUps).toEqual([
      expect.objectContaining({
        reason: 'sequence-gap',
        startSequence: 0,
        expectedSequence: 1,
        observedSequence: 2,
      }),
    ]);
    expect(pipeline.getStats().catchUpPending).toBe(true);

    pipeline.reset({ startSequence: 3 });
    pipeline.enqueue(chunk(3, 'c'));
    frames.flushFrame();

    expect(writes).toEqual(['c']);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      lastAppliedSequence: 3,
      catchUpPending: false,
    }));
  });

  it('deduplicates already queued or applied sequence chunks', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(1, 'a'));
    pipeline.enqueue(chunk(1, 'duplicate-queued'));
    frames.flushFrame();
    pipeline.enqueue(chunk(1, 'duplicate-applied'));
    frames.flushFrame();

    expect(writes).toEqual(['a']);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      duplicateChunks: 2,
      lastAppliedSequence: 1,
    }));
  });

  it('resets pending output after clear and accepts the reset start sequence', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(1, 'before-clear'));
    pipeline.reset({ startSequence: 1 });
    frames.flushFrame();

    pipeline.enqueue(chunk(1, 'after-clear'));
    frames.flushFrame();

    expect(writes).toEqual(['after-clear']);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      pendingChunks: 0,
      lastAppliedSequence: 1,
    }));
  });

  it('cancels pending frame work on dispose', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(1, 'a'));
    expect(frames.pendingFrames()).toBe(1);

    pipeline.dispose();

    expect(frames.pendingFrames()).toBe(0);
    pipeline.enqueue(chunk(2, 'b'));
    frames.flushFrame();

    expect(writes).toEqual([]);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      disposed: true,
      pendingChunks: 0,
    }));
  });
});
