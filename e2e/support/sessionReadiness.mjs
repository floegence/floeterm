export const waitForInteractiveShell = async (page, sessionId) => {
  await page.waitForFunction(async expectedSessionId => {
    const response = await fetch('/api/sessions');
    if (!response.ok) return false;
    const sessions = await response.json();
    const session = sessions.find(item => item.id === expectedSessionId);
    return session?.foregroundCommand?.phase === 'idle';
  }, sessionId);
};
