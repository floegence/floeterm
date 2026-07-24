import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '..');
const expectedPackageVersion = '0.9.0';
const expectedGhosttyVersion = '0.4.0-next.14.g6a1a50d';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function assertExact(actual, expected, location) {
  if (actual !== expected) {
    throw new Error(
      `${location} must be exactly ${expected}; received ${String(actual)}. `
      + 'Review and remove or update the version-bound Ghostty scrollback compatibility adapter before changing ghostty-web.',
    );
  }
}

const manifest = await readJson(path.join(packageRoot, 'package.json'));
const packageLock = await readJson(path.join(packageRoot, 'package-lock.json'));
const appLock = await readJson(path.join(repositoryRoot, 'app/web/package-lock.json'));
const installedGhosttyManifest = await readJson(
  path.join(packageRoot, 'node_modules/ghostty-web/package.json'),
);

assertExact(manifest.version, expectedPackageVersion, 'terminal-web/package.json version');
assertExact(
  manifest.dependencies?.['ghostty-web'],
  expectedGhosttyVersion,
  'terminal-web/package.json ghostty-web dependency',
);
assertExact(packageLock.packages?.['']?.version, expectedPackageVersion, 'terminal-web lock root version');
assertExact(
  packageLock.packages?.['']?.dependencies?.['ghostty-web'],
  expectedGhosttyVersion,
  'terminal-web lock root ghostty-web dependency',
);
assertExact(
  packageLock.packages?.['node_modules/ghostty-web']?.version,
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
  appLock.packages?.['../../terminal-web']?.dependencies?.['ghostty-web'],
  expectedGhosttyVersion,
  'app/web lock terminal-web file dependency ghostty-web version',
);
console.log(`ghostty-web scrollback compatibility pin verified: ${expectedGhosttyVersion}`);
