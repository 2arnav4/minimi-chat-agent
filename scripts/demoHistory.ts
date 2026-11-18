import { dayRange, zonedYmd, zonedMidnight } from '../src/memory/time.js';

/**
 * Demo history placed relative to "now", so the challenge's example questions
 * ("On Monday...", "last Tuesday...", "on 3 November...") have something to recall.
 * The answers are sample data written for the demo, not real research.
 */
export interface DemoConversation {
  title: string;
  messages: { role: 'user' | 'assistant'; content: string; at: number }[];
}

const H = 60 * 60 * 1000;
const DAY = 24 * H;

function mostRecentWeekday(now: Date, tz: string, weekday: number, minDaysAgo = 1): number {
  const today = dayRange(tz, now).start;
  for (let i = minDaysAgo; i < minDaysAgo + 7; i++) {
    const d = today - i * DAY;
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(d + 12 * H));
    if (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name) === weekday) return d;
  }
  throw new Error('unreachable');
}

export function demoHistory(now: Date, tz: string): DemoConversation[] {
  const monday = mostRecentWeekday(now, tz, 1);
  // The Tuesday at least 8 days back, so "last Tuesday" is genuinely ambiguous and recall must use the topic.
  const tuesday = mostRecentWeekday(now, tz, 2, 8);
  const { y } = zonedYmd(tz, now);
  let nov3 = zonedMidnight(tz, y, 11, 3);
  if (nov3 > now.getTime()) nov3 = zonedMidnight(tz, y - 1, 11, 3);

  return [
    {
      title: 'Monitor for coding (demo)',
      messages: [
        { role: 'user', content: 'What is a good 27 inch 4K monitor for coding under 40,000 rupees?', at: nov3 + 11 * H },
        { role: 'assistant', content: 'Two solid picks: the Dell S2722QC (USB-C, about Rs 32,000) and the LG 27UP600 (about Rs 28,000). Both are IPS 4K panels; the Dell is easier with a MacBook because one USB-C cable carries video and charging.', at: nov3 + 11 * H + 9000 },
      ],
    },
    {
      title: 'Postgres hosting (demo)',
      messages: [
        { role: 'user', content: 'Compare managed Postgres hosting for a small SaaS: Neon, Supabase, Render, AWS RDS.', at: tuesday + 15 * H },
        { role: 'assistant', content: 'Short version: Neon for scale-to-zero and branching, Supabase if you also want auth and storage, Render for simplicity, RDS when you need full AWS control.\n\n| Provider | Entry paid plan |\n|---|---|\n| Neon | Launch, usage based from about $5/mo |\n| Supabase | Pro, $25/mo |\n| Render | Basic-256mb, about $6/mo |\n| AWS RDS | db.t4g.micro, about $12/mo plus storage |', at: tuesday + 15 * H + 12000 },
      ],
    },
    {
      title: 'Weather (demo)',
      messages: [
        { role: 'user', content: 'Will it rain in Delhi this evening?', at: tuesday + 7 * DAY + 9 * H },
        { role: 'assistant', content: 'Unlikely. The forecast shows clear skies with a low of about 14 C.', at: tuesday + 7 * DAY + 9 * H + 5000 },
      ],
    },
    {
      title: 'CRM shortlist (demo)',
      messages: [
        { role: 'user', content: 'We are a 20-person sales team. Shortlist 5 CRM tools for us with pricing.', at: monday + 10 * H },
        { role: 'assistant', content: 'Shortlist for a 20-seat sales team:\n\n1. HubSpot Sales Hub Professional: about $90/seat/mo\n2. Pipedrive Advanced: about $34/seat/mo\n3. Salesforce Sales Cloud Enterprise: $165/seat/mo\n4. Zoho CRM Professional: about $23/seat/mo\n5. Close Growth: about $99/seat/mo\n\nIf budget matters most, Zoho or Pipedrive. If you want the deepest ecosystem, HubSpot or Salesforce.', at: monday + 10 * H + 15000 },
        { role: 'user', content: 'Keep Pipedrive and HubSpot as the top two.', at: monday + 10 * H + 60000 },
        { role: 'assistant', content: 'Noted: Pipedrive and HubSpot are the top two.', at: monday + 10 * H + 63000 },
      ],
    },
  ];
}
