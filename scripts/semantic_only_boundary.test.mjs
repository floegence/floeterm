import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = relativePath => readFile(path.join(root, relativePath), 'utf8');
const exists = async relativePath => {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

test('terminal-web publishes only the semantic terminal surface', async () => {
  const manifest = JSON.parse(await read('terminal-web/package.json'));
  assert.equal(manifest.version, '0.15.5');
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './live', './semantic', './sessions']);

  const forbiddenPaths = [
    'terminal-web/src/checkpoint',
    'terminal-web/src/fabric',
    'terminal-web/src/manager',
    'terminal-web/src/core/TerminalCore.ts',
    'terminal-web/src/core/PagedTerminalOutputCoordinator.ts',
    'terminal-web/src/core/TerminalOutputPipeline.ts',
    'terminal-web/src/core/TerminalRenderScheduler.ts',
    'terminal-web/src/internal/BeamtermResourceLoader.ts',
    'terminal-web/src/internal/TerminalResourceLoader.ts',
    'terminal-web/src/raw-imports.d.ts',
    'terminal-web/src/utils/history.ts',
    'terminal-web/src/utils/xtermAutoResponseFilter.ts',
    'terminal-web/src/utils/errors.ts',
  ];
  for (const relativePath of forbiddenPaths) {
    assert.equal(await exists(relativePath), false, `${relativePath} must be deleted`);
  }

  const packageSources = [
    await read('terminal-web/package.json'),
    await read('terminal-web/package-lock.json'),
    await read('terminal-web/src/index.ts'),
    await read('terminal-web/src/entries/live.ts'),
    await read('terminal-web/src/entries/semantic.ts'),
  ].join('\n');
  for (const forbidden of [
    '@floegence/ghostty-web',
    '@floegence/beamterm-renderer',
    'TerminalCore',
    'GhosttyCheckpoint',
    'Beamterm',
    'createTerminalLiveTransport',
    'commitHistoryCheckpoint',
  ]) {
    assert.equal(packageSources.includes(forbidden), false, `${forbidden} remains package-reachable`);
  }
  assert.match(manifest.scripts.test, /check:semantic-only/, 'npm test must enforce the semantic-only source boundary');
  assert.equal((await read('terminal-web/scripts/runVitestBrowser.mjs')).includes('passWithNoTests'), false, 'browser gate must require a real semantic browser test');
});

test('terminal-go has no durable raw journal or browser checkpoint contract', async () => {
  for (const relativePath of [
    'terminal-go/history_spool.go',
    'terminal-go/history_spool_test.go',
    'terminal-go/history_spool_session_test.go',
    'terminal-go/history_checkpoint_contract_test.go',
    'terminal-go/ringbuffer.go',
    'terminal-go/ringbuffer_test.go',
    'terminal-go/history_filter.go',
    'terminal-go/history_filter_test.go',
  ]) {
    assert.equal(await exists(relativePath), false, `${relativePath} must be deleted`);
  }

  const publicSources = [
    await read('terminal-go/config.go'),
    await read('terminal-go/types.go'),
    await read('terminal-go/manager.go'),
    await read('app/backend/internal/server/api.go'),
  ].join('\n');
  for (const forbidden of [
    'HistorySpool',
    'TerminalHistoryCheckpoint',
    'CommitHistoryCheckpoint',
    'CommitSessionHistoryCheckpoint',
    'case "checkpoint"',
    'TerminalDataChunk',
    'HistoryPageOptions',
    'GetHistoryPage',
    'GetHistoryChunks',
    'TerminalRingBuffer',
    'HistoryBufferSize',
    'HistoryBoundarySequence',
    'HistoryGeneration',
    'HistoryStartSequence',
    'OutputSequenceBoundary',
    'OnTerminalData',
    'OnOutput',
    'case "stats"',
    'case "clear"',
  ]) {
    assert.equal(publicSources.includes(forbidden), false, `${forbidden} remains publicly reachable`);
  }
});

test('the repository describes native semantic ownership as current', async () => {
  const sources = [
    await read('README.md'),
    await read('THIRD_PARTY_NOTICES.md'),
    await read('.github/workflows/release.yml'),
  ].join('\n');
  for (const forbidden of [
    '@floegence/ghostty-web',
    '@floegence/beamterm-renderer',
    'TerminalCore',
    'GhosttyCheckpoint',
    'publishes the renderer first',
  ]) {
    assert.equal(sources.includes(forbidden), false, `${forbidden} remains an active repository contract`);
  }
});
