import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTerminalInstance, type TerminalThemeName } from '@floegence/floeterm-terminal-web';
import { createEventSource, createTransport, getOrCreateConnId } from './terminalApi';

const SESSION_STORAGE_KEY = 'floeterm_session_id';
const THEME_STORAGE_KEY = 'floeterm_theme_name';

const isThemeName = (value: string): value is TerminalThemeName => {
  return value === 'tokyoNight' || value === 'dark' || value === 'monokai' || value === 'solarizedDark' || value === 'light';
};

const useMediaQuery = (query: string): boolean => {
  const getMatch = () => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);

    onChange();
    const legacyMql = mql as MediaQueryList & {
      addListener?: (listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void) => void;
    };

    if (typeof legacyMql.addEventListener === 'function') {
      legacyMql.addEventListener('change', onChange);
      return () => legacyMql.removeEventListener('change', onChange);
    }

    legacyMql.addListener?.(onChange);
    return () => legacyMql.removeListener?.(onChange);
  }, [query]);

  return matches;
};

const TerminalPane = (props: {
  sessionId: string;
  transport: ReturnType<typeof createTransport>;
  eventSource: ReturnType<typeof createEventSource>;
  isBusy: boolean;
  error: string;
  onRestart: () => void;
}) => {
  const isMobile = useMediaQuery('(max-width: 640px), (pointer: coarse)');
  const fontSize = isMobile ? 14 : 12;
  const [themeName, setThemeName] = useState<TerminalThemeName>(() => {
    if (typeof window === 'undefined') {
      return 'tokyoNight';
    }
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) ?? '';
    return isThemeName(stored) ? stored : 'tokyoNight';
  });
  const { containerRef, actions, state, loadingMessage } = useTerminalInstance({
    sessionId: props.sessionId,
    isActive: true,
    autoFocus: !isMobile,
    fontSize,
    themeName,
    transport: props.transport,
    eventSource: props.eventSource
  });

  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  const didApplyThemeRef = useRef(false);

  useEffect(() => {
    if (!didApplyThemeRef.current) {
      didApplyThemeRef.current = true;
      return;
    }
    actionsRef.current.reinitialize?.();
  }, [themeName]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.dataset.theme = themeName;
  }, [themeName]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(THEME_STORAGE_KEY, themeName);
  }, [themeName]);

  useEffect(() => {
    actionsRef.current.setFontSize(fontSize);
    actionsRef.current.forceResize();
  }, [fontSize]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const scheduleResize = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          actionsRef.current.forceResize();
        });
      });
    };

    scheduleResize();
    const postLayoutTimer = setTimeout(scheduleResize, 200);

    const onResize = () => scheduleResize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    const vv = window.visualViewport;
    vv?.addEventListener('resize', onResize);
    vv?.addEventListener('scroll', onResize);

    return () => {
      clearTimeout(postLayoutTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      vv?.removeEventListener('resize', onResize);
      vv?.removeEventListener('scroll', onResize);
    };
  }, []);

  return (
    <div className="main">
      <div className="toolbar">
        <div className="toolbarPrimary">
          <span className="appTitle">floeterm</span>
          <span className="status">
            {state.state}
            {loadingMessage ? ` :: ${loadingMessage}` : ''}
          </span>
        </div>
        <div className="toolbarActions">
          <select value={themeName} onChange={e => setThemeName(e.target.value as TerminalThemeName)} disabled={props.isBusy}>
            <option value="tokyoNight">tokyo night</option>
            <option value="dark">dark</option>
            <option value="monokai">monokai</option>
            <option value="solarizedDark">solarized dark</option>
            <option value="light">light</option>
          </select>
          <button onClick={props.onRestart} disabled={props.isBusy}>
            restart
          </button>
          <button onClick={() => actions.clear()} disabled={props.isBusy}>
            clear
          </button>
        </div>
      </div>
      {props.error ? <div className="error">{props.error}</div> : null}
      <div className="terminalContainer">
        <div className="terminalPane" ref={containerRef} />
      </div>
    </div>
  );
};

export const App = () => {
  const connId = useMemo(() => getOrCreateConnId(), []);
  const transport = useMemo(() => createTransport(connId), [connId]);
  const eventSource = useMemo(() => createEventSource(connId), [connId]);

  const [sessionId, setSessionId] = useState<string>('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const didInitRef = useRef(false);

  const ensureSingleSession = useCallback(async () => {
    if (didInitRef.current) {
      return;
    }
    didInitRef.current = true;

    setIsBusy(true);
    setError('');

    try {
      const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '';
      const list = await transport.listSessions();

      let chosen = '';
      if (stored && list.some(item => item.id === stored)) {
        chosen = stored;
      } else if (list.length > 0) {
        chosen = list[0].id;
      } else {
        const created = await transport.createSession('', '', 80, 24);
        chosen = created.id;
      }

      // Best-effort cleanup to enforce "single session" semantics in the app.
      await Promise.all(
        list
          .filter(item => item.id !== chosen)
          .map(item => transport.deleteSession(item.id).catch(() => {}))
      );

      window.sessionStorage.setItem(SESSION_STORAGE_KEY, chosen);
      setSessionId(chosen);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [transport]);

  const restartSession = useCallback(async () => {
    setIsBusy(true);
    setError('');

    try {
      const current = sessionId;
      if (current) {
        await transport.deleteSession(current).catch(() => {});
      }
      const created = await transport.createSession('', '', 80, 24);
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, created.id);
      setSessionId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [transport, sessionId]);

  useEffect(() => {
    ensureSingleSession().catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [ensureSingleSession]);

  return (
    <div className="app">
      {sessionId ? (
        <TerminalPane
          key={sessionId}
          sessionId={sessionId}
          transport={transport}
          eventSource={eventSource}
          isBusy={isBusy}
          error={error}
          onRestart={restartSession}
        />
      ) : (
        <div className="main">
          <div className="toolbar">
            <div className="toolbarPrimary">
              <span className="appTitle">floeterm</span>
              <span className="status">{isBusy ? 'initializing...' : 'idle'}</span>
            </div>
          </div>
          {error ? <div className="error">{error}</div> : null}
          <div className="terminalContainer">
            <div className="terminalPane">
              <div className="loading">{isBusy ? 'connecting' : 'waiting'}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
