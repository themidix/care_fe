import type { ResponseValue } from "@/types/questionnaire/form";
import type { Question, QuestionType } from "@/types/questionnaire/question";

/**
 * Question types that the Ambient Scribe POC will attempt to fill from the
 * conversation transcript. Excludes structured / choice / quantity / group.
 */
const FILLABLE_TYPES: ReadonlySet<QuestionType> = new Set([
  "string",
  "text",
  "url",
  "integer",
  "decimal",
  "boolean",
  "date",
  "dateTime",
  "time",
]);

export function getFillableQuestions(questions: Question[]): Question[] {
  const out: Question[] = [];
  const walk = (qs: Question[]) => {
    for (const q of qs) {
      if (q.type === "group" && q.questions) {
        walk(q.questions);
      } else if (FILLABLE_TYPES.has(q.type) && !q.read_only) {
        out.push(q);
      }
    }
  };
  walk(questions);
  return out;
}

/**
 * Convert a raw value returned by LeMUR into a ResponseValue array shaped
 * for `QuestionnaireResponse.values`. Returns `null` if the value cannot be
 * meaningfully coerced — caller should drop the entry.
 */
export function coerceValueByType(
  raw: unknown,
  type: QuestionType,
): ResponseValue[] | null {
  if (raw === null || raw === undefined || raw === "") return null;

  switch (type) {
    case "string":
    case "text":
    case "url": {
      const s = String(raw).trim();
      if (!s) return null;
      return [{ type: "string", value: s }];
    }
    case "integer": {
      const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (!Number.isFinite(n)) return null;
      return [{ type: "number", value: Math.trunc(n) }];
    }
    case "decimal": {
      const n = typeof raw === "number" ? raw : parseFloat(String(raw));
      if (!Number.isFinite(n)) return null;
      return [{ type: "number", value: n }];
    }
    case "boolean": {
      if (typeof raw === "boolean") return [{ type: "boolean", value: raw }];
      const s = String(raw).toLowerCase().trim();
      if (["true", "yes", "y", "1"].includes(s))
        return [{ type: "boolean", value: true }];
      if (["false", "no", "n", "0"].includes(s))
        return [{ type: "boolean", value: false }];
      return null;
    }
    case "date":
    case "dateTime": {
      const d = new Date(String(raw));
      if (isNaN(d.getTime())) return null;
      return [{ type, value: d }];
    }
    case "time": {
      const s = String(raw).trim();
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return null;
      return [{ type: "time", value: s }];
    }
    default:
      return null;
  }
}
