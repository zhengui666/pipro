#!/usr/bin/env node
import { loadConfig } from './config.js';
import { startServer } from './server.js';

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  console.error('Usage: node src/main.js /absolute/path/to/config.json');
  process.exitCode = 1;
} else {
  try {
    const service = await startServer(await loadConfig(file));
    console.log(`pipro listening at ${service.url}`);
    let shuttingDown = false;
    const stop = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await service.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    // Validation errors can echo configuration values; do not print raw errors.
    console.error(`pipro startup failed: ${error.code || 'CONFIG_OR_LISTEN_ERROR'}`);
    process.exitCode = 1;
  }
}
