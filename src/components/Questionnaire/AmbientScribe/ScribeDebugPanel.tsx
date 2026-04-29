import { useEffect, useState } from "react";

import {
  AlertCircle,
  Bug,
  ChevronDown,
  ChevronUp,
  Coins,
  Eraser,
  Info,
  Maximize2,
  Minimize2,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";

import {
  type ScribeDebugEvent,
  type ScribeDebugEventLevel,
  clearScribeDebug,
  subscribeScribeDebug,
} from "@/Utils/ambientScribe/scribeDebugBus";

interface Snapshot {
  events: ScribeDebugEvent[];
  totalTokens: { prompt: number; completion: number; total: number };
  extractCalls: number;
  transcribeCalls: number;
  estimatedCostUsd: number;
}

const LEVEL_BADGE: Record<
  ScribeDebugEventLevel,
  "primary" | "yellow" | "destructive" | "green"
> = {
  info: "primary",
  warn: "yellow",
  error: "destructive",
  success: "green",
};

const CATEGORY_ICON: Record<ScribeDebugEvent["category"], string> = {
  ws: "🔌",
  extract: "🧠",
  transcribe: "📝",
  token: "🎟️",
  audio: "🎙️",
  error: "⚠️",
  info: "ℹ️",
};

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Floating dev-only HUD that surfaces ambient-scribe diagnostics:
 * token usage, latency, WS lifecycle, errors. Only mounted under
 * `import.meta.env.DEV`.
 */
export function ScribeDebugPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    events: [],
    totalTokens: { prompt: 0, completion: 0, total: 0 },
    extractCalls: 0,
    transcribeCalls: 0,
    estimatedCostUsd: 0,
  }));
  const [collapsed, setCollapsed] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);

  useEffect(() => subscribeScribeDebug(setSnapshot), []);

  const hasActivity =
    snapshot.events.length > 0 ||
    snapshot.totalTokens.total > 0 ||
    snapshot.extractCalls > 0;

  if (!hasActivity && collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 right-4 z-9999 flex items-center gap-1.5 rounded-full bg-gray-900/90 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur hover:bg-gray-900"
        title="Open Ambient Scribe debug panel"
      >
        <Bug className="size-3.5" />
        <span>Scribe Debug</span>
      </button>
    );
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 right-4 z-9999 flex items-center gap-2 rounded-full bg-gray-900/90 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur hover:bg-gray-900"
      >
        <Bug className="size-3.5" />
        <span>{snapshot.extractCalls + snapshot.transcribeCalls} calls</span>
        <span className="text-gray-300">·</span>
        <span>{formatNumber(snapshot.totalTokens.total)} tok</span>
        <span className="text-gray-300">·</span>
        <span>{formatCost(snapshot.estimatedCostUsd)}</span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "fixed z-9999 flex flex-col rounded-lg border border-gray-700 bg-gray-900/95 text-gray-100 shadow-2xl backdrop-blur",
        expanded ? "inset-4" : "bottom-4 right-4 w-[460px] max-h-[70vh]",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-700 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
          <Bug className="size-3.5 text-amber-300" />
          <span>Ambient Scribe Debug</span>
          <span className="rounded bg-amber-300/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            DEV
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={clearScribeDebug}
            className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white"
            title="Clear log"
          >
            <Eraser className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white"
            title={expanded ? "Restore" : "Expand"}
          >
            {expanded ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white"
            title="Collapse"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-px bg-gray-700 text-xs">
        <Stat
          icon={<Coins className="size-3" />}
          label="Tokens"
          value={formatNumber(snapshot.totalTokens.total)}
          sub={`${formatNumber(snapshot.totalTokens.prompt)} in · ${formatNumber(snapshot.totalTokens.completion)} out`}
        />
        <Stat
          label="Cost"
          value={formatCost(snapshot.estimatedCostUsd)}
          sub="gpt-4o-mini est."
        />
        <Stat
          label="Extract"
          value={String(snapshot.extractCalls)}
          sub="calls"
        />
        <Stat
          label="Transcribe"
          value={String(snapshot.transcribeCalls)}
          sub="batch calls"
        />
      </div>

      {/* Events */}
      <div className="flex-1 overflow-y-auto font-mono text-[11px]">
        {snapshot.events.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center text-gray-500">
            <Info className="size-5" />
            <span>Waiting for scribe activity…</span>
          </div>
        ) : (
          <ul className="divide-y divide-gray-800">
            {snapshot.events.map((ev) => (
              <li
                key={ev.id}
                className="cursor-pointer px-3 py-1.5 hover:bg-gray-800"
                onClick={() =>
                  setExpandedEvent((id) => (id === ev.id ? null : ev.id))
                }
              >
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 tabular-nums">
                    {formatTime(ev.ts)}
                  </span>
                  <span>{CATEGORY_ICON[ev.category]}</span>
                  <Badge
                    variant={LEVEL_BADGE[ev.level]}
                    className="px-1 py-0 text-[10px]"
                  >
                    {ev.category}
                  </Badge>
                  <span className="flex-1 truncate text-gray-100">
                    {ev.label}
                  </span>
                  {typeof ev.latencyMs === "number" && (
                    <span className="text-gray-400">{ev.latencyMs}ms</span>
                  )}
                  {ev.tokens?.total ? (
                    <span className="text-amber-300">
                      {formatNumber(ev.tokens.total)}t
                    </span>
                  ) : null}
                  {expandedEvent === ev.id ? (
                    <ChevronUp className="size-3 text-gray-500" />
                  ) : (
                    <ChevronDown className="size-3 text-gray-500" />
                  )}
                </div>
                {expandedEvent === ev.id && ev.data !== undefined && (
                  <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/50 p-2 text-[10px] text-gray-200">
                    {JSON.stringify(ev.data, null, 2)}
                  </pre>
                )}
                {expandedEvent === ev.id && ev.tokens && (
                  <div className="mt-1.5 flex gap-3 text-[10px] text-gray-300">
                    <span>prompt: {formatNumber(ev.tokens.prompt ?? 0)}</span>
                    <span>
                      completion: {formatNumber(ev.tokens.completion ?? 0)}
                    </span>
                    <span>total: {formatNumber(ev.tokens.total ?? 0)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-gray-700 px-3 py-1.5 text-[10px] text-gray-400">
        <span className="flex items-center gap-1">
          <AlertCircle className="size-3" />
          Browser-direct API calls. Costs are estimates.
        </span>
        <span>{snapshot.events.length} events</span>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-gray-900 px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-400">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-0.5 text-base font-semibold text-white tabular-nums">
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-gray-500 truncate" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * Mounts the debug panel only in development. Safe no-op in production.
 */
export function ScribeDebugPanelDev() {
  if (!import.meta.env.DEV) return null;
  return <ScribeDebugPanel />;
}
