import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTerminalInstance } from '@floegence/floeterm-terminal-web';
import { createEventSource, createTransport, getOrCreateConnId } from './terminalApi';

const SESSION_STORAGE_KEY = 'floeterm_session_id';

const TerminalPane = (props: {
  sessionId: string;
  transport: ReturnType<typeof createTransport>;
  eventSource: ReturnType<typeof createEventSource>;
  isBusy: boolean;
  error: string;
  onRestart: () => void;
}) => {
  const { containerRef, actions, state, loadingMessage } = useTerminalInstance({
    sessionId: props.sessionId,
    isActive: true,
    autoFocus: true,
    transport: props.transport,
    eventSource: props.eventSource
  });

  return (
    <div className="main">
      <div className="toolbar">
        <span className="appTitle">floeterm</span>
        <span className="status">
          State: {state.state}
          {loadingMessage ? ` · ${loadingMessage}` : ''}
        </span>
        <span className="spacer" />
        <button onClick={props.onRestart} disabled={props.isBusy}>
          Restart Session
        </button>
        <button onClick={() => actions.clear()} disabled={props.isBusy}>
          Clear
        </button>
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
            <span className="appTitle">floeterm</span>
            <span className="status">{isBusy ? 'Starting...' : 'Idle'}</span>
          </div>
          {error ? <div className="error">{error}</div> : null}
        </div>
      )}
    </div>
  );
};
