// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  isDemoMode,
  resolveRequestedSingleSession,
  resolveInitialDemoState,
  updateDemoModeSearchParams,
} from './demoRuntime';

const existingSession = {
  id: 'shared-session',
  name: 'shared-from-another-page',
  workingDir: '/',
  createdAtMs: 1,
  lastActiveAtMs: 1,
  isActive: true,
};

describe('floeterm demo modes', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('treats mirror as a first-class demo mode', () => {
    expect(isDemoMode('mirror')).toBe(true);
    window.history.replaceState(null, '', '/?mode=mirror');
    expect(resolveInitialDemoState().mode).toBe('mirror');
  });

  it('keeps mirror URLs independent from grid sizing', () => {
    window.history.replaceState(null, '', '/?mode=grid&count=64');
    updateDemoModeSearchParams('mirror', 64);
    const params = new URLSearchParams(window.location.search);
    expect(params.get('mode')).toBe('mirror');
    expect(params.has('count')).toBe(false);
    expect(params.has('grid')).toBe(false);
  });

  it('treats an explicitly requested session as externally managed', () => {
    window.history.replaceState(null, '', '/?mode=single&session=shared-session');
    const initial = resolveInitialDemoState();
    expect(initial.requestedSessionId).toBe('shared-session');
    expect(resolveRequestedSingleSession([existingSession], initial.requestedSessionId)).toEqual(existingSession);
  });

  it('rejects a missing requested session instead of selecting a substitute', () => {
    expect(() => resolveRequestedSingleSession([], 'missing-session')).toThrow(
      /requested terminal session .* was not found/i,
    );
    expect(resolveRequestedSingleSession([existingSession], '')).toBeNull();
  });
});
