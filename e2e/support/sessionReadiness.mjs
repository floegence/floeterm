export const waitForInteractiveShell = async (page, sessionId) => {
  await page.waitForFunction(async expectedSessionId => {
    const response = await fetch('/api/sessions');
    if (!response.ok) return false;
    const sessions = await response.json();
    const session = sessions.find(item => item.id === expectedSessionId);
    const harness = window.__floetermPerfHarness;
    const presentation = harness?.getPresentationDiagnostics?.();
    return session?.isActive === true
      && session.foregroundCommand?.phase === 'idle'
      && harness?.getSnapshot().connection.isConnected === true
      && Number.isSafeInteger(presentation?.sequence)
      && presentation.sequence > 0
      && presentation.state?.sequence === presentation.sequence
      && presentation.frame?.width === presentation.geometry?.cols
      && presentation.frame?.height === presentation.geometry?.rows;
  }, sessionId);
};
