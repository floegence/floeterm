export const containsInteractivePromptMarker = chunks => {
  const bytes = chunks.map(chunk => atob(chunk.data ?? '')).join('');
  return /\x1b\](?:633|133);A(?:\x07|\x1b\\)/.test(bytes);
};

const promptMarkerBinding = '__floetermContainsInteractivePromptMarker';
const promptMarkerBoundPages = new WeakSet();

export const waitForInteractiveShell = async (page, sessionId) => {
  if (!promptMarkerBoundPages.has(page)) {
    await page.exposeFunction(promptMarkerBinding, containsInteractivePromptMarker);
    promptMarkerBoundPages.add(page);
  }
  await page.waitForFunction(async expectedSessionId => {
    const response = await fetch('/api/sessions');
    if (!response.ok) return false;
    const sessions = await response.json();
    const session = sessions.find(item => item.id === expectedSessionId);
    if (session?.isActive !== true || session.foregroundCommand?.phase !== 'idle') return false;

    let startSequence = 1;
    let historyGeneration = 0;
    let snapshotEndSequence = -1;
    let acceptedReset = false;
    const chunks = [];
    for (;;) {
      const query = new URLSearchParams({
        startSeq: String(startSequence),
        endSeq: String(snapshotEndSequence),
        historyGeneration: String(historyGeneration),
        maxBytes: String(512 * 1024),
      });
      const historyResponse = await fetch(
        `/api/sessions/${encodeURIComponent(expectedSessionId)}/history?${query.toString()}`,
      );
      if (!historyResponse.ok) return false;
      const historyPage = await historyResponse.json();
      if (
        !Number.isSafeInteger(historyPage.historyGeneration)
        || historyPage.historyGeneration < 1
        || !Number.isSafeInteger(historyPage.snapshotEndSequence)
        || historyPage.snapshotEndSequence < 0
      ) {
        throw new Error('interactive shell history metadata is invalid');
      }
      if (historyPage.historyReset) {
        if (
          acceptedReset
          || !Number.isSafeInteger(historyPage.firstRetainedSequence)
          || historyPage.firstRetainedSequence < 0
        ) {
          throw new Error('interactive shell history reset did not converge');
        }
        acceptedReset = true;
        historyGeneration = historyPage.historyGeneration;
        snapshotEndSequence = historyPage.snapshotEndSequence;
        startSequence = historyPage.firstRetainedSequence || 1;
        chunks.length = 0;
        continue;
      }
      if (historyGeneration === 0) {
        historyGeneration = historyPage.historyGeneration;
        snapshotEndSequence = historyPage.snapshotEndSequence;
      } else if (
        historyPage.historyGeneration !== historyGeneration
        || historyPage.snapshotEndSequence !== snapshotEndSequence
      ) {
        throw new Error('interactive shell history snapshot changed during readiness');
      }
      chunks.push(...historyPage.chunks);
      if (await globalThis.__floetermContainsInteractivePromptMarker(chunks)) return true;
      if (!historyPage.hasMore) break;
      if (
        !Number.isSafeInteger(historyPage.nextStartSequence)
        || historyPage.nextStartSequence <= startSequence
        || historyPage.nextStartSequence > snapshotEndSequence + 1
      ) {
        throw new Error('interactive shell history cursor did not advance');
      }
      startSequence = historyPage.nextStartSequence;
    }
    return false;
  }, sessionId);
};
