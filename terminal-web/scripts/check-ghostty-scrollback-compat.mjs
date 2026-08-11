import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '..');
const expectedPackageVersion = '0.14.0';
const expectedGhosttyVersion = '0.5.0-rc.0';
const ghosttyPackageName = '@floegence/ghostty-web';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function assertExact(actual, expected, location) {
  if (actual !== expected) {
    throw new Error(
      `${location} must be exactly ${expected}; received ${String(actual)}. `
      + 'Review and remove or update the version-bound Ghostty compatibility adapters before changing ghostty-web.',
    );
  }
}

const manifest = await readJson(path.join(packageRoot, 'package.json'));
const packageLock = await readJson(path.join(packageRoot, 'package-lock.json'));
const appLock = await readJson(path.join(repositoryRoot, 'app/web/package-lock.json'));
const installedGhosttyManifest = await readJson(
  path.join(packageRoot, 'node_modules/@floegence/ghostty-web/package.json'),
);

assertExact(manifest.version, expectedPackageVersion, 'terminal-web/package.json version');
assertExact(
  manifest.dependencies?.[ghosttyPackageName],
  expectedGhosttyVersion,
  'terminal-web/package.json ghostty-web dependency',
);
assertExact(packageLock.packages?.['']?.version, expectedPackageVersion, 'terminal-web lock root version');
assertExact(
  packageLock.packages?.['']?.dependencies?.[ghosttyPackageName],
  expectedGhosttyVersion,
  'terminal-web lock root ghostty-web dependency',
);
assertExact(
  packageLock.packages?.['node_modules/@floegence/ghostty-web']?.version,
  expectedGhosttyVersion,
  'terminal-web lock installed ghostty-web node',
);
assertExact(installedGhosttyManifest.version, expectedGhosttyVersion, 'terminal-web installed ghostty-web package');
assertExact(
  appLock.packages?.['../../terminal-web']?.version,
  expectedPackageVersion,
  'app/web lock terminal-web file dependency version',
);
assertExact(
  appLock.packages?.['../../terminal-web']?.dependencies?.[ghosttyPackageName],
  expectedGhosttyVersion,
  'app/web lock terminal-web file dependency ghostty-web version',
);
console.log(`${ghosttyPackageName} scrollback compatibility pin verified: ${expectedGhosttyVersion}`);
