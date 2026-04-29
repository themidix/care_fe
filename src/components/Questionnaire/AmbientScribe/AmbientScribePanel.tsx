import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Loader2, Mic, Square } from "lucide-react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import {
  type ScribeExtraction,
  useAmbientScribe,
} from "@/components/Questionnaire/AmbientScribe/useAmbientScribe";

import type { Question } from "@/types/questionnaire/question";

interface AmbientScribePanelProps {
  questions: Question[];
  onExtraction: (extraction: ScribeExtraction) => void;
}

export function AmbientScribePanel({
  questions,
  onExtraction,
}: AmbientScribePanelProps) {
  const { t } = useTranslation();
  const scribe = useAmbientScribe({ questions, onExtraction });

  // Surface errors as toasts.
  useEffect(() => {
    if (scribe.error) toast.error(t(scribe.error) || scribe.error);
  }, [scribe.error, t]);

  const isRecording = scribe.phase === "listening";
  const isStopping = scribe.phase === "stopping";
  const isConnecting = scribe.phase === "connecting";

  const statusLabel = useMemo(() => {
    if (isConnecting) return t("ambient_scribe_connecting");
    if (isRecording) return t("ambient_scribe_listening");
    if (isStopping) return t("ambient_scribe_finalising");
    if (scribe.phase === "ready_for_review") return t("ambient_scribe_ready");
    return t("ambient_scribe_idle");
  }, [isConnecting, isRecording, isStopping, scribe.phase, t]);

  const transcriptText = scribe.batchTranscript?.text ?? null;
  const hasLiveLines =
    scribe.finalSegments.length > 0 || scribe.partialText.length > 0;

  return (
    <Card className="flex flex-col h-[calc(100vh-12rem)] overflow-hidden bg-white">
      <CardContent className="p-0 flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-700">
            <Mic className="size-4 text-gray-500" />
            <span>{statusLabel}</span>
          </div>
          {isRecording && (
            <div className="flex items-center gap-1.5 text-xs font-semibold text-red-600 uppercase tracking-wider">
              <span className="relative flex size-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full size-2 bg-red-500" />
              </span>
              {t("ambient_scribe_rec")}
            </div>
          )}
        </div>

        {/* Hero: mic + waves + caption */}
        <div className="flex flex-col items-center justify-center pt-6 pb-3 px-4">
          <button
            type="button"
            onClick={() => {
              if (
                scribe.phase === "idle" ||
                scribe.phase === "ready_for_review"
              )
                void scribe.start();
              else if (isRecording) void scribe.stop();
            }}
            disabled={isStopping || isConnecting}
            className={cn(
              "relative inline-flex items-center justify-center size-20 rounded-full transition-all",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2",
              isRecording
                ? "bg-primary-600 text-white shadow-lg"
                : "bg-primary-700 hover:bg-primary-600 text-white",
              (isStopping || isConnecting) && "opacity-70 cursor-not-allowed",
            )}
          >
            {isRecording && (
              <>
                <span className="absolute inset-0 rounded-full animate-ping bg-primary-500 opacity-30" />
                <span
                  className="absolute -inset-2 rounded-full border-2 border-primary-300 animate-pulse opacity-60"
                  aria-hidden
                />
              </>
            )}
            {isConnecting && (
              <span
                className="absolute -inset-2 rounded-full border-2 border-primary-300 border-t-transparent animate-spin"
                aria-hidden
              />
            )}
            {isConnecting ? (
              <Loader2 className="size-8 animate-spin" />
            ) : isRecording ? (
              <Square className="size-8 fill-current" />
            ) : (
              <Mic className="size-8" />
            )}
          </button>

          <WaveBars active={isRecording} level={scribe.level} />

          <p className="mt-3 text-center text-sm">
            {isConnecting ? (
              <span className="text-gray-600 inline-flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" />
                {t("ambient_scribe_connecting_caption")}
              </span>
            ) : isRecording ? (
              <span className="text-gray-700">
                {t("ambient_scribe_caption_prefix")}{" "}
                <strong className="text-gray-900">
                  {t("ambient_scribe_caption_active")}
                </strong>
              </span>
            ) : isStopping ? (
              <span className="text-gray-500">
                {t("ambient_scribe_finalising")}
              </span>
            ) : scribe.phase === "ready_for_review" ? (
              <span className="text-gray-700">
                {t("ambient_scribe_done_caption")}
              </span>
            ) : (
              <span className="text-gray-500">
                {t("ambient_scribe_idle_caption")}
              </span>
            )}
          </p>

          <RecordingTimer ms={scribe.elapsedMs} />
        </div>

        {/* Transcript */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 border-t">
          {transcriptText ? (
            scribe.batchTranscript?.utterances?.length ? (
              <div className="pt-3 space-y-2 text-sm">
                {scribe.batchTranscript.utterances.map((u, i) => {
                  const prev =
                    i > 0
                      ? scribe.batchTranscript!.utterances![i - 1].speaker
                      : null;
                  const showSpeaker = u.speaker !== prev;
                  return (
                    <div key={i} className="flex items-start gap-2">
                      <SpeakerBadge speaker={u.speaker} visible={showSpeaker} />
                      <p className="flex-1 text-gray-800">{u.text}</p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="pt-3 text-sm text-gray-800 whitespace-pre-wrap">
                {transcriptText}
              </p>
            )
          ) : hasLiveLines ? (
            <div className="pt-3 space-y-2 text-sm">
              {scribe.finalSegments.map((s, i) => {
                const prevSpeaker =
                  i > 0 ? scribe.finalSegments[i - 1].speaker : null;
                const showSpeaker =
                  s.speaker !== null && s.speaker !== prevSpeaker;
                return (
                  <div key={i} className="flex items-start gap-2">
                    <SpeakerBadge speaker={s.speaker} visible={showSpeaker} />
                    <p className="flex-1 text-gray-800">{s.text}</p>
                  </div>
                );
              })}
              {scribe.partialText && (
                <div className="flex items-start gap-2">
                  <SpeakerBadge
                    speaker={scribe.partialSpeaker}
                    visible={
                      scribe.partialSpeaker !== null &&
                      scribe.partialSpeaker !==
                        (scribe.finalSegments[scribe.finalSegments.length - 1]
                          ?.speaker ?? null)
                    }
                  />
                  <p className="flex-1 text-gray-500 italic">
                    {scribe.partialText}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <p className="pt-6 text-center text-xs text-gray-400">
              {scribe.phase === "idle"
                ? t("ambient_scribe_press_to_start")
                : t("ambient_scribe_no_transcript_yet")}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t bg-gray-50">
          <span className="text-xs text-gray-500">
            {scribe.isExtracting ? t("ambient_scribe_extracting") : "\u00a0"}
          </span>
          {scribe.phase === "idle" || scribe.phase === "ready_for_review" ? (
            <Button
              type="button"
              size="sm"
              onClick={() => void scribe.start()}
              className="gap-1.5"
              disabled={isStopping || isConnecting}
            >
              <Mic className="size-3.5" />
              {scribe.phase === "ready_for_review"
                ? t("ambient_scribe_record_again")
                : t("ambient_scribe_start")}
            </Button>
          ) : isConnecting ? (
            <Button type="button" size="sm" disabled className="gap-1.5">
              <Loader2 className="size-3.5 animate-spin" />
              {t("ambient_scribe_connecting")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => void scribe.stop()}
              disabled={isStopping}
              className="gap-1.5"
            >
              <Square className="size-3.5" />
              {isStopping
                ? t("ambient_scribe_finalising")
                : t("ambient_scribe_stop")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const WAVE_BARS = 9;

function WaveBars({ active, level }: { active: boolean; level: number }) {
  // When active, scale the waveform amplitude with the recorder's RMS level.
  // Bars are centered vertically (extending equally up and down) so the
  // waveform reads as a horizontally symmetric pulse.
  const amp = active ? Math.min(1, 0.3 + level * 1.4) : 0.05;
  return (
    <div
      className="flex items-center justify-center gap-1 h-12 mt-3"
      aria-hidden="true"
    >
      {Array.from({ length: WAVE_BARS }).map((_, i) => {
        const center = (WAVE_BARS - 1) / 2;
        const dist = Math.abs(i - center) / center; // 0 .. 1
        const baseline = 0.4 + (1 - dist) * 0.6; // 0.4 .. 1.0
        const heightPct = Math.max(8, amp * baseline * 100);
        return (
          <span
            key={i}
            className={cn(
              "w-1 rounded-full bg-primary-600/80",
              active && "animate-pulse",
            )}
            style={{
              height: `${heightPct}%`,
              animationDelay: active ? `${i * 80}ms` : undefined,
              animationDuration: active ? "900ms" : undefined,
              transition: "height 120ms linear",
            }}
          />
        );
      })}
    </div>
  );
}

function RecordingTimer({ ms }: { ms: number }) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return (
    <span className="mt-2 font-mono text-xs text-gray-400">
      {m}:{s}
    </span>
  );
}

// Tailwind palette per speaker label. Diarization typically yields A/B/C…;
// fallback to a neutral chip for "UNKNOWN" or when diarization is disabled.
const SPEAKER_STYLES: Record<string, string> = {
  A: "bg-blue-100 text-blue-700 ring-blue-200",
  B: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  C: "bg-violet-100 text-violet-700 ring-violet-200",
  D: "bg-amber-100 text-amber-700 ring-amber-200",
  E: "bg-rose-100 text-rose-700 ring-rose-200",
  F: "bg-cyan-100 text-cyan-700 ring-cyan-200",
};

function SpeakerBadge({
  speaker,
  visible,
}: {
  speaker: string | null;
  visible: boolean;
}) {
  const { t } = useTranslation();
  // Reserve a fixed width slot so transcript lines stay aligned even when
  // the badge is hidden (continuation of the same speaker).
  if (!visible || !speaker) {
    return <span aria-hidden className="w-12 shrink-0" />;
  }
  const isUnknown = speaker === "UNKNOWN";
  const style =
    SPEAKER_STYLES[speaker] ?? "bg-gray-100 text-gray-600 ring-gray-200";
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center justify-center w-12 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider ring-1",
        isUnknown ? "bg-gray-100 text-gray-500 ring-gray-200" : style,
      )}
      title={
        isUnknown
          ? t("ambient_scribe_speaker_unknown_tooltip")
          : t("ambient_scribe_speaker_tooltip", { speaker })
      }
    >
      {isUnknown
        ? t("ambient_scribe_speaker_unknown_short")
        : t("ambient_scribe_speaker_short", { speaker })}
    </span>
  );
}
