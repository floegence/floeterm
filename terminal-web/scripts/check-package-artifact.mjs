import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCliPath = process.env.npm_execpath;
const EXPECTED_PACKAGE_VERSION = '0.9.0';
const EXPECTED_GHOSTTY_WEB_VERSION = '0.4.0-next.14.g6a1a50d';
const EXPECTED_TERMINAL_THEME_IDS = [
  'dark', 'light', 'solarizedDark', 'monokai', 'tokyoNight',
  'polarVeil', 'copperCircuit', 'violetDusk', 'cedarGrove', 'midnightInk',
  'velvetOrchid', 'blueQuarry', 'studioPaper', 'softLinen', 'mintGlass',
  'roseDawn', 'openSky', 'highContrastDark', 'highContrastLight', 'signalSafeDark',
];
const LEGACY_THEME_PROVENANCE = {
  dark: { classification: 'legacy_existing', source: 'floeterm', sourceCommit: 'ee13df3', spdx: 'MIT' },
  light: { classification: 'legacy_existing', source: 'floeterm', sourceCommit: 'ee13df3', spdx: 'MIT' },
  solarizedDark: {
    classification: 'legacy_external',
    source: 'https://github.com/altercation/solarized/blob/62f656a02f93c5190a8753159e34b385588d5ff3/iterm2-colors-solarized/Solarized%20Dark.itermcolors',
    sourceCommit: '62f656a02f93c5190a8753159e34b385588d5ff3',
    floetermSourceCommit: 'ee13df3',
    spdx: 'MIT',
    packageLicenseArtifact: 'third_party_licenses/solarized-MIT.txt',
  },
  monokai: {
    classification: 'legacy_unresolved',
    source: 'floeterm',
    sourceCommit: 'ee13df3',
    spdx: 'NOASSERTION',
    floetermSourceLicense: 'MIT',
  },
  tokyoNight: {
    classification: 'legacy_external',
    source: 'https://github.com/folke/tokyonight.nvim/blob/cdc07ac78467a233fd62c493de29a17e0cf2b2b6/lua/tokyonight/colors/night.lua',
    sourceCommit: 'cdc07ac78467a233fd62c493de29a17e0cf2b2b6',
    floetermSourceCommit: 'ee13df3',
    spdx: 'Apache-2.0',
    packageLicenseArtifact: 'third_party_licenses/tokyonight-Apache-2.0.txt',
  },
};
const LICENSE_ARTIFACT_SHA256 = {
  'third_party_licenses/solarized-MIT.txt': '87623a10d8677d19b0894c61f5defd80281495a2740cb8c289891261fddda30f',
  'third_party_licenses/tokyonight-Apache-2.0.txt': 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
};
const THEME_ARTIFACT_SHA256 = {
  'THEME_PROVENANCE.json': '2b6b2d07297ace181564890b79e2c488e67f4747512b8adad08b4bd3ea8dfc06',
  'THEME_QUALITY_EVIDENCE.json': 'e9fdd068550001f555f1bb52ca475b68bc56a12c00da25f9ec28fe03dbdb9005',
  'THIRD_PARTY_THEME_NOTICES.md': '8e4e3c5e72cd42271cacc3cb33e9ead2283778ffdcdfbbae042927aa98689d36',
};
const THEME_QUALITY_THRESHOLDS = {
  foregroundContrast: 4.5,
  highContrastForeground: 7,
  selectionContrast: 4.5,
  cursorContrast: 3,
  cursorAccentContrast: 4.5,
  originalChromaticAnsiContrast: 4.5,
  originalBrightBlackContrast: 3,
  catalogNearestNeighborDeltaE00: 5,
  signalSafeSemanticPairDeltaE00: 10,
  signalSafeNormalBrightDeltaE00: 5,
};

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

