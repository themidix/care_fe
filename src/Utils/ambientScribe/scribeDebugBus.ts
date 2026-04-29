/**
 * Lightweight pub/sub used by the Ambient Scribe pipeline to surface
 * diagnostic events (token usage, latency, WebSocket lifecycle, errors).
 *
 * Active only in development builds. In production the publish helpers are
 * cheap no-ops, and the panel is not mounted.
 */

export type ScribeDebugEventLevel = "info" | "warn" | "error" | "success";

export type ScribeDebugEvent = {
  id: number;
  ts: number;
  level: ScribeDebugEventLevel;
  category:
    | "ws"
    | "extract"
    | "transcribe"
    | "token"
    | "audio"
    | "error"
    | "info";
  /** Short human-readable label. */
  label: string;
  /** Free-form structured payload (rendered as JSON in the panel). */
  data?: unknown;
  /** Latency in ms when relevant. */
  latencyMs?: number;
  /** Token usage when known. */
  tokens?: {
    prompt?: number;
    completion?: number;
    total?: number;
  };
};

interface ScribeDebugStore {
  events: ScribeDebugEvent[];
  /** Aggregate token usage across the session. */
  totalTokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  /** Number of extraction calls. */
  extractCalls: number;
  /** Number of batch transcribe calls. */
  transcribeCalls: number;
  /** Approximate cost (USD) — best-effort using gpt-4o-mini default rates. */
  estimatedCostUsd: number;
}

const ENABLED = import.meta.env.DEV;
const MAX_EVENTS = 200;

// gpt-4o-mini pricing per 1M tokens (approximate; April 2026).
const COST_PER_M_PROMPT = 0.15;
const COST_PER_M_COMPLETION = 0.6;

let nextId = 1;
let store: ScribeDebugStore = {
  events: [],
  totalTokens: { prompt: 0, completion: 0, total: 0 },
  extractCalls: 0,
  transcribeCalls: 0,
  estimatedCostUsd: 0,
};

const listeners = new Set<(s: ScribeDebugStore) => void>();

function emit() {
  // Snapshot so React sees a new identity.
  store = { ...store, events: store.events.slice() };
  listeners.forEach((fn) => fn(store));
}

export function subscribeScribeDebug(
  listener: (s: ScribeDebugStore) => void,
): () => void {
  listeners.add(listener);
  listener(store);
  return () => {
    listeners.delete(listener);
  };
}

export function getScribeDebugSnapshot(): ScribeDebugStore {
  return store;
}

export function clearScribeDebug(): void {
  store = {
    events: [],
    totalTokens: { prompt: 0, completion: 0, total: 0 },
    extractCalls: 0,
    transcribeCalls: 0,
    estimatedCostUsd: 0,
  };
  emit();
}

export function publishScribeDebug(
  event: Omit<ScribeDebugEvent, "id" | "ts">,
): void {
  if (!ENABLED) return;
  const ev: ScribeDebugEvent = {
    ...event,
    id: nextId++,
    ts: Date.now(),
  };
  const events = [ev, ...store.events].slice(0, MAX_EVENTS);

  let { totalTokens, extractCalls, transcribeCalls, estimatedCostUsd } = store;
  if (ev.tokens) {
    const p = ev.tokens.prompt ?? 0;
    const c = ev.tokens.completion ?? 0;
    totalTokens = {
      prompt: totalTokens.prompt + p,
      completion: totalTokens.completion + c,
      total: totalTokens.total + (ev.tokens.total ?? p + c),
    };
    estimatedCostUsd +=
      (p * COST_PER_M_PROMPT + c * COST_PER_M_COMPLETION) / 1_000_000;
  }
  if (ev.category === "extract") extractCalls += 1;
  if (ev.category === "transcribe") transcribeCalls += 1;

  store = {
    events,
    totalTokens,
    extractCalls,
    transcribeCalls,
    estimatedCostUsd,
  };
  emit();
}
