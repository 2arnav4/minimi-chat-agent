import { config } from '../src/config.js';
import { addMessage, createConversation, getDb } from '../src/memory/store.js';
import { formatStamp } from '../src/memory/time.js';
import { demoHistory } from './demoHistory.js';

/** npm run seed -- [timezone]   Adds demo conversations dated relative to today. */
const tz = process.argv[2] || config.defaultTimezone;
getDb();
for (const conv of demoHistory(new Date(), tz)) {
  const c = createConversation(conv.title, conv.messages[0].at);
  for (const m of conv.messages) addMessage(c.id, m.role, m.content, m.at);
  console.log(`  ${formatStamp(conv.messages[0].at, tz)}  ${conv.title}`);
}
console.log(`\nSeeded demo history into ${config.dbPath} (timezone ${tz}).`);
