# DESIGN

## How it works

```
browser ──POST /api/chat (SSE)──> server
   1. save user message with timestamp (SQLite)
   2. recall: resolve dates in the message -> pull those days -> rank by topic (FTS5/BM25)
   3. model call: static system prompt + last 12 turns + <turn_context> (now, timezone, memory)
   4. agent loop (max 6 steps): model may call web_search, several in parallel
   5. stream tokens; save the answer + only the sources it cited; save a trace
```

- **One tool, `web_search`** (Tavily): 5 results x 900 chars, wrapped in `<result id=n>` tags as untrusted data. The model cites `[n]`.
- **Memory is part of the harness, not a tool.** That keeps the one-tool rule and saves a model round trip ("decide to look it up, then look it up").
- **Every message has a UTC timestamp.** "Monday", "3 November", "last week" become day ranges in the user's timezone (chrono-node plus rules: a weekday or bare date in the future means the previous one). "Last Tuesday" is ambiguous in English, so both candidate days are checked and the one matching the topic wins.
- **Injectable clock.** `/api/chat` accepts `now` and `/api/import` accepts back-dated messages, which is how the UI's Dev clock, tests and eval build history. Both are off unless `ALLOW_CLOCK_OVERRIDE=true`.

## Why it is built this way

- **Fast:** recall is pure SQLite (a few ms). The system prompt is static so the provider can cache the prefix; per-turn data goes in the last message. Tokens stream and searches show live. Parallel searches, a 10-minute search cache, an 8s search timeout that fails soft. If a model fails before any text streams (overload and quota errors are common on the Gemini free tier), the turn moves to the next model in the chain; a watchdog cancels a silent model and a failed one is skipped for 3 minutes.
- **Right:** the current time is in every turn. The prompt asks for official sources, "as of" dates, `[n]` citations, and "I could not verify" over guessing. For "is that still correct?" the old answer and its URLs are recalled and re-checked live (changed / unchanged / unverified). The first eval showed the model "confirming" without searching, so verification questions now force a search on step one. Failed turns are not stored, so errors never become memories; a stopped answer is stored as cancelled and recalled as incomplete.
- **Safe by default:** loopback bind plus a Host check (DNS rebinding), same-origin JSON POSTs only (CSRF), strict CSP and http(s)-only links (XSS), memory and web text escaped inside their tags (prompt-injection breakout), generic error codes with keys redacted from logs, body size caps and per-client rate limits, and pruning of the cache and traces.
- **Good to talk to:** answer first, short by default, tables for comparisons, one clarifying question only when needed, honest when a date has no record.

## Eval results

`npm run eval` (6 challenge-style questions, 16 checks) on the Gemini free tier: **16/16 passed**, first token p50 10.1s / p95 12.1s; most of the wait is free-tier model capacity. It caught two bugs, both fixed: an unverified "still correct" answer and dropped `[3, 7]` citations. Load test with mocked providers: 0% errors up to 1000 concurrent users.

## Considered and rejected

| Option | Why not (for now) |
|---|---|
| Memory as a second tool | Breaks the one-tool rule; adds a model round trip per lookup |
| Whole history in context | Cost and latency grow daily; models lose facts mid-context |
| Vector DB for recall | Extra call per turn; the questions anchor on dates and named topics, where date filter + BM25 is more precise |
| LLM call to parse dates | 300-800 ms for something code does in under 1 ms |
| Scrape full pages after search | A second hop per result; Tavily's cleaned text is usually enough |
| LangChain / LangGraph | One tool doesn't need a graph; the AI SDK loop is easier to read |

## With another week

1. **Hybrid recall:** embeddings next to BM25, merged with reciprocal rank fusion, for paraphrases ("that database thing").
2. **Structured claims:** store (entity, attribute, value, date, source) per answer, so "what changed?" is a precise diff, not prose comparison.
3. **Model routing:** a small model for chit-chat and memory-only questions, a stronger one for research.
4. **Evals in CI:** a labelled set with an LLM judge, tracking accuracy and p50/p95 per prompt change.
5. **Multi-user:** auth, a shared rate-limit store for several instances, summaries of long conversations, OpenTelemetry traces.
