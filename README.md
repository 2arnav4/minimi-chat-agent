# Chat agent with web search and date-aware memory

A chat agent with one tool, web search. It answers fast, cites its sources, and remembers what you asked and when ("What did I ask you on 3 November? Is it still correct?").

Design notes: [DESIGN.md](DESIGN.md)

## Run it

```bash
npm install
cp .env.example .env   # add one LLM key and a Tavily key
npm run dev            # http://localhost:3000
```

Keys (see `.env.example`):
- one of `GOOGLE_GENERATIVE_AI_API_KEY` (free tier) or `OPENAI_API_KEY` (the provider is picked from whichever is set; override with `MODEL=provider:model-id`)
- `TAVILY_API_KEY` for web search (free tier at tavily.com)

Gemini and Tavily both have free tiers, so the whole thing runs at zero cost.

Requires Node 20+. The server listens on 127.0.0.1 only (set `HOST` to change it) and accepts only same-origin JSON POSTs.

## Try the memory

You need some history before you can ask about the past. Three ways to get it:

1. **Demo history:** `npm run seed` adds sample conversations dated last Monday (CRM shortlist), 3 November (monitor, Postgres hosting) and the most recent Tuesday (weather). Then ask:
   - "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
   - "What did I ask you on 3 November? Is your answer still correct today?"
   - "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
2. **Dev clock:** open "Dev clock" in the sidebar, tick "Pretend it is", pick a past date and chat. Messages are stored with that time. Untick it and ask about that day.
3. **API:** `POST /api/import` with `{ "messages": [{ "role": "user", "content": "...", "at": "2026-11-03T10:00:00+05:30" }] }`.

`POST /api/chat` also accepts `now` (ISO time) and `timeZone` (IANA name) for scripted tests.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server and UI with reload |
| `npm test` | Unit tests (dates, recall, search wrapping, cache) and integration tests through the real HTTP routes, SQLite and SSE, with only the model and search faked (no keys needed) |
| `npm run loadtest:server` then `npm run loadtest` | Load test with autocannon against the real app with a fake model and fake search (no API calls) |
| `npm run eval` | Runs the challenge-style questions against the real APIs on a throwaway DB and prints checks and p50/p95 latency |
| `npm run seed` | Adds demo history |
| `npm run typecheck` | TypeScript check |

## Layout

```
src/server.ts          starts the server
src/http/guards.ts     Host check, CSRF check, CSP headers
src/app.ts             HTTP + SSE routes (createApp, injectable model for tests), injectable clock
src/agent/run.ts       one turn: recall -> agent loop -> stream -> persist -> trace
src/agent/prompt.ts    static system prompt + per-turn context
src/memory/time.ts     "Monday" / "3 November" / "last week" -> ranges in the user's timezone
src/memory/recall.ts   pick the past messages relevant to this message
src/memory/store.ts    SQLite: messages (+FTS5), search cache, traces
src/search/webSearch.ts  the one tool (Tavily), cache, timeout, untrusted-content wrapping
public/                plain HTML/JS chat UI
```
