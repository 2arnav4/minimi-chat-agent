import 'dotenv/config';
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

export type Provider = 'openai' | 'google';

/** First entry is the main model, the rest are fallbacks tried in order if it fails. */
const DEFAULT_MODELS: Record<Provider, string[]> = {
  openai: ['gpt-5-mini'],
  google: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-lite-latest'],
};

const KEY_ENV: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

const env = (name: string) => (process.env[name] ?? '').trim();

export interface ModelSpec {
  provider: Provider;
  modelId: string;
}

/**
 * MODEL=provider:id[,provider:id...] sets the chain explicitly.
 * Otherwise the chain is picked from whichever LLM key is present.
 */
function resolveModelChain(): ModelSpec[] {
  const forced = env('MODEL');
  if (forced) {
    return forced.split(',').map((part) => {
      const [provider, ...rest] = part.trim().split(':');
      if (!(provider in DEFAULT_MODELS)) {
        throw new Error(`MODEL entries must look like "google:<id>" or "openai:<id>", got "${part}"`);
      }
      return { provider: provider as Provider, modelId: rest.join(':') || DEFAULT_MODELS[provider as Provider][0] };
    });
  }
  for (const p of ['openai', 'google'] as Provider[]) {
    if (env(KEY_ENV[p])) return DEFAULT_MODELS[p].map((modelId) => ({ provider: p, modelId }));
  }
  return [];
}

export const modelChain = resolveModelChain();
/** The main model (first in the chain). */
export const modelSpec: ModelSpec | null = modelChain[0] ?? null;
export const specName = (s: ModelSpec) => `${s.provider}:${s.modelId}`;

export function buildModel({ provider, modelId }: ModelSpec): LanguageModel {
  if (provider === 'openai') return createOpenAI({ apiKey: env(KEY_ENV.openai) })(modelId);
  return createGoogleGenerativeAI({ apiKey: env(KEY_ENV.google) })(modelId);
}

export const config = {
  port: Number(env('PORT') || 3000),
  tavilyKey: env('TAVILY_API_KEY'),
  defaultTimezone: env('DEFAULT_TIMEZONE') || 'Asia/Kolkata',
  allowClockOverride: env('ALLOW_CLOCK_OVERRIDE') !== 'false',
  dbPath: env('DB_PATH') || 'data/agent.db',
  /** Hard cap on agent loop steps (each step = one model call, possibly with parallel searches). */
  maxSteps: 6,
  /** How many recent turns of the current conversation are sent verbatim. */
  recentTurns: 12,
  searchTimeoutMs: 8000,
  /** Give up on a model (and fall back) if it sends nothing for this long. */
  modelFirstChunkMs: 20000,
  modelChunkMs: 30000,
  /** Gemini 3 models think before answering; lower = faster first token. */
  geminiThinking: (env('GEMINI_THINKING') || 'low') as 'low' | 'medium' | 'high',
  searchCacheTtlMs: 10 * 60 * 1000,
  /** Keep only the newest N traces (debug data). */
  traceKeep: Number(env('TRACE_KEEP') || 1000),
  /** Delete messages older than this many days. 0 = keep everything (messages are the memory). */
  messageRetentionDays: Number(env('MESSAGE_RETENTION_DAYS') || 0),
  pruneIntervalMs: 60 * 60 * 1000,
};

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!modelSpec) missing.push('one of OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY');
  if (!config.tavilyKey) missing.push('TAVILY_API_KEY');
  return missing;
}
