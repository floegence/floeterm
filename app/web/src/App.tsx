import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTerminalInstance, type TerminalSessionInfo } from '@floeterm/terminal-web';
import { createEventSource, createTransport, getOrCreateConnId } from './terminalApi';

const TerminalPane = (props: {
  sessionId: string;
  transport: ReturnType<typeof createTransport>;
  eventSource: ReturnType<typeof createEventSource>;
}) => {
  const { containerRef, actions, state, loadingMessage } = useTerminalInstance({
    sessionId: props.sessionId,
    isActive: true,
    transport: props.transport,
    eventSource: props.eventSource
  });

  return (
    <div className="main">
      <div className="toolbar">
        <span className="status">
          State: {state.state}
          {loadingMessage ? ` · ${loadingMessage}` : ''}
        </span>
        <span className="spacer" />
        <button onClick={() => actions.clear()}>Clear</button>
      </div>
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

  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const didAutoCreateRef = useRef(false);

  const refreshSessions = useCallback(async () => {
    if (!transport.listSessions) {
      return;
    }
    const list = await transport.listSessions();
    setSessions(list);
    if (!selectedSessionId && list.length > 0) {
      setSelectedSessionId(list[0].id);
    }
  }, [transport, selectedSessionId]);

  const createSession = useCallback(async () => {
    if (!transport.createSession) {
      return;
    }
    setIsBusy(true);
    setError('');
    try {
      const created = await transport.createSession('', '', 80, 24);
      await refreshSessions();
      setSelectedSessionId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [transport, refreshSessions]);

  const deleteSelected = useCallback(async () => {
    if (!transport.deleteSession || !selectedSessionId) {
      return;
    }
    setIsBusy(true);
    setError('');
    try {
      await transport.deleteSession(selectedSessionId);
      setSelectedSessionId('');
      await refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [transport, selectedSessionId, refreshSessions]);

  useEffect(() => {
    refreshSessions().catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [refreshSessions]);

  useEffect(() => {
    if (didAutoCreateRef.current) {
      return;
    }

    if (sessions.length === 0 && transport.createSession && !isBusy) {
      didAutoCreateRef.current = true;
      createSession().catch(() => {});
    }
  }, [sessions.length, transport.createSession, createSession, isBusy]);

  return (
    <div className="app">
      <div className="sidebar">
        <h1>floeterm</h1>
        <button onClick={() => createSession()} disabled={isBusy}>
          New Session
        </button>
        <div className="sessionList">
          {sessions.map(session => (
            <div
              key={session.id}
              className={`sessionItem ${session.id === selectedSessionId ? 'sessionItemActive' : ''}`}
              onClick={() => setSelectedSessionId(session.id)}
              role="button"
              tabIndex={0}
            >
              <div className="sessionTitle">{session.name || session.id}</div>
              <div className="sessionMeta">{session.workingDir}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={() => deleteSelected()} disabled={isBusy || !selectedSessionId}>
            Delete Selected
          </button>
        </div>
        {error ? (
          <div style={{ marginTop: 12, fontSize: 12, color: '#b91c1c', whiteSpace: 'pre-wrap' }}>{error}</div>
        ) : null}
      </div>

      {selectedSessionId ? (
        <TerminalPane sessionId={selectedSessionId} transport={transport} eventSource={eventSource} />
      ) : (
        <div className="main">
          <div className="toolbar">
            <span className="status">No session selected</span>
          </div>
        </div>
      )}
    </div>
  );
};
