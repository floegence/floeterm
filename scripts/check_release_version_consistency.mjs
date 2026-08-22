import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function readReleaseVersions(root = repoRoot) {
  const packageManifest = JSON.parse(await readFile(path.join(root, 'terminal-web', 'package.json'), 'utf8'));
  const packageVersion = String(packageManifest.version ?? '').trim();
  const goVersion = (await readFile(path.join(root, 'terminal-go', 'VERSION'), 'utf8')).trim();
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion) || !/^\d+\.\d+\.\d+$/.test(goVersion)) {
    throw new Error(`release versions must be stable semver values: npm=${packageVersion} go=${goVersion}`);
  }
  if (packageVersion !== goVersion) {
    throw new Error(`Floeterm release versions differ: npm=${packageVersion} go=${goVersion}`);
  }
  return { version: packageVersion };
}

function gitRevision(root, ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`required release ref is missing: ${ref}`);
  }
}

export async function validateReleaseTag(root, tag, version) {
  if (tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match version ${version}`);
  }
  const topLevelRef = `refs/tags/${tag}`;
  const goRef = `refs/tags/terminal-go/${tag}`;
  const topLevelRevision = gitRevision(root, topLevelRef);
  const goRevision = gitRevision(root, goRef);
  const headRevision = gitRevision(root, 'HEAD');
  if (topLevelRevision !== goRevision || topLevelRevision !== headRevision) {
    throw new Error(
      `release tags must point to HEAD together: ${tag}=${topLevelRevision} terminal-go/${tag}=${goRevision} HEAD=${headRevision}`,
    );
  }
}

async function main() {
  const { version } = await readReleaseVersions();
  const tagIndex = process.argv.indexOf('--tag');
  if (tagIndex !== -1) {
    const tag = process.argv[tagIndex + 1];
    if (!tag) throw new Error('--tag requires a value');
    await validateReleaseTag(repoRoot, tag, version);
  }
  console.log(`Floeterm release version consistency verified: ${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
