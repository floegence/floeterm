export type ScheduledTurnCancel = () => void;
export type ScheduleTurn = (callback: () => void) => void;

const NEXT_FRAME_FALLBACK_MS = 32;

export const scheduleUiTurn = (callback: () => void): ScheduledTurnCancel => {
  let completed = false;
  let rafId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    if (completed) {
      return;
    }
    completed = true;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    callback();
  };

  if (typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(run);
    timeoutId = setTimeout(run, NEXT_FRAME_FALLBACK_MS);
  } else {
    timeoutId = setTimeout(run, 0);
  }

  return () => {
    completed = true;
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
    }
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  };
};

export const scheduleNextFrame: ScheduleTurn = callback => {
  scheduleUiTurn(callback);
};
