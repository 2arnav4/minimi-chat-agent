import { serve } from '@hono/node-server';
import { config, missingKeys, modelChain, specName } from './config.js';
import { bindHost, createApp } from './app.js';

const hostname = bindHost();
serve({ fetch: createApp({ host: hostname }).fetch, port: config.port, hostname }, (info) => {
  const missing = missingKeys();
  console.log(`\n  Chat agent running at http://localhost:${info.port} (listening on ${hostname})`);
  console.log(`  Models (in fallback order): ${modelChain.map(specName).join(' -> ') || 'none'}`);
  if (missing.length) console.log(`  Missing in .env: ${missing.join(', ')} (copy .env.example to .env)`);
  console.log('');
});
