import { Pencil, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

import { useScribeStatus } from "@/components/Questionnaire/AmbientScribe/ScribeHighlightContext";

import type { Question } from "@/types/questionnaire/question";

interface QuestionLabelProps {
  question: Question;
  className?: string;
  groupLabel?: boolean;
  isSubQuestion?: boolean;
}

const defaultGroupClass = "text-lg font-medium text-gray-900";
const defaultInputClass = "text-base font-medium block";

export function QuestionLabel({
  question,
  className,
  groupLabel,
  isSubQuestion = false,
}: QuestionLabelProps) {
  const { t } = useTranslation();
  const defaultClass = groupLabel ? defaultGroupClass : defaultInputClass;
  const { filledByScribe, editedAfterScribe } = useScribeStatus(question.id);

  return (
    <Label className={className ?? defaultClass}>
      <div className="flex flex-col gap-3 bg-gray-100 md:bg-transparent">
        {(question.type === "structured" || !isSubQuestion) && (
          <div className="hidden md:block h-1 w-4 rounded-full bg-indigo-600" />
        )}
        <div className="flex gap-3 items-center flex-wrap">
          {(question.type === "structured" || !isSubQuestion) && (
            <div className="md:hidden absolute w-1 h-5 rounded-r-sm bg-indigo-500 left-3.5" />
          )}
          <span>
            <span
              className={cn({
                "text-gray-950 font-semibold":
                  question.type === "structured" ||
                  groupLabel ||
                  !isSubQuestion,
              })}
            >
              {question.text}
            </span>
            {question.required && <span className="ml-1 text-red-500">*</span>}
          </span>
          {question.unit?.code && (
            <span className="text-sm text-gray-500">
              ({question.unit.code})
            </span>
          )}
          {filledByScribe && editedAfterScribe && (
            <Badge
              variant="purple"
              className="font-normal py-0.5"
              title={t("ambient_scribe_edited_tooltip")}
            >
              <Pencil className="size-3" />
              {t("ambient_scribe_edited_badge")}
            </Badge>
          )}
          {filledByScribe && !editedAfterScribe && (
            <Badge
              variant="primary"
              className="font-normal py-0.5"
              title={t("ambient_scribe_filled_tooltip")}
            >
              <Sparkles className="size-3" />
              {t("ambient_scribe_filled_badge")}
            </Badge>
          )}
        </div>
      </div>
    </Label>
  );
}
