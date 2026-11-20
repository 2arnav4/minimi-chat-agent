# DESIGN

## How it works

```
browser ──POST /api/chat (SSE)──> server
                                   1. save user message with timestamp (SQLite)
                                   2. recall: resolve dates in the message -> pull those days -> rank by topic (FTS5/BM25)
                                   3. model call: static system prompt + last 12 turns + <turn_context> (now, timezone, recalled memory)
                                   4. agent loop (max 6 steps): model may call web_search, several in parallel
                                   5. stream tokens to the browser, save answer + the sources it cited, save a trace
```

- **One tool, `web_search`** (Tavily). Results come back as cleaned page text, trimmed to 5 results x 900 chars, wrapped in `<result id=n>` tags and labelled untrusted. The model cites `[n]`. The answer is stored with only the sources it actually cited.
- **Memory is part of the harness, not a tool.** The rules allow one tool. Doing recall before the model call also saves a full model round trip (no "decide to look it up, then look it up").
- **Every message has a UTC timestamp.** "Monday", "3 November", "yesterday", "last week" are turned into day ranges **in the user's timezone** (sent by the browser) with chrono-node plus my own rules:
  - a weekday that would fall in the future means the previous one
  - a bare date that would fall in the future means last year
  - "last Tuesday" is ambiguous in English (yesterday's Tuesday or the week before), so both days are checked and the one whose messages match the topic wins. The model is told which day was picked.
- **Clock is injectable.** `/api/chat` accepts `now`, and `/api/import` accepts past messages with timestamps. That is how the dev clock in the UI, the tests and the eval build up "what I asked on Monday". It can be switched off with `ALLOW_CLOCK_OVERRIDE=false`.

## Why it is built this way

- **Fast:** recall is pure SQLite (a few ms). The system prompt is static, so providers cache the shared prefix (Gemini implicit caching, OpenAI prefix caching). Per-turn data goes in the last message. Tokens are streamed, and the UI shows searches live. Searches for multiple items run in parallel. Repeat queries hit a 10-minute cache. Each search has an 8s timeout and fails soft. A step cap forces a written answer on the last step. **Fallback chain:** if a model fails (overloaded or out of quota, both seen on the Gemini free tier) before any text has streamed, the turn retries on the next model. Searches already done come from the cache. A per-attempt watchdog cancels a model that goes silent (the SDK timeout missed a call that never sent headers), and a failed model is skipped for 3 minutes (circuit breaker) so later turns don't wait on it.
- **Right:** the current date and time are in every turn. The prompt pushes official sources, explicit "as of" dates, `[n]` citations, and saying "I could not verify" instead of guessing. For "is that still correct?" the old answer and the URLs it used are recalled, then re-checked live, and the reply is split into changed / unchanged / unverified. In the first eval run the model "confirmed" an old answer without searching, so the harness now detects verification questions ("still correct", "changed since") and forces a search on the first step instead of trusting the model to. Web content is treated as data (defence against indirect prompt injection). Failed turns are not stored, so errors never become memories.
- **Safe by default:** it listens on 127.0.0.1 only and rejects other Host headers (DNS rebinding). API POSTs must be same-origin JSON (CSRF). The page sends a strict CSP and renders only http(s)/mailto links. Text from memory and web pages is escaped before it goes inside the `<memory>` / `<result>` tags, so it cannot close them and inject instructions. Demo-only time travel (Dev clock, import) is off unless explicitly enabled.
- **Good to talk to:** answer first, short by default, a table when comparing, one clarifying question only when needed. It is honest when there is no record for a date, rather than inventing one.

## Eval results

`npm run eval` (6 challenge-style questions, 16 checks) on the Gemini free tier: **16/16 passed**, first token p50 10.1s / p95 12.1s. Searches take 0.7-4s; most of the wait is the model on free-tier capacity. Two bugs were found this way and fixed: an unverified "still correct" answer, and dropped `[3, 7]` citations.

## Considered and rejected

| Option | Why not (for now) |
|---|---|
| Memory as a second tool (`search_memory`) | Breaks the one-tool rule and adds a model round trip per lookup |
| Stuff the whole history into context | Cost and latency grow every day; models lose facts in the middle of long contexts |
| Vector DB + embeddings for recall | Extra API call and latency on every turn. The test questions anchor on dates and named topics, where a date filter plus BM25 is more precise. It is the first upgrade below. |
| LLM call to parse dates | 300-800 ms of extra latency for something deterministic code does in under 1 ms |
| Scrape full pages after search | A second network hop per result; Tavily's cleaned content is usually enough |
| LangChain / LangGraph | A loop with one tool does not need a graph; the AI SDK loop is easy to read and to explain |

## With another week

1. **Hybrid recall:** add embeddings next to BM25 and merge them with reciprocal rank fusion, for paraphrased references ("that database thing").
2. **Structured claims:** extract (entity, attribute, value, date, source) from each answer, e.g. "Supabase Pro = $25/mo on 3 Nov". Then "what changed?" becomes a precise diff instead of comparing prose.
3. **Model routing:** a small fast model for chit-chat and memory-only questions, a stronger one for multi-search research. A fast path that skips the tool schema for greetings.
4. **Evals in CI:** grow `npm run eval` into a labelled set with an LLM judge, and track accuracy and p50/p95 latency for every prompt change.
5. **Multi-user and auth**, request size and rate limits, rolling summaries of very long conversations, and OpenTelemetry traces in place of the SQLite trace table.
