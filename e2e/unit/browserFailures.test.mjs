import assert from 'node:assert/strict';
import test from 'node:test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';

const createPage = () => {
  const listeners = new Map();
  return {
    page: {
      on: (event, listener) => listeners.set(event, listener),
    },
    emitConsole: (type, text) => listeners.get('console')?.({
      type: () => type,
      text: () => text,
    }),
    emitPageError: message => listeners.get('pageerror')?.(new Error(message)),
  };
};

test('ignores only Chromium readback driver diagnostics', () => {
  const fixture = createPage();
  const failures = captureBrowserFailures(fixture.page);

  fixture.emitConsole(
    'warning',
    '[.WebGL-0x1234]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels',
  );
  fixture.emitConsole('warning', 'application warning');
  fixture.emitConsole('error', 'application error');
  fixture.emitPageError('page failed');

  assert.deepEqual(failures, [
    'console:warning:application warning',
    'console:error:application error',
    'pageerror:page failed',
  ]);
});