async function assertThemeProvenanceArtifact(installedPackageRoot) {
  const provenancePath = path.join(installedPackageRoot, 'THEME_PROVENANCE.json');
  const qualityEvidencePath = path.join(installedPackageRoot, 'THEME_QUALITY_EVIDENCE.json');
  const noticesPath = path.join(installedPackageRoot, 'THIRD_PARTY_THEME_NOTICES.md');
  for (const [artifact, expectedSha256] of Object.entries(THEME_ARTIFACT_SHA256)) {
    const artifactBytes = await readFile(path.join(installedPackageRoot, artifact));
    const actualSha256 = createHash('sha256').update(artifactBytes).digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error(`theme artifact content mismatch: ${artifact}`);
    }
  }
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  if (provenance.schemaVersion !== 1) {
    throw new Error('theme provenance schemaVersion must be 1');
  }
  if (provenance.packageArtifactOwner !== '@floegence/floeterm-terminal-web npm tarball') {
    throw new Error('theme provenance package owner is missing');
  }
  if (!/^[0-9a-f]{7,40}$/u.test(provenance.floetermLegacySourceCommit)) {
    throw new Error('theme provenance legacy source commit is invalid');
  }
  const nameDecision = provenance.originalThemeNameDecision;
  if (
    typeof nameDecision !== 'object'
    || nameDecision === null
    || typeof nameDecision.reference !== 'string'
    || !nameDecision.reference.startsWith('https://github.com/mbadolato/iTerm2-Color-Schemes/tree/')
    || !/^[0-9a-f]{40}$/u.test(nameDecision.referenceCommit)
    || nameDecision.referenceThemeCount !== 592
    || !Array.isArray(nameDecision.exactNameConflicts)
    || nameDecision.exactNameConflicts.length !== 0
    || typeof nameDecision.decision !== 'string'
    || nameDecision.decision.length === 0
  ) {
    throw new Error('original theme name decision evidence is incomplete');
  }
  if (!Array.isArray(provenance.themes) || provenance.themes.length !== 20) {
    throw new Error('theme provenance must contain exactly 20 records');
  }
  const api = await import(pathToFileURL(path.join(installedPackageRoot, 'dist/index.js')).href);
  const catalogIds = api.TERMINAL_THEME_NAMES;
  const provenanceIds = provenance.themes.map((theme) => theme.id);
  if (new Set(catalogIds).size !== catalogIds.length || new Set(provenanceIds).size !== provenanceIds.length) {
    throw new Error('theme catalog/provenance IDs must be unique');
  }
  if (catalogIds.length !== provenanceIds.length || catalogIds.some((id, index) => id !== provenanceIds[index])) {
    throw new Error('theme catalog and provenance IDs must match in stable order');
  }
  if (
    catalogIds.length !== EXPECTED_TERMINAL_THEME_IDS.length
    || catalogIds.some((id, index) => id !== EXPECTED_TERMINAL_THEME_IDS[index])
  ) {
    throw new Error('terminal theme catalog IDs or order differ from the 0.8.0 contract');
  }
  const allowedClassifications = new Set([
    'legacy_existing',
    'legacy_external',
    'legacy_unresolved',
    'floeterm_original',
  ]);
  const requiredFieldsByClassification = {
    legacy_existing: ['sourceCommit', 'decision'],
    legacy_external: ['sourceCommit', 'floetermSourceCommit', 'modification', 'packageLicenseArtifact'],
    legacy_unresolved: ['sourceCommit', 'floetermSourceLicense', 'risk', 'productDecision', 'modification'],
    floeterm_original: ['externalColorTableCopied'],
  };
  const allowedSpdxValues = new Set(['MIT', 'Apache-2.0', 'NOASSERTION']);
  const allRecordFields = ['id', 'classification', 'source', 'spdx', 'copyright'];
  for (const record of provenance.themes) {
    if (!allowedClassifications.has(record.classification)) {
      throw new Error(`theme provenance classification is invalid: ${record.id}.${record.classification}`);
    }
    for (const field of [...allRecordFields, ...requiredFieldsByClassification[record.classification]]) {
      if (!(field in record) || record[field] === '') {
        throw new Error(`theme provenance field missing: ${record.id}.${field}`);
      }
    }
    if (!allowedSpdxValues.has(record.spdx)) {
      throw new Error(`theme provenance SPDX value is invalid: ${record.id}.${record.spdx}`);
    }
    const legacyContract = LEGACY_THEME_PROVENANCE[record.id];
    if (legacyContract) {
      for (const [field, expected] of Object.entries(legacyContract)) {
        if (record[field] !== expected) {
          throw new Error(`legacy theme provenance contract mismatch: ${record.id}.${field}`);
        }
      }
    } else if (record.classification !== 'floeterm_original') {
      throw new Error(`new theme must remain classified as Floeterm original: ${record.id}`);
    }
    if (record.classification === 'floeterm_original' && record.externalColorTableCopied !== false) {
      throw new Error(`original theme must not copy an external color table: ${record.id}`);
    }
    if (
      record.classification === 'legacy_external'
      && record.floetermSourceCommit !== provenance.floetermLegacySourceCommit
    ) {
      throw new Error(`external theme Floeterm source commit is invalid: ${record.id}`);
    }
    if (
      record.classification.startsWith('legacy_')
      && record.sourceCommit !== provenance.floetermLegacySourceCommit
      && record.classification !== 'legacy_external'
    ) {
      throw new Error(`legacy theme source commit is invalid: ${record.id}`);
    }
    if (
      record.id === 'signalSafeDark'
      && (
        record.certification?.doi !== '10.1109/TVCG.2009.113'
        || record.certification?.testEvidenceArtifact !== 'THEME_QUALITY_EVIDENCE.json'
        || record.certification?.repositoryTestEvidence !== 'terminal-web/src/utils/themeQuality.test.ts'
      )
    ) {
      throw new Error('Signal Safe certification evidence is incomplete');
    }
    if (record.packageLicenseArtifact) {
      if (path.isAbsolute(record.packageLicenseArtifact)) {
        throw new Error(`theme license artifact path must be relative: ${record.id}`);
      }
      const licensePath = path.resolve(installedPackageRoot, record.packageLicenseArtifact);
      const relativeLicensePath = path.relative(installedPackageRoot, licensePath);
      if (relativeLicensePath.startsWith('..') || path.isAbsolute(relativeLicensePath)) {
        throw new Error(`theme license artifact escapes package root: ${record.id}`);
      }
      const licenseBytes = await readFile(licensePath);
      const actualSha256 = createHash('sha256').update(licenseBytes).digest('hex');
      if (actualSha256 !== LICENSE_ARTIFACT_SHA256[record.packageLicenseArtifact]) {
        throw new Error(`theme license artifact content mismatch: ${record.id}`);
      }
    }
  }
  const qualityEvidence = JSON.parse(await readFile(qualityEvidencePath, 'utf8'));
  const catalogSha256 = createHash('sha256')
    .update(JSON.stringify(api.TERMINAL_THEME_DEFINITIONS))
    .digest('hex');
  if (
    qualityEvidence.schemaVersion !== 1
    || qualityEvidence.catalogVersion !== '0.8.0'
    || qualityEvidence.catalogSha256 !== catalogSha256
    || qualityEvidence.methodology?.colorVisionSimulation?.doi !== '10.1109/TVCG.2009.113'
    || qualityEvidence.methodology?.colorVisionSimulation?.pipeline !== 'sRGB decode to linear RGB -> severity 1.0 matrix -> D65 CIELAB -> CIEDE2000'
    || qualityEvidence.results?.themeCount !== 20
    || qualityEvidence.results?.allThemesPassed !== true
    || typeof qualityEvidence.results?.minimumCatalogNearestNeighborDeltaE00 !== 'number'
    || qualityEvidence.results.minimumCatalogNearestNeighborDeltaE00 < 5
  ) {
    throw new Error('theme quality evidence contract is incomplete');
  }
  for (const [threshold, expected] of Object.entries(THEME_QUALITY_THRESHOLDS)) {
    if (qualityEvidence.thresholds?.[threshold] !== expected) {
      throw new Error(`theme quality evidence threshold mismatch: ${threshold}`);
    }
  }
  const signalSafeResult = qualityEvidence.results.signalSafeDark;
  for (const [field, threshold] of [
    ['foregroundContrast', 4.5],
    ['selectionContrast', 4.5],
    ['cursorContrast', 3],
    ['cursorAccentContrast', 4.5],
  ]) {
    if (typeof signalSafeResult?.[field] !== 'number' || signalSafeResult[field] < threshold) {
      throw new Error(`Signal Safe quality evidence failed for ${field}`);
    }
  }
  const simulations = qualityEvidence.results?.signalSafeDark?.simulations;
  for (const simulation of ['protanopia', 'deuteranopia', 'tritanopia']) {
    const result = simulations?.[simulation];
    if (
      typeof result?.redGreenDeltaE00 !== 'number'
      || result.redGreenDeltaE00 < 10
      || typeof result?.blueMagentaDeltaE00 !== 'number'
      || result.blueMagentaDeltaE00 < 10
      || !Array.isArray(result?.normalBrightDeltaE00)
      || result.normalBrightDeltaE00.length !== 8
      || result.normalBrightDeltaE00.some((value) => value < 5)
    ) {
      throw new Error(`Signal Safe quality evidence failed for ${simulation}`);
    }
  }
  const notices = await readFile(noticesPath, 'utf8');
  for (const requiredNoticeText of [
    '## Solarized Dark',
    'altercation/solarized',
    '## Tokyo Night',
    'folke/tokyonight.nvim',
    '## Monokai legacy risk',
    'could not be reconstructed',
    'does not claim an official Monokai release',
  ]) {
    if (!notices.includes(requiredNoticeText)) {
      throw new Error(`third-party theme notices missing required content: ${requiredNoticeText}`);
    }
  }
  if (notices.length < 500) {
    throw new Error('third-party theme notices are unexpectedly empty');
  }
}

