import { createContext, useContext, useEffect, useState } from "react";

interface ScribeHighlightContextValue {
  /** Returns the timestamp at which the question was last updated by the
   * AI scribe, or `undefined` if it never has been. */
  getUpdatedAt: (questionId: string) => number | undefined;
  /** True if the scribe has ever filled this question (sticky for the
   * lifetime of the form session). */
  isFilledByScribe: (questionId: string) => boolean;
  /** True if the user manually edited a field after the scribe had filled
   * it. Implies `isFilledByScribe` is also true. */
  isEditedAfterScribe: (questionId: string) => boolean;
}

const ScribeHighlightContext = createContext<ScribeHighlightContextValue>({
  getUpdatedAt: () => undefined,
  isFilledByScribe: () => false,
  isEditedAfterScribe: () => false,
});

export function ScribeHighlightProvider({
  children,
  updates,
  filledByScribe,
  editedAfterScribe,
}: {
  children: React.ReactNode;
  /** Map of question_id → timestamp(ms) when that question was last
   * written by the scribe. The Map identity should change on each new
   * extraction so consumers re-render. */
  updates: Map<string, number>;
  /** Set of question_ids the scribe has ever filled. */
  filledByScribe: Set<string>;
  /** Set of question_ids the user has edited after the scribe filled them. */
  editedAfterScribe: Set<string>;
}) {
  return (
    <ScribeHighlightContext.Provider
      value={{
        getUpdatedAt: (id) => updates.get(id),
        isFilledByScribe: (id) => filledByScribe.has(id),
        isEditedAfterScribe: (id) => editedAfterScribe.has(id),
      }}
    >
      {children}
    </ScribeHighlightContext.Provider>
  );
}

/** How long after a scribe update the highlight remains visible. */
const HIGHLIGHT_DURATION_MS = 2200;

/**
 * Returns `true` while the question was recently updated by the scribe.
 * Re-renders once the highlight expires so the ring fades out cleanly.
 */
export function useScribeHighlight(questionId: string): boolean {
  const { getUpdatedAt } = useContext(ScribeHighlightContext);
  const updatedAt = getUpdatedAt(questionId);
  const [, force] = useState(0);

  useEffect(() => {
    if (!updatedAt) return;
    const elapsed = Date.now() - updatedAt;
    const remaining = HIGHLIGHT_DURATION_MS - elapsed;
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => force((n) => n + 1), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [updatedAt]);

  if (!updatedAt) return false;
  return Date.now() - updatedAt < HIGHLIGHT_DURATION_MS;
}

/**
 * Returns the persistent AI-fill status for a question:
 * - `filledByScribe`: AI has written this field at some point in this session.
 * - `editedAfterScribe`: user manually changed it after the AI fill.
 */
export function useScribeStatus(questionId: string): {
  filledByScribe: boolean;
  editedAfterScribe: boolean;
} {
  const { isFilledByScribe, isEditedAfterScribe } = useContext(
    ScribeHighlightContext,
  );
  return {
    filledByScribe: isFilledByScribe(questionId),
    editedAfterScribe: isEditedAfterScribe(questionId),
  };
}
