import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { access } from 'node:fs/promises';
import { TaskManager } from '../src/tasks.js';
import { setup } from './helpers.js';

test('real pi: no-prompt get_state, abort, confirmed cleanup and workspace reuse',
  { skip: !process.env.PIPRO_REAL_PI }, async t => {
    const executable = process.env.PIPRO_REAL_PI;
    assert.ok(isAbsolute(executable), 'PIPRO_REAL_PI must be an explicitly selected absolute pi executable');
    const { config, home } = await setup(t, { piExecutable: executable });
    const manager = new TaskManager(config); t.after(() => manager.close());
    for (let i = 0; i < 2; i++) {
      const receipt = manager.create('local-no-model-test', 'a');
      const task = manager.get('local-no-model-test', receipt.taskId);
      await task.ready;
      assert.equal(task.status, 'idle');
      assert.equal(task.runEpoch, 0);
      assert.equal((await task.rpc.request('get_state')).isStreaming, false);
      manager.cancel('local-no-model-test', receipt.taskId); await task.cancelWork;
      assert.equal(task.status, 'cancelled');
      assert.equal(task.cleanupStatus, 'confirmed');
      assert.equal(task.processExited, true);
      await assert.rejects(access(join(home, 'pipro-leases/a.json')), error => error.code === 'ENOENT');
    }
  });
