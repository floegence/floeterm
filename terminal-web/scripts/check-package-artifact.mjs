import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error('Package artifact checks must run through npm so npm_execpath is available');
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'floeterm-terminal-web-package-'));

async function run(command, args, cwd) {
  await execFileAsync(command, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
}

async function runNpm(args, cwd) {
  await run(process.execPath, [npmCliPath, ...args], cwd);
}

function staticModuleSpecifiers(sourcePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

async function collectRelativeStaticModuleClosure(entryPath) {
  const visited = new Set();
  const visit = async (sourcePath) => {
    const normalizedPath = path.resolve(sourcePath);
    if (visited.has(normalizedPath)) return;
    visited.add(normalizedPath);
    const sourceText = await readFile(normalizedPath, 'utf8');
    for (const specifier of staticModuleSpecifiers(normalizedPath, sourceText)) {
      if (!specifier.startsWith('.')) continue;
      await visit(path.resolve(path.dirname(normalizedPath), specifier));
    }
  };
  await visit(entryPath);
  return visited;
}

async function assertLightweightForegroundCommandArtifact(installedPackageRoot) {
  const sessionsEntry = path.join(installedPackageRoot, 'dist/entries/sessions.js');
  const parserModule = path.join(installedPackageRoot, 'dist/shell/TerminalShellIntegrationParser.js');
  const sessionsClosure = await collectRelativeStaticModuleClosure(sessionsEntry);
  if (sessionsClosure.has(parserModule)) {
    throw new Error('sessions artifact unexpectedly depends on the shell integration parser');
  }

  const indexPath = path.join(installedPackageRoot, 'dist/index.js');
  const indexSource = await readFile(indexPath, 'utf8');
  const indexFile = ts.createSourceFile(
    indexPath,
    indexSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const sanitizerExport = indexFile.statements.find((statement) => (
    ts.isExportDeclaration(statement)
    && statement.moduleSpecifier
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === './shell/TerminalForegroundCommand.js'
    && statement.exportClause
    && ts.isNamedExports(statement.exportClause)
    && statement.exportClause.elements.some((element) => (
      element.name.text === 'normalizeTerminalForegroundCommandDisplayName'
    ))
  ));
  if (!sanitizerExport) {
    throw new Error('root sanitizer export is not sourced from the lightweight metadata module');
  }
}

try {
  const { stdout } = await execFileAsync(process.execPath, [npmCliPath,
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporaryRoot,
  ], { cwd: packageRoot });
  const [{ filename }] = JSON.parse(stdout);
  const tarballPath = path.join(temporaryRoot, filename);
  const consumerRoot = path.join(temporaryRoot, 'consumer');

  await runNpm(['init', '--yes'], temporaryRoot);
  await runNpm([
    'install',
    '--ignore-scripts',
    '--package-lock=false',
    '--prefer-offline',
    tarballPath,
  ], temporaryRoot);

  await assertLightweightForegroundCommandArtifact(
    path.join(temporaryRoot, 'node_modules', '@floegence', 'floeterm-terminal-web'),
  );

  await writeFile(path.join(temporaryRoot, 'package.json'), `${JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2)}\n`);
  await run(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      "const api = await import('@floegence/floeterm-terminal-web')",
      "const sessions = await import('@floegence/floeterm-terminal-web/sessions')",
      "const history = await import('@floegence/floeterm-terminal-web/history')",
      "const preload = await import('@floegence/floeterm-terminal-web/preload')",
      "if (typeof api.TerminalCore !== 'function') throw new Error('TerminalCore export is unavailable')",
      "if (api.normalizeTerminalForegroundCommandDisplayName('top') !== 'top') throw new Error('foreground command sanitizer export is unavailable')",
      "if (typeof sessions.TerminalSessionsCoordinator !== 'function') throw new Error('sessions export is unavailable')",
      "if (typeof history.preparePagedTerminalHistory !== 'function') throw new Error('history export is unavailable')",
      "if (typeof preload.preloadTerminalResources !== 'function') throw new Error('preload export is unavailable')",
    ].join('; '),
  ], temporaryRoot);

  await run(process.execPath, ['-e', "require('fs').mkdirSync(process.argv[1])", consumerRoot], temporaryRoot);
  await writeFile(path.join(consumerRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2020',
    },
    include: ['index.mts'],
  }, null, 2)}\n`);
  await writeFile(path.join(consumerRoot, 'index.mts'), `
import {
  TerminalCore,
  normalizeTerminalForegroundCommandDisplayName,
  type TerminalInitializationPriority,
} from '@floegence/floeterm-terminal-web';
import {
  TerminalSessionsCoordinator,
  type TerminalSessionInfo,
  type TerminalTransport,
} from '@floegence/floeterm-terminal-web/sessions';
import {
  preparePagedTerminalHistory,
  type PagedTerminalPreparedHistoryOutcome,
  type PreparedPagedTerminalHistory,
} from '@floegence/floeterm-terminal-web/history';
import { preloadTerminalResources } from '@floegence/floeterm-terminal-web/preload';

const priority: TerminalInitializationPriority = 'interactive';
const prepared: PreparedPagedTerminalHistory | undefined = undefined;
const outcome: PagedTerminalPreparedHistoryOutcome | undefined = undefined;
const transport = undefined as unknown as TerminalTransport;
const session = undefined as unknown as TerminalSessionInfo;
const coordinator = new TerminalSessionsCoordinator({ transport, pollMs: 0 });
void [TerminalCore, normalizeTerminalForegroundCommandDisplayName, preparePagedTerminalHistory, preloadTerminalResources, priority, prepared, outcome, session, coordinator];
`);

  await run(process.execPath, [
    path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    path.join(consumerRoot, 'tsconfig.json'),
  ], temporaryRoot);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
