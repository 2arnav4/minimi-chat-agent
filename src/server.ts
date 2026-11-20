import { serve } from '@hono/node-server';
import { config, missingKeys, modelChain, specName } from './config.js';
import { bindHost, createApp } from './app.js';
import { startPruning } from './memory/prune.js';
import { applyServerTimeouts } from './http/limits.js';

const hostname = bindHost();
// Expired cache rows and old traces are cleared at startup and hourly.
const stopPruning = startPruning();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { stopPruning(); process.exit(0); });
const server = serve({ fetch: createApp({ host: hostname }).fetch, port: config.port, hostname }, (info) => {
  const missing = missingKeys();
  console.log(`\n  Chat agent running at http://localhost:${info.port} (listening on ${hostname})`);
  console.log(`  Models (in fallback order): ${modelChain.map(specName).join(' -> ') || 'none'}`);
  if (missing.length) console.log(`  Missing in .env: ${missing.join(', ')} (copy .env.example to .env)`);
  console.log('');
});
// Close slow or idle-before-headers sockets without cutting streaming answers.
applyServerTimeouts(server as unknown as Parameters<typeof applyServerTimeouts>[0]);
