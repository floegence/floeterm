import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCliPath = process.env.npm_execpath;
const expectedVersion = '0.16.3';
const expectedExports = ['.', './live', './semantic', './sessions'];
const forbiddenContent = [
  '@floegence/ghostty-web',
  '@floegence/beamterm-renderer',
  'TerminalCore',
  'GhosttyCheckpoint',
  'commitHistoryCheckpoint',
  'xtermAutoResponseFilter',
  'concatChunks',
];
const themeArtifactSha256 = {
  'THEME_PROVENANCE.json': '2b6b2d07297ace181564890b79e2c488e67f4747512b8adad08b4bd3ea8dfc06',
  'THEME_QUALITY_EVIDENCE.json': 'e9fdd068550001f555f1bb52ca475b68bc56a12c00da25f9ec28fe03dbdb9005',
  'THIRD_PARTY_THEME_NOTICES.md': '8e4e3c5e72cd42271cacc3cb33e9ead2283778ffdcdfbbae042927aa98689d36',
};

if (!npmCliPath) {
  throw new Error('package artifact checks must run through npm');
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'floeterm-terminal-web-package-'));

const runNpm = async (args, cwd) => execFileAsync(process.execPath, [npmCliPath, ...args], {
  cwd,
  env: {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  },
  maxBuffer: 32 * 1024 * 1024,
});

const collectFiles = async directory => {
  const collected = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collected.push(...await collectFiles(absolute));
    else collected.push(absolute);
  }
  return collected;
};

try {
  const sourcePackage = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(sourcePackage.version, expectedVersion);
  assert.deepEqual(sourcePackage.dependencies, {});
  assert.deepEqual(Object.keys(sourcePackage.exports).sort(), expectedExports);

  await runNpm(['run', 'build'], packageRoot);
  const { stdout: packStdout } = await runNpm(['pack', '--json', '--pack-destination', temporaryRoot], packageRoot);
  const packResult = JSON.parse(packStdout);
  assert.equal(packResult.length, 1, 'npm pack must produce exactly one artifact');
  const packedFiles = packResult[0].files.map(file => file.path);
  assert.equal(packedFiles.some(file => file.endsWith('.wasm')), false, 'package must not contain WASM');
  assert.equal(packedFiles.some(file => file.toLowerCase().includes('beamterm')), false, 'package must not contain Beamterm');

  const tarball = path.join(temporaryRoot, packResult[0].filename);
  const installRoot = path.join(temporaryRoot, 'consumer');
  await writeFile(path.join(temporaryRoot, 'package.json'), '{}\n');
  await runNpm(['install', '--ignore-scripts', '--prefix', installRoot, tarball], temporaryRoot);

  const installedRoot = path.join(installRoot, 'node_modules', '@floegence', 'floeterm-terminal-web');
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installedPackage.version, expectedVersion);
  assert.deepEqual(installedPackage.dependencies, {});
  assert.deepEqual(Object.keys(installedPackage.exports).sort(), expectedExports);

  const installedFiles = await collectFiles(installedRoot);
  for (const file of installedFiles) {
    const relative = path.relative(installedRoot, file);
    assert.equal(relative.endsWith('.wasm'), false, `unexpected WASM artifact: ${relative}`);
    if (!/\.(?:js|d\.ts|json|md)$/u.test(relative)) continue;
    const content = await readFile(file, 'utf8');
    for (const forbidden of forbiddenContent) {
      assert.equal(content.includes(forbidden), false, `${relative} contains removed contract ${forbidden}`);
    }
  }

  for (const [artifact, expectedHash] of Object.entries(themeArtifactSha256)) {
    const bytes = await readFile(path.join(installedRoot, artifact));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, `${artifact} hash`);
  }

  const root = await import(pathToFileURL(path.join(installedRoot, 'dist/index.js')));
  const semantic = await import(pathToFileURL(path.join(installedRoot, 'dist/entries/semantic.js')));
  const live = await import(pathToFileURL(path.join(installedRoot, 'dist/entries/live.js')));
  const sessions = await import(pathToFileURL(path.join(installedRoot, 'dist/entries/sessions.js')));

  for (const [name, value] of Object.entries({
    RendererSurface: semantic.RendererSurface,
    HistorySearchController: semantic.HistorySearchController,
    HistoryViewportController: semantic.HistoryViewportController,
    TerminalInputBridge: semantic.TerminalInputBridge,
    validatePresentation: semantic.validatePresentation,
    createSemanticTerminalLiveTransport: live.createSemanticTerminalLiveTransport,
    TerminalSessionsCoordinator: sessions.TerminalSessionsCoordinator,
    rootRendererSurface: root.RendererSurface,
  })) {
    assert.equal(typeof value, 'function', `${name} must be a function`);
  }
  for (const removed of ['TerminalCore', 'createTerminalInstance', 'preloadTerminalResources']) {
    assert.equal(removed in root, false, `root must not export ${removed}`);
  }

  await writeFile(path.join(installRoot, 'semantic-consumer.mts'), `
import {
  HistorySearchController,
  HistoryViewportController,
  RendererSurface,
  TerminalInputBridge,
  type TerminalKeyInputIntent,
  type TerminalInputBridgeOptions,
  type SemanticPresentation,
  type SemanticTerminalCursorRect,
  type SemanticTerminalPalette,
} from '@floegence/floeterm-terminal-web/semantic';
import {
  createSemanticTerminalLiveTransport,
  type SemanticTerminalLiveTransport,
} from '@floegence/floeterm-terminal-web/live';
import { TerminalSessionsCoordinator } from '@floegence/floeterm-terminal-web/sessions';
void [HistorySearchController, HistoryViewportController, RendererSurface, TerminalInputBridge, createSemanticTerminalLiveTransport, TerminalSessionsCoordinator];
const presentation = {} as SemanticPresentation;
const cursorRect = {} as SemanticTerminalCursorRect;
const palette = {} as SemanticTerminalPalette;
const intent = {} as TerminalKeyInputIntent;
const bridgeOptions = {} as TerminalInputBridgeOptions;
const transport = {} as SemanticTerminalLiveTransport;
void bridgeOptions.onPaste;
void transport.sendPaste('session', 'paste');
void [presentation, cursorRect, palette, intent];
`);
  await writeFile(path.join(installRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
    },
    files: ['./semantic-consumer.mts'],
  }));
  const tscPath = path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  await execFileAsync(process.execPath, [tscPath, '-p', path.join(installRoot, 'tsconfig.json')], {
    cwd: installRoot,
    env: { ...process.env, NODE_PATH: path.join(installRoot, 'node_modules') },
  });

  console.log(`verified semantic-only package ${sourcePackage.name}@${expectedVersion}`);
  console.log(`tarball sha512 ${packResult[0].integrity}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
