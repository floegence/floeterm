import assert from 'node:assert/strict';
import test from 'node:test';

import { topContractForPlatform } from '../support/topProcess.mjs';

test('uses the real platform top command and exact header rows', () => {
  assert.deepEqual(topContractForPlatform('darwin'), {
    command: 'top -s 1',
    headerPrefix: 'Processes:',
    loadPrefix: 'Load Avg:',
  });
  assert.deepEqual(topContractForPlatform('linux'), {
    command: 'top -d 1',
    headerPrefix: 'top - ',
    loadPrefix: 'Tasks:',
  });
});

test('fails closed on an unsupported top implementation', () => {
  assert.throws(() => topContractForPlatform('win32'), /unsupported top platform/);
});
