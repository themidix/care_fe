import type {
  QuestionnaireResponse,
  ResponseValue,
} from "@/types/questionnaire/form";
import type { AnswerOption, Question } from "@/types/questionnaire/question";

/**
 * Build the empty/initial set of QuestionnaireResponse entries for a list
 * of questions. Mirrors the behaviour previously inlined in
 * `QuestionnaireForm.tsx` so it can be reused by alternate entry points
 * (e.g. Ambient Scribe).
 */
export function initializeResponses(
  questions: Question[],
): QuestionnaireResponse[] {
  const responses: QuestionnaireResponse[] = [];

  const processQuestion = (q: Question) => {
    if (q.type === "group" && q.questions) {
      q.questions.forEach(processQuestion);
      return;
    }
    let defaultValues: ResponseValue[] = [];
    if (q.answer_option && q.answer_option.length > 0) {
      const defaultOptions: AnswerOption[] = q.answer_option.filter(
        (o) => o.initial_selected === true,
      );
      if (defaultOptions.length > 0) {
        defaultValues = defaultOptions.map((opt) => ({
          type: "string",
          value: opt.value,
          coding: opt.code ?? undefined,
        }));
      }
    }
    responses.push({
      question_id: q.id,
      link_id: q.link_id,
      values: defaultValues,
      structured_type: q.structured_type ?? null,
    });
  };

  questions.forEach(processQuestion);
  return responses;
}
