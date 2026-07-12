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

  it('flushes all accepted batches synchronously before a lifecycle reset', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      scheduler: frames.scheduler,
      policy: { maxLiveBatchChunks: 1 },
    });

    pipeline.enqueue(chunk(1, 'a'));
    pipeline.enqueue(chunk(2, 'b'));
    pipeline.flushNow();

    expect(writes).toEqual(['a', 'b']);
    expect(frames.pendingFrames()).toBe(0);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      flushedChunks: 2,
      lastAppliedSequence: 2,
      pendingChunks: 0,
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
    expect(pipeline.getDrainState()).toEqual({
      livePending: false,
      inactivePending: true,
      catchUpPending: false,
      drainPending: true,
      disposed: false,
    });
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      inactiveChunks: 2,
      inactiveBytes: 2,
    }));

    interactive = true;
    pipeline.flush();

    expect(frames.pendingFrames()).toBe(1);
    expect(pipeline.getDrainState()).toEqual({
      livePending: true,
      inactivePending: false,
      catchUpPending: false,
      drainPending: true,
      disposed: false,
    });
    frames.flushFrame();

    expect(writes).toEqual(['ab']);
    expect(pipeline.getDrainState()).toEqual({
      livePending: false,
      inactivePending: false,
      catchUpPending: false,
      drainPending: false,
      disposed: false,
    });
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
    expect(pipeline.getDrainState()).toEqual({
      livePending: false,
      inactivePending: false,
      catchUpPending: true,
      drainPending: true,
      disposed: false,
    });
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
    expect(pipeline.getDrainState()).toEqual({
      livePending: false,
      inactivePending: false,
      catchUpPending: true,
      drainPending: true,
      disposed: false,
    });

    pipeline.reset({ startSequence: 3 });
    expect(pipeline.getDrainState()).toEqual({
      livePending: false,
      inactivePending: false,
      catchUpPending: false,
      drainPending: false,
      disposed: false,
    });
    pipeline.enqueue(chunk(3, 'c'));
    frames.flushFrame();

    expect(writes).toEqual(['c']);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      lastAppliedSequence: 3,
      catchUpPending: false,
    }));
  });

  it('buffers live output during catch-up and resumes it from the recovered baseline', () => {
    const frames = createManualFrameScheduler();
    const catchUps: TerminalOutputPipelineCatchUpRequest[] = [];
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      requestCatchUp: request => catchUps.push(request),
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(1, 'a'));
    frames.flushFrame();
    pipeline.enqueue(chunk(5, 'e'));
    pipeline.enqueue(chunk(6, 'f'));

    expect(catchUps).toHaveLength(1);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      catchUpPending: true,
      catchUpChunks: 2,
      catchUpBytes: 2,
    }));

    pipeline.reset({
      startSequence: 3,
      resumeCatchUp: true,
      allowSequenceSkipOnResume: true,
    });
    frames.flushFrame();

    expect(catchUps).toHaveLength(1);
    expect(writes).toEqual(['a', 'ef']);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      lastAppliedSequence: 6,
      catchUpPending: false,
      catchUpChunks: 0,
    }));
  });

  it('retains output that was queued before a sequence gap requested catch-up', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      requestCatchUp: () => {},
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(1, 'a'));
    pipeline.enqueue(chunk(3, 'c'));

    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      catchUpPending: true,
      catchUpChunks: 2,
      enqueuedChunks: 2,
      droppedChunks: 0,
    }));

    pipeline.reset({
      startSequence: 1,
      resumeCatchUp: true,
      allowSequenceSkipOnResume: true,
    });
    frames.flushFrame();

    expect(writes).toEqual(['ac']);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      enqueuedChunks: 2,
      flushedChunks: 2,
      lastAppliedSequence: 3,
    }));
  });

  it('drops catch-up chunks already covered by history while resuming newer live output', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      requestCatchUp: () => {},
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(5, 'covered'));
    pipeline.enqueue(chunk(6, 'fresh'));
    pipeline.reset({ startSequence: 6, resumeCatchUp: true });
    frames.flushFrame();

    expect(writes).toEqual(['fresh']);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      duplicateChunks: 1,
      lastAppliedSequence: 6,
    }));
  });

  it('keeps catch-up buffering bounded before resuming retained live output', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      requestCatchUp: () => {},
      scheduler: frames.scheduler,
      policy: {
        maxInactiveChunks: 2,
        maxInactiveBytes: 2,
      },
    });

    pipeline.enqueue(chunk(5, 'e'));
    pipeline.enqueue(chunk(6, 'f'));
    pipeline.enqueue(chunk(7, 'g'));

    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      catchUpChunks: 2,
      catchUpBytes: 2,
      droppedChunks: 1,
    }));

    pipeline.reset({
      startSequence: 3,
      resumeCatchUp: true,
      allowSequenceSkipOnResume: true,
    });
    frames.flushFrame();

    expect(writes).toEqual(['fg']);
    expect(pipeline.getStats().lastAppliedSequence).toBe(7);
  });

  it('keeps reset backward-compatible by discarding catch-up output unless resume is requested', () => {
    const frames = createManualFrameScheduler();
    const writes: string[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: data => writes.push(text(data)),
      requestCatchUp: () => {},
      scheduler: frames.scheduler,
    });

    pipeline.enqueue(chunk(2, 'b'));
    pipeline.enqueue(chunk(3, 'c'));
    pipeline.reset({ startSequence: 2 });
    frames.flushFrame();

    expect(writes).toEqual([]);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      catchUpPending: false,
      catchUpChunks: 0,
      pendingChunks: 0,
    }));
  });

  it('keeps resumed sequence validation strict unless sparse resume is explicitly allowed', () => {
    const catchUps: TerminalOutputPipelineCatchUpRequest[] = [];
    const pipeline = createTerminalOutputPipeline({
      write: () => {},
      requestCatchUp: request => catchUps.push(request),
    });

    pipeline.enqueue(chunk(5, 'e'));
    pipeline.reset({ startSequence: 3, resumeCatchUp: true });

    expect(catchUps).toHaveLength(2);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      catchUpPending: true,
      catchUpChunks: 1,
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
    expect(pipeline.getDrainState()).toEqual({
      livePending: false,
      inactivePending: false,
      catchUpPending: false,
      drainPending: false,
      disposed: true,
    });
    pipeline.enqueue(chunk(2, 'b'));
    frames.flushFrame();

    expect(writes).toEqual([]);
    expect(pipeline.getStats()).toEqual(expect.objectContaining({
      disposed: true,
      pendingChunks: 0,
    }));
  });
});
