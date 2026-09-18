import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import type { Message } from "@/lib/ipc";
import { sessionKey, useChatStore } from "../store";

/**
 * AskUserQuestion panel (dock form): the CLI parked the question on the
 * control protocol (`can_use_tool`) and the turn only continues once it is
 * answered or ignored. The panel takes over the composer area: header chip +
 * prompt (+ page controls for multi-question asks), selectable option rows,
 * a free-form answer input, and the ignore/submit footer. Answers are the
 * chosen option labels — the contract the CLI's question reader matches
 * against; any other non-empty string travels as a typed (free-form) answer.
 */
export function QuestionCard({ message }: { message: Message }) {
  const { t } = useTranslation();
  const respondToQuestion = useChatStore((s) => s.respondToQuestion);
  const active = useChatStore((s) => s.active);
  const key = active
    ? sessionKey(active.engine, active.sessionId, active.workspacePath)
    : "";
  const [picked, setPicked] = useState<Record<string, string | string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const question = message.question;
  if (!question) return null;
  const { questions } = question;
  const current = questions[Math.min(page, questions.length - 1)];
  if (!current) return null;

  const pick = (text: string, label: string, multi: boolean) => {
    // An option pick replaces any typed answer for that question.
    setOther((cur) => ({ ...cur, [text]: "" }));
    setPicked((cur) => {
      if (!multi) return { ...cur, [text]: label };
      const list = Array.isArray(cur[text]) ? [...(cur[text] as string[])] : [];
      const at = list.indexOf(label);
      if (at >= 0) list.splice(at, 1);
      else list.push(label);
      return { ...cur, [text]: list };
    });
  };
  /** Option pick, or the typed free-form answer when one is present. */
  const valueFor = (text: string): string | string[] => {
    const typed = (other[text] ?? "").trim();
    return typed ? typed : picked[text] ?? "";
  };
  const complete = questions.every((q) => {
    const value = valueFor(q.question);
    return Array.isArray(value)
      ? value.length > 0
      : typeof value === "string" && value.length > 0;
  });
  const answer = () => {
    if (!key || !complete) return;
    const merged: Record<string, string | string[]> = {};
    for (const q of questions) merged[q.question] = valueFor(q.question);
    void respondToQuestion(key, message.seq, merged);
  };
  const skip = () => {
    if (key) void respondToQuestion(key, message.seq, null);
  };
  /** Arrow-key row cycling across the current question's interactive rows. */
  const focusRow = (delta: 1 | -1) => {
    const rows = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>("[data-q-row]") ?? [],
    );
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[(at + delta + rows.length) % rows.length];
    next?.focus();
  };

  const value = picked[current.question];
  const btn =
    "inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-caption-1-medium transition-colors";
  const rowClass = (selected: boolean) =>
    `flex w-full cursor-pointer items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors focus-visible:ring-1 focus-visible:ring-button-primary focus-visible:outline-none ${
      selected ? "bg-background-tertiary-default" : "hover:bg-background-tertiary-hover"
    }`;

  return (
    <div ref={rootRef} className="flex w-full flex-col gap-2.5 text-left">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-md bg-background-tertiary-default px-1.5 py-0.5 text-caption-1-regular text-text-secondary">
          {current.header}
        </span>
        <span className="text-caption-1-medium text-text-primary">
          {current.question}
        </span>
        {current.multiSelect && (
          <span className="text-caption-1-regular text-text-tertiary">
            {t("chat.questionMultiTag")}
          </span>
        )}
        {questions.length > 1 && (
          <span className="ml-auto flex items-center gap-1 text-caption-1-regular text-text-tertiary">
            <button
              type="button"
              aria-label={t("chat.questionPrev")}
              onClick={() => setPage((p) => (p - 1 + questions.length) % questions.length)}
              className="flex cursor-pointer items-center rounded p-0.5 hover:bg-background-tertiary-hover"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </button>
            <span>
              {Math.min(page, questions.length - 1) + 1}/{questions.length}
            </span>
            <button
              type="button"
              aria-label={t("chat.questionNext")}
              onClick={() => setPage((p) => (p + 1) % questions.length)}
              className="flex cursor-pointer items-center rounded p-0.5 hover:bg-background-tertiary-hover"
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {current.options.map((opt) => {
          const selected = Array.isArray(value)
            ? value.includes(opt.label)
            : value === opt.label;
          return (
            <button
              key={opt.label}
              type="button"
              data-q-row
              role={current.multiSelect ? "checkbox" : "radio"}
              aria-checked={selected}
              onClick={() => pick(current.question, opt.label, Boolean(current.multiSelect))}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  focusRow(e.key === "ArrowDown" ? 1 : -1);
                }
              }}
              className={rowClass(selected)}
            >
              <span
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                  selected
                    ? "border-button-primary bg-button-primary text-text-white"
                    : "border-border-secondary"
                }`}
              >
                {selected && <Check className="size-3" aria-hidden />}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-caption-1-medium text-text-primary">
                  {opt.label}
                </span>
                {opt.description && (
                  <span className="text-caption-1-regular text-text-secondary">
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        {!current.multiSelect && (
          <input
            data-q-row
            value={other[current.question] ?? ""}
            onChange={(e) => {
              setOther((cur) => ({ ...cur, [current.question]: e.target.value }));
              // Typing a free-form answer supersedes any option pick.
              setPicked((cur) => ({ ...cur, [current.question]: "" }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                answer();
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                focusRow(e.key === "ArrowDown" ? 1 : -1);
              }
            }}
            placeholder={t("chat.questionOtherPlaceholder")}
            aria-label={t("chat.questionOther")}
            className="rounded-md border border-border-secondary bg-background-tertiary-default px-2.5 py-1.5 text-caption-1-regular text-text-primary outline-none placeholder:text-text-tertiary focus-visible:ring-1 focus-visible:ring-button-primary"
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption-1-regular text-text-tertiary">
          {t("chat.questionKeyboardHint")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={skip}
            className={`${btn} border border-border-secondary bg-background-secondary-default text-text-secondary hover:bg-background-tertiary-hover`}
          >
            {t("chat.questionSkip")}
          </button>
          <button
            type="button"
            disabled={!complete}
            onClick={answer}
            className={`${btn} bg-button-primary text-text-white disabled:cursor-not-allowed disabled:text-button-primary-disabled-foreground`}
          >
            {t("chat.questionSubmit")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Timeline record for a question: the interaction itself lives in the dock
 * that takes over the composer, so while pending this row is only a muted
 * placeholder; once settled it becomes the read-only history entry.
 */
export function QuestionRecord({ message }: { message: Message }) {
  const { t } = useTranslation();
  const question = message.question;
  if (!question) return null;
  const { status, questions } = question;
  return (
    <div className="flex max-w-[85%] flex-col gap-1 rounded-xl border border-border-secondary bg-background-secondary-default px-3.5 py-2.5 text-left">
      <div className="flex items-center gap-1.5 text-caption-1-medium text-text-secondary">
        <Check className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
        {t("chat.questionTitle")}
      </div>
      {status === "pending" && (
        <>
          <div className="text-caption-1-regular text-text-primary">
            {questions[0]?.question ?? ""}
          </div>
          <div className="text-caption-1-regular text-text-tertiary">
            {t("chat.questionWaiting")}
          </div>
        </>
      )}
      {status === "answered" && (
        <div className="flex flex-col gap-0.5 text-caption-1-regular text-text-secondary">
          {questions.map((q, qi) => {
            const value = question.answers?.[q.question];
            const shown = Array.isArray(value) ? value.join(", ") : value ?? "";
            return (
              <div key={qi} className="break-words">
                {q.question} → {shown}
              </div>
            );
          })}
        </div>
      )}
      {status === "dismissed" && (
        <div className="text-caption-1-regular text-text-tertiary">
          {t("chat.questionSkipped")}
        </div>
      )}
      {status === "cancelled" && (
        <div className="text-caption-1-regular text-text-tertiary">
          {t("chat.questionCancelled")}
        </div>
      )}
    </div>
  );
}
