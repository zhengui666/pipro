#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const scenario = existsSync('fake-scenario') ? readFileSync('fake-scenario', 'utf8').trim() : '';
const record = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (cmd, data, success = true) => record({ id: cmd.id, type: 'response', command: cmd.type, success,
  ...(success ? { data } : { error: 'api_key=should-not-leak' }) });
let active = false;
let completion;
let hold;
let steering = [];
let followUp = [];
const queueUpdate = () => record({ type: 'queue_update', steering, followUp });
const finish = (message, error = false) => {
  record({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: message }], stopReason: error ? 'error' : 'stop' } });
  record({ type: 'agent_end', willRetry: false, messages: ['secret'] });
  active = false;
  steering = []; followUp = []; queueUpdate();
  record({ type: 'agent_settled', aborted: false });
};

createInterface({ input: process.stdin }).on('line', line => {
  const cmd = JSON.parse(line);
  appendFileSync('protocol.log', JSON.stringify({ type: cmd.type, id: cmd.id, streamingBehavior: cmd.streamingBehavior }) + '\n');
  switch (cmd.type) {
    case 'get_state':
      reply(cmd, { isStreaming: active, isCompacting: false, args: process.argv.slice(2),
        envKeys: Object.keys(process.env), home: process.env.HOME }); break;
    case 'prompt': {
      if (active && ['settle-race', 'prompt-settle-race'].includes(scenario)) finish('previous run');
      if (cmd.message === 'handled') { reply(cmd, { disposition: 'handled' }); break; }
      if (active && cmd.streamingBehavior) {
        (cmd.streamingBehavior === 'steer' ? steering : followUp).push(cmd.message);
        if (scenario !== 'no-queue-update') queueUpdate();
        reply(cmd, { disposition: 'queued' }); break;
      }
      if (cmd.message === 'reject' || active) { reply(cmd, undefined, false); break; }
      active = true;
      record({ type: 'agent_start' });
      if (scenario === 'cancel-timeout') break;
      if (scenario === 'detached-crash') {
        spawn(process.execPath, ['-e', 'setTimeout(()=>require("fs").writeFileSync("detached-tool-wrote","orphan write"),800)'], { detached: true, stdio: 'ignore' });
        setTimeout(() => process.exit(2), 30);
      }
      if (cmd.message === 'fast') {
        finish('fast result'); reply(cmd, { disposition: 'started' }); break;
      }
      if (cmd.message === 'spawn-tool') {
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>require("fs").writeFileSync("tool-survived","bad"),800)'], { stdio: 'ignore' });
        writeFileSync('tool.pid', String(child.pid));
      }
      if (cmd.message === 'flood') for (let i = 0; i < 100; i++) record({ type: 'tool_execution_update', toolName: 'bash', args: { command: 'secret' }, partialResult: { text: 'secret' } });
      record({ type: 'agent_end', willRetry: true });
      record({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'api_key=secret' } });
      reply(cmd, { disposition: 'started' });
      if (!['wait', 'spawn-tool'].includes(cmd.message) && !['settle-race', 'prompt-settle-race', 'detached-crash'].includes(scenario)) {
        completion = setTimeout(() => finish(cmd.message === 'secret'
          ? 'api_key=fake-value sk-testsecret987654 Bearer faketoken ' + 'x'.repeat(500)
          : 'final result', cmd.message === 'model-error'), 80);
      }
      break;
    }
    case 'steer': case 'follow_up':
      (cmd.type === 'steer' ? steering : followUp).push(cmd.message); queueUpdate();
      reply(cmd, { disposition: 'queued' }); break;
    case 'test_consume':
      if (steering.length) steering.shift(); else followUp.shift(); queueUpdate(); reply(cmd, {}); break;
    case 'test_settle': finish('finished'); reply(cmd, {}); break;
    case 'clear_queue': {
      if (scenario === 'fail_clear') { reply(cmd, undefined, false); break; }
      const cleared = { steering, followUp }; steering = []; followUp = []; queueUpdate(); reply(cmd, cleared); break;
    }
    case 'abort':
      if (scenario === 'hang_abort') break;
      clearTimeout(completion);
      record({ type: 'agent_settled', aborted: true });
      active = false;
      reply(cmd, undefined, scenario !== 'fail_abort'); break;
    case 'unicode': {
      const raw = Buffer.from(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: '你\u2028我\u2029😀' }) + '\r\n');
      for (const byte of raw) process.stdout.write(Buffer.from([byte]));
      break;
    }
    case 'first': hold = cmd; break;
    case 'second': reply(cmd, 'second'); reply(hold, 'first'); break;
    case 'reject': reply(cmd, undefined, false); break;
    case 'mismatch': record({ id: cmd.id, type: 'response', command: 'wrong', success: true }); break;
    case 'malformed': process.stdout.write('not json\n'); break;
    case 'oversize': process.stdout.write('x'.repeat(10000)); break;
    case 'partialexit': process.stdout.write('{"type":'); process.exit(3); break;
    case 'exit': process.exit(2); break;
    case 'orphanexit':
      spawn(process.execPath, ['-e', 'setTimeout(()=>require("fs").writeFileSync("orphan-survived","bad"),1000)'], { stdio: ['ignore', 1, 2] });
      process.exit(2); break;
    case 'nonid': record({ type: 'response', command: 'parse', success: false }); break;
    case 'hang': break;
    default: reply(cmd, {});
  }
}).on('close', () => { clearTimeout(completion); process.exit(0); });
process.stderr.write('Bearer never-return-stderr\n');
