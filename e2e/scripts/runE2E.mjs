import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const reserveLoopbackPort = async () => await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close(() => reject(new Error('failed to reserve a loopback E2E port')));
      return;
    }
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

const run = async (command, args, env) => await new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`${command} terminated by ${signal}`));
    else resolve(code ?? 1);
  });
});

const stateDir = await mkdtemp(join(tmpdir(), 'floeterm-e2e-'));
try {
  const buildExit = await run('npm', ['--prefix', '../app/web', 'run', 'build'], process.env);
  if (buildExit !== 0) process.exitCode = buildExit;
  else {
    const port = await reserveLoopbackPort();
    process.exitCode = await run(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['playwright', 'test', ...process.argv.slice(2)],
      {
        ...process.env,
        FLOETERM_E2E_PORT: String(port),
        FLOETERM_E2E_STATE_DIR: stateDir,
      },
    );
  }
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
