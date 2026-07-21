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

async function collectStaticModuleClosure(entryPath) {
  const visited = new Set();
  const externalSpecifiers = new Set();
  const visit = async (sourcePath) => {
    const normalizedPath = path.resolve(sourcePath);
    if (visited.has(normalizedPath)) return;
    visited.add(normalizedPath);
    const sourceText = await readFile(normalizedPath, 'utf8');
    for (const specifier of staticModuleSpecifiers(normalizedPath, sourceText)) {
      if (!specifier.startsWith('.')) {
        externalSpecifiers.add(specifier);
        continue;
      }
      await visit(path.resolve(path.dirname(normalizedPath), specifier));
    }
  };
  await visit(entryPath);
  return { modules: visited, externalSpecifiers };
}

async function assertLightweightForegroundCommandArtifact(installedPackageRoot) {
  const sessionsEntry = path.join(installedPackageRoot, 'dist/entries/sessions.js');
  const metadataModule = path.join(
    installedPackageRoot,
    'dist/sessions/TerminalForegroundCommandMetadata.js',
  );
  const agentCliMetadataModule = path.join(
    installedPackageRoot,
    'dist/sessions/TerminalAgentCliMetadata.js',
  );
  const parserModule = path.join(installedPackageRoot, 'dist/shell/TerminalShellIntegrationParser.js');
  const loggerModule = path.join(installedPackageRoot, 'dist/utils/logger.js');
  const coordinatorModule = path.join(
    installedPackageRoot,
    'dist/sessions/TerminalSessionsCoordinator.js',
  );
  const { modules: sessionsClosure, externalSpecifiers } = await collectStaticModuleClosure(sessionsEntry);
  if (!sessionsClosure.has(metadataModule)) {
    throw new Error('sessions artifact does not include the lightweight foreground command metadata module');
  }
  if (!sessionsClosure.has(agentCliMetadataModule)) {
    throw new Error('sessions artifact does not include the lightweight agent CLI metadata module');
  }
  const metadataSource = await readFile(metadataModule, 'utf8');
  if (staticModuleSpecifiers(metadataModule, metadataSource).length > 0) {
    throw new Error('foreground command metadata artifact must not have static dependencies');
  }
  const agentCliMetadataSource = await readFile(agentCliMetadataModule, 'utf8');
  const agentCliSpecifiers = staticModuleSpecifiers(agentCliMetadataModule, agentCliMetadataSource);
  if (
    agentCliSpecifiers.length !== 1
    || agentCliSpecifiers[0] !== './TerminalForegroundCommandMetadata.js'
  ) {
    throw new Error('agent CLI metadata artifact must only depend on foreground command metadata');
  }
  if (sessionsClosure.has(parserModule)) {
    throw new Error('sessions artifact unexpectedly depends on the shell integration parser');
  }
  const allowedSessionsModules = new Set([
    sessionsEntry,
    coordinatorModule,
    metadataModule,
    agentCliMetadataModule,
    loggerModule,
  ]);
  const unexpectedSessionsModules = [...sessionsClosure].filter(modulePath => (
    !allowedSessionsModules.has(modulePath)
  ));
  if (unexpectedSessionsModules.length > 0) {
    throw new Error(`sessions artifact has unexpected static modules: ${unexpectedSessionsModules.join(', ')}`);
  }
  if (externalSpecifiers.size > 0) {
    throw new Error(`sessions artifact has external static dependencies: ${[...externalSpecifiers].join(', ')}`);
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
    && statement.moduleSpecifier.text === './sessions/TerminalForegroundCommandMetadata.js'
    && statement.exportClause
    && ts.isNamedExports(statement.exportClause)
    && statement.exportClause.elements.some((element) => (
      element.name.text === 'normalizeTerminalForegroundCommandDisplayName'
    ))
  ));
  if (!sanitizerExport) {
    throw new Error('root sanitizer export is not sourced from the lightweight metadata module');
  }
  const classifierExport = indexFile.statements.find((statement) => (
    ts.isExportDeclaration(statement)
    && statement.moduleSpecifier
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === './sessions/TerminalAgentCliMetadata.js'
    && statement.exportClause
    && ts.isNamedExports(statement.exportClause)
    && statement.exportClause.elements.some((element) => (
      element.name.text === 'classifyTerminalAgentCli'
    ))
  ));
  if (!classifierExport) {
    throw new Error('root agent CLI classifier export is not sourced from the lightweight metadata module');
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
      "if (api.classifyTerminalAgentCli('CODEX.exe') !== 'codex') throw new Error('agent CLI classifier export is unavailable')",
      "if (typeof sessions.TerminalSessionsCoordinator !== 'function') throw new Error('sessions export is unavailable')",
      "if (sessions.normalizeTerminalForegroundCommandDisplayName('top') !== 'top') throw new Error('sessions foreground command sanitizer export is unavailable')",
      "if (sessions.classifyTerminalAgentCli('claude') !== 'claude') throw new Error('sessions agent CLI classifier export is unavailable')",
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
  classifyTerminalAgentCli,
  normalizeTerminalForegroundCommandDisplayName,
  type TerminalInitializationPriority,
} from '@floegence/floeterm-terminal-web';
import {
  TerminalSessionsCoordinator,
  classifyTerminalAgentCli as classifySessionAgentCli,
  normalizeTerminalForegroundCommandDisplayName as normalizeSessionForegroundCommandDisplayName,
  type TerminalAgentCliIdentity,
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
const agentCli: TerminalAgentCliIdentity | null = classifyTerminalAgentCli('opencode');
const sessionAgentCli: TerminalAgentCliIdentity | null = classifySessionAgentCli('kimi');
const prepared: PreparedPagedTerminalHistory | undefined = undefined;
const outcome: PagedTerminalPreparedHistoryOutcome | undefined = undefined;
const transport = undefined as unknown as TerminalTransport;
const session = undefined as unknown as TerminalSessionInfo;
const coordinator = new TerminalSessionsCoordinator({ transport, pollMs: 0 });
void [TerminalCore, classifyTerminalAgentCli, normalizeTerminalForegroundCommandDisplayName, classifySessionAgentCli, normalizeSessionForegroundCommandDisplayName, preparePagedTerminalHistory, preloadTerminalResources, priority, agentCli, sessionAgentCli, prepared, outcome, session, coordinator];
`);

  await run(process.execPath, [
    path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    path.join(consumerRoot, 'tsconfig.json'),
  ], temporaryRoot);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