async function assertGhosttyScrollbackCompatibilityArtifact(installedPackageRoot, installRoot) {
  const installedManifest = JSON.parse(await readFile(
    path.join(installedPackageRoot, 'package.json'),
    'utf8',
  ));
  if (installedManifest.version !== EXPECTED_PACKAGE_VERSION) {
    throw new Error(`installed terminal-web package version must be ${EXPECTED_PACKAGE_VERSION}`);
  }
  if (installedManifest.dependencies?.['ghostty-web'] !== EXPECTED_GHOSTTY_WEB_VERSION) {
    throw new Error(
      `installed terminal-web package must pin ghostty-web exactly to ${EXPECTED_GHOSTTY_WEB_VERSION}`,
    );
  }

  const installedGhosttyManifest = JSON.parse(await readFile(
    path.join(installRoot, 'node_modules', 'ghostty-web', 'package.json'),
    'utf8',
  ));
  if (installedGhosttyManifest.version !== EXPECTED_GHOSTTY_WEB_VERSION) {
    throw new Error(
      `installed ghostty-web version must be exactly ${EXPECTED_GHOSTTY_WEB_VERSION}; `
      + 'consumer overrides are unsupported while the version-bound scrollback adapter is active',
    );
  }

  const compatibilityModule = await import(pathToFileURL(path.join(
    installedPackageRoot,
    'dist/internal/GhosttyScrollbackCompat.js',
  )).href);
  if (
    compatibilityModule.EXPECTED_GHOSTTY_WEB_SCROLLBACK_BUG_VERSION
      !== EXPECTED_GHOSTTY_WEB_VERSION
    || compatibilityModule.GHOSTTY_SCROLLBACK_BYTES_PER_ROW !== 8_192
    || compatibilityModule.MAX_GHOSTTY_SCROLLBACK_BYTES !== 81_920_000
    || compatibilityModule.MAX_SUPPORTED_TERMINAL_COLUMNS !== 500
  ) {
    throw new Error('installed Ghostty scrollback compatibility constants are invalid');
  }
  if (
    compatibilityModule.mapGhosttyScrollbackRowsForPinnedVersion(1) !== 8_192
    || compatibilityModule.mapGhosttyScrollbackRowsForPinnedVersion(10_000) !== 81_920_000
  ) {
    throw new Error('installed Ghostty scrollback compatibility mapping is invalid');
  }
  for (const invalid of [0, -1, 1.5, 10_001, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
    let rejected = false;
    try {
      compatibilityModule.validateTerminalScrollbackRows(invalid);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`installed scrollback validator accepted invalid value: ${String(invalid)}`);
    }
  }
  if (
    compatibilityModule.validateTerminalColumns(500) !== 500
    || compatibilityModule.capAutoFitTerminalColumns(501) !== 500
  ) {
    throw new Error('installed terminal column compatibility boundary is invalid');
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
  await assertThemeProvenanceArtifact(
    path.join(temporaryRoot, 'node_modules', '@floegence', 'floeterm-terminal-web'),
  );
  await assertGhosttyScrollbackCompatibilityArtifact(
    path.join(temporaryRoot, 'node_modules', '@floegence', 'floeterm-terminal-web'),
    temporaryRoot,
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
      "if (api.TERMINAL_THEME_NAMES.length !== 20) throw new Error('terminal theme catalog size is unavailable')",
      "if (api.TERMINAL_THEME_DEFINITIONS.length !== 20) throw new Error('terminal theme definitions export is unavailable')",
      "if (!Object.isFrozen(api.TERMINAL_THEME_NAMES) || !Object.isFrozen(api.TERMINAL_THEME_DEFINITIONS)) throw new Error('terminal theme catalog must be frozen')",
      "const studioPaper = api.getTerminalThemeDefinition('studioPaper')",
      "if (studioPaper.id !== 'studioPaper' || studioPaper.label !== 'Studio Paper' || studioPaper.appearance !== 'light') throw new Error('terminal theme definition fields are unavailable')",
      "if (studioPaper.colors.background !== '#f7f8fa' || studioPaper.colors.foreground !== '#222831' || studioPaper.colors.cursorAccent !== '#f7f8fa') throw new Error('terminal theme definition colors are unavailable')",
      "if (!Object.isFrozen(studioPaper) || !Object.isFrozen(studioPaper.colors)) throw new Error('terminal theme definitions must be frozen')",
      "const mutableColors = api.getThemeColors('studioPaper')",
      "mutableColors.background = '#000000'",
      "if (api.getTerminalThemeDefinition('studioPaper').colors.background !== '#f7f8fa') throw new Error('terminal theme color copies must be defensive')",
      "if (!api.isTerminalThemeName('signalSafeDark')) throw new Error('terminal theme validator export is unavailable')",
      "if (api.getThemeColors('polarVeil').background !== '#10201f') throw new Error('terminal theme colors export is unavailable')",
      "if (api.normalizeTerminalThemeName('unknown') !== 'dark') throw new Error('terminal theme fallback export is unavailable')",
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
  TERMINAL_THEME_DEFINITIONS,
  TERMINAL_THEME_NAMES,
  getTerminalThemeDefinition,
  getThemeColors,
  isTerminalThemeName,
  normalizeTerminalThemeName,
  classifyTerminalAgentCli,
  normalizeTerminalForegroundCommandDisplayName,
  type TerminalThemeAppearance,
  type TerminalThemeColors,
  type TerminalThemeDefinition,
  type TerminalThemeName,
  type TerminalInitializationPriority,
  type TerminalResourceEstimate,
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
const themeName: TerminalThemeName = 'studioPaper';
const appearance: TerminalThemeAppearance = 'light';
const colors: TerminalThemeColors = getThemeColors(themeName);
const definition: TerminalThemeDefinition = getTerminalThemeDefinition(themeName);
const resourceEstimate: TerminalResourceEstimate = {
  bufferBytes: 0,
  cellCount: 0,
  wasmMemoryBytes: 65_536,
  estimatedBytes: 65_536,
  rendererType: 'canvas',
};
// @ts-expect-error wasmMemoryBytes is required in the published contract
const incompleteResourceEstimate: TerminalResourceEstimate = {
  bufferBytes: 0,
  cellCount: 0,
  estimatedBytes: 0,
  rendererType: 'canvas',
};
void [TerminalCore, classifyTerminalAgentCli, normalizeTerminalForegroundCommandDisplayName, classifySessionAgentCli, normalizeSessionForegroundCommandDisplayName, preparePagedTerminalHistory, preloadTerminalResources, priority, agentCli, sessionAgentCli, prepared, outcome, session, coordinator, themeName, appearance, colors, definition, resourceEstimate, incompleteResourceEstimate];
if (TERMINAL_THEME_NAMES.length !== 20) throw new Error('terminal theme type export is unavailable');
if (TERMINAL_THEME_DEFINITIONS.length !== 20) throw new Error('terminal theme definitions type export is unavailable');
if (!isTerminalThemeName('polarVeil')) throw new Error('terminal theme type validator is unavailable');
if (normalizeTerminalThemeName('unknown') !== 'dark') throw new Error('terminal theme normalize type export is unavailable');
void getThemeColors('signalSafeDark');
`);

  await run(process.execPath, [
    path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    path.join(consumerRoot, 'tsconfig.json'),
  ], temporaryRoot);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
