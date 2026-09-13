import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "@/utils/cx";
import { useGitStore } from "@/features/git/store";
import type { GitStatus, Message, TodoItem } from "@/lib/ipc";
import { useChatStore } from "../store";
import {
  deriveAgentTaskSteps,
  deriveEditedFiles,
  deriveTodoList,
  type AgentTaskStep,
} from "./agent-task-steps";

const EMPTY_MESSAGES: Message[] = [];

/**
 * Run-status strip above the composer, ported from the reference app's
 * Composer run-status interaction contract:
 *
 * - Data surfaces as dashed pills (子代理 / 已编辑) on a toolbar row, not
 *   stacked cards; the right edge holds a chrome toggle that hides the whole
 *   pill row (persisted in localStorage).
 * - Clicking a pill floats its panel ABOVE the strip (absolute, never pushes
 *   the message list). Single-open: clicking another pill switches, clicking
 *   the same pill or pressing Esc collapses.
 * - Pills never auto-hide after a turn completes — counts freeze until a
 *   newer turn contributes fresh data. A panel auto-collapses when its
 *   section's data disappears.
 * - The 已编辑 pill carries git line stats (+/−) aggregated over the files
 *   this session edited, sourced from the workspace git status.
 */

const CHROME_OPEN_KEY = "ccgui.chat.runStatusChromeOpen";

function readChromeOpen(): boolean {
  try {
    return localStorage.getItem(CHROME_OPEN_KEY) !== "0";
  } catch {
    return true; // storage unavailable (private mode) — default to open
  }
}

function writeChromeOpen(open: boolean) {
  try {
    localStorage.setItem(CHROME_OPEN_KEY, open ? "1" : "0");
  } catch {
    // preference simply doesn't persist
  }
}

type SectionId = "todo" | "subagent" | "files";

function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

interface FileStat {
  additions: number;
  deletions: number;
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Strip the workspace prefix; tool-call paths may be absolute while git
 * status paths are workspace-relative. */
function toWorkspaceRel(path: string, workspacePath: string): string {
  const norm = normalizeSlashes(path);
  const ws = normalizeSlashes(workspacePath).replace(/\/+$/, "");
  if (ws && norm.startsWith(ws + "/")) return norm.slice(ws.length + 1);
  return norm;
}

/** Match session-edited files against workspace git status and sum line
 * stats. One file may appear in several status lists (staged + unstaged) —
 * take the per-side max instead of double-counting. `total` is null when
 * nothing matched (non-repo / status not loaded yet) so stats stay hidden. */
function collectFileStats(
  files: string[],
  status: GitStatus | undefined,
  workspacePath: string,
): { perFile: Map<string, FileStat>; total: FileStat | null } {
  const perFile = new Map<string, FileStat>();
  if (!status) return { perFile, total: null };
  const byRel = new Map<string, FileStat>();
  for (const entry of [...status.staged, ...status.unstaged, ...status.untracked]) {
    const rel = normalizeSlashes(entry.path);
    const prev = byRel.get(rel);
    byRel.set(rel, {
      additions: Math.max(prev?.additions ?? 0, entry.additions ?? 0),
      deletions: Math.max(prev?.deletions ?? 0, entry.deletions ?? 0),
    });
  }
  const total: FileStat = { additions: 0, deletions: 0 };
  let matched = false;
  for (const file of files) {
    const stat = byRel.get(toWorkspaceRel(file, workspacePath));
    if (!stat) continue;
    matched = true;
    perFile.set(file, stat);
    total.additions += stat.additions;
    total.deletions += stat.deletions;
  }
  return { perFile, total: matched ? total : null };
}

function LineStats({ stat }: { stat: FileStat }) {
  return (
    <span className="tabular-nums">
      <span className="text-[var(--color-status-unseen)]">+{stat.additions}</span>{" "}
      <span className="text-text-error-primary">−{stat.deletions}</span>
    </span>
  );
}

function BotIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2v3M5.5 9h.01M10.5 9h.01" strokeLinecap="round" />
    </svg>
  );
}

function ListChecksIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h8M6 8h8M6 12h8" />
      <path d="M2 4l1 1 1.5-1.5M2 8l1 1 1.5-1.5M2 12l1 1 1.5-1.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="currentColor">
      <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 1.237-8.61 8.61a.25.25 0 0 0-.063.108l-.62 2.168 2.168-.62a.25.25 0 0 0 .108-.064l8.61-8.61a.25.25 0 0 0 0-.354l-1.086-1.086a.25.25 0 0 0-.354 0Z" />
    </svg>
  );
}

function PanelTopIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M2 6h12" />
    </svg>
  );
}

function PanelTopCloseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M2 6h12M6.5 12.5 8 11l1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BreathingDot({
  active = true,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  if (!active) {
    return (
      <span
        aria-hidden="true"
        className={cx("inline-flex size-2.5 shrink-0 items-center justify-center", className)}
      >
        <span className="size-1.5 rounded-full bg-[var(--color-status-unseen)]" />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cx("relative inline-flex size-2.5 shrink-0 items-center justify-center", className)}
    >
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75 duration-1000" />
      <span className="relative inline-flex size-1.5 rounded-full bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.9)]" />
    </span>
  );
}

function Pill({
  selected,
  running,
  label,
  count,
  stats,
  title,
  onClick,
  icon,
}: {
  selected: boolean;
  running?: boolean;
  label: string;
  count?: string;
  stats?: React.ReactNode;
  title?: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      title={title}
      onClick={onClick}
      className={cx(
        "flex h-[26px] cursor-pointer items-center gap-1.5 rounded-[5px] border border-dashed px-2 text-caption-1-medium transition-colors duration-150",
        selected
          ? "border-foreground-icon-secondary bg-background-tertiary-default/60 text-text-primary"
          : "border-border-button-default text-text-secondary hover:bg-background-tertiary-default/60",
      )}
    >
      {running && <BreathingDot active={true} className="mr-0.5" />}
      {icon}
      <span>{label}</span>
      {count ? <span className="tabular-nums text-text-tertiary">{count}</span> : null}
      {stats}
    </button>
  );
}

function TodoRows({ items }: { items: TodoItem[] }) {
  const { t } = useTranslation();
  const statusText: Record<TodoItem["status"], string> = {
    pending: t("chat.todoStatusPending"),
    active: t("chat.agentStatusRunning"),
    complete: t("chat.agentStatusDone"),
    blocked: t("chat.todoStatusBlocked"),
    dropped: "",
  };
  return (
    <ul className="flex flex-col gap-0.5 p-1" data-testid="run-status-todos">
      {items.map((item) => (
        <li
          key={item.content}
          className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1.5"
        >
          {item.status === "complete" ? (
            <svg aria-hidden viewBox="0 0 14 14" className="size-3.5">
              <circle cx="7" cy="7" r="7" fill="var(--color-status-unseen)" />
              <path d="M4 7.5 5.646 9.146a.5.5 0 0 0 .708 0L10 5.5" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          ) : item.status === "active" ? (
            <span className="grid size-3.5 place-items-center">
              <BreathingDot active={true} />
            </span>
          ) : item.status === "blocked" ? (
            <span className="grid size-3.5 place-items-center">
              <span className="size-1.5 rounded-full bg-text-error-primary" />
            </span>
          ) : (
            <span className="size-3.5 rounded-full border border-dashed border-border-checkbox-default" />
          )}
          <span
            className={cx(
              "truncate text-caption-1-medium",
              item.status === "complete" ? "text-text-tertiary" : "text-text-primary",
            )}
            title={item.content}
          >
            {item.content}
          </span>
          <span
            className={cx(
              "text-caption-2-medium",
              item.status === "complete"
                ? "text-[var(--color-status-unseen)]"
                : item.status === "blocked"
                  ? "text-text-error-primary"
                  : item.status === "active"
                    ? "text-blue-500 font-medium"
                    : "text-text-secondary",
            )}
          >
            {statusText[item.status]}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BackIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 4 6 8l3.5 4" />
    </svg>
  );
}

/** One agent's full assignment, overlaid on the list inside the same panel:
 *  task briefs run long, and leaving the strip to read one loses the panel. */
function SubagentDetail({ step, onBack }: { step: AgentTaskStep; onBack: () => void }) {
  const { t } = useTranslation();
  const complete = step.state === "complete";
  return (
    <div data-testid="subagent-detail-overlay" className="flex flex-col gap-1 p-1">
      <div className="flex items-center gap-1.5 px-1">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("chat.agentDetailBack")}
          title={t("chat.agentDetailBack")}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-foreground-icon-tertiary hover:bg-background-tertiary-hover hover:text-foreground-icon-primary"
        >
          <BackIcon />
        </button>
        <div className="flex min-w-0 items-center gap-1.5">
          {step.subagentType && (
            <span className="shrink-0 rounded border border-border-button-default bg-background-tertiary-default px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">
              {step.subagentType}
            </span>
          )}
          <span className="truncate text-caption-1-medium text-text-primary">{step.label}</span>
        </div>
        <span
          className={cx(
            "ml-auto shrink-0 text-caption-2-medium",
            complete ? "text-[var(--color-status-unseen)]" : "font-medium text-blue-500",
          )}
        >
          {complete ? t("chat.agentStatusDone") : t("chat.agentStatusRunning")}
        </span>
      </div>
      <pre className="max-h-52 overflow-y-auto rounded bg-background-secondary-default px-2 py-1.5 text-caption-1-medium break-words whitespace-pre-wrap text-text-secondary">
        {step.detail ?? step.label}
      </pre>
    </div>
  );
}

function SubagentRows({ steps }: { steps: AgentTaskStep[] }) {
  const { t } = useTranslation();
  // Open detail lives here, not in the strip: closing the panel unmounts this
  // component, so reopening always starts on the list.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = openKey ? steps.find((step) => step.key === openKey) : undefined;
  if (open) return (
    <div data-testid="run-status-subagents">
      <SubagentDetail step={open} onBack={() => setOpenKey(null)} />
    </div>
  );
  return (
    <div data-testid="run-status-subagents">
      <ul className="flex flex-col gap-0.5 p-1">
        {steps.map((step) => {
          const complete = step.state === "complete";
          return (
            <li key={step.key}>
              <button
                type="button"
                data-agent-step-key={step.key}
                onClick={() => setOpenKey(step.key)}
                title={step.detail ? `${step.label}\n${step.detail}` : step.label}
                className="grid w-full cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-background-tertiary-default/50"
              >
                <div className="flex items-center justify-center">
                  <BreathingDot active={!complete} />
                </div>
                <div className="flex min-w-0 items-center gap-1.5">
                  {step.subagentType && (
                    <span className="shrink-0 rounded border border-border-button-default bg-background-tertiary-default px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">
                      {step.subagentType}
                    </span>
                  )}
                  <span
                    className={cx(
                      "truncate text-caption-1-medium",
                      complete ? "text-text-secondary" : "text-text-primary",
                    )}
                  >
                    {step.label}
                  </span>
                </div>
                <span
                  className={cx(
                    "text-caption-2-medium flex shrink-0 items-center gap-1",
                    complete
                      ? "text-[var(--color-status-unseen)]"
                      : "font-medium text-blue-500",
                  )}
                >
                  {complete ? t("chat.agentStatusDone") : t("chat.agentStatusRunning")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FileRows({
  files,
  perFile,
  total,
  live,
}: {
  files: string[];
  perFile: Map<string, FileStat>;
  total: FileStat | null;
  live: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="run-status-files">
      <div className="flex h-8 items-center gap-1.5 px-2.5 text-caption-1-medium text-text-secondary">
        <span>{t("chat.editedFiles", { count: files.length })}</span>
        {total ? <LineStats stat={total} /> : null}
        {live ? (
          <span className="size-1.5 animate-pulse rounded-full bg-foreground-icon-secondary" />
        ) : null}
      </div>
      <ul className="flex flex-col gap-0.5 px-1 pb-1">
        {files.map((file) => {
          const stat = perFile.get(file);
          return (
            <li
              key={file}
              title={file}
              className="flex h-7 items-center gap-2 rounded px-2 text-caption-1-medium"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-background-quaternary-default" />
              <span className="min-w-0 flex-1 truncate text-text-primary">{baseName(file)}</span>
              {stat && <LineStats stat={stat} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Floating panel anchored above the toolbar so it overlays the message
 * list instead of pushing it; collapses via grid-rows animation. */
function RunStatusPanel({
  section,
  steps,
  todos,
  files,
  perFile,
  total,
  live,
}: {
  section: SectionId | null;
  steps: AgentTaskStep[];
  todos: TodoItem[];
  files: string[];
  perFile: Map<string, FileStat>;
  total: FileStat | null;
  live: boolean;
}) {
  return (
    <div
      className={cx(
        "absolute inset-x-0 bottom-full z-20 grid transition-[grid-template-rows,opacity] duration-200 ease-out",
        section ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          role="tabpanel"
          className="mb-1.5 max-h-[min(40vh,280px)] overflow-y-auto rounded-md border border-dashed border-border-button-default bg-background-primary-default shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
        >
          {section === "subagent" && <SubagentRows steps={steps} />}
          {section === "todo" && <TodoRows items={todos} />}
          {section === "files" && (
            <FileRows files={files} perFile={perFile} total={total} live={live} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The dashed pill row: one pill per data section, hidden entirely when the
 * section has no data. Counts freeze after a turn completes. */
function RunStatusPills({
  section,
  steps,
  todos,
  files,
  stats,
  onToggle,
}: {
  section: SectionId | null;
  steps: AgentTaskStep[];
  todos: TodoItem[];
  files: string[];
  stats: FileStat | null;
  onToggle: (id: SectionId) => void;
}) {
  const { t } = useTranslation();
  const completedCount = steps.filter((step) => step.state === "complete").length;
  const anyRunning = completedCount < steps.length;
  const todosDone = todos.filter((item) => item.status === "complete").length;
  const todosRunning = todos.some((item) => item.status === "active");
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="tablist">
      {todos.length > 0 && (
        <Pill
          selected={section === "todo"}
          running={todosRunning}
          label={t("chat.todoPill")}
          count={`${todosDone}/${todos.length}`}
          icon={<ListChecksIcon />}
          onClick={() => onToggle("todo")}
        />
      )}
      {steps.length > 0 && (
        <Pill
          selected={section === "subagent"}
          running={anyRunning}
          label={t("chat.subagentPill")}
          count={`${completedCount}/${steps.length}`}
          icon={<BotIcon />}
          onClick={() => onToggle("subagent")}
        />
      )}
      {files.length > 0 && (
        <Pill
          selected={section === "files"}
          label={t("chat.editedPill")}
          title={t("chat.editedFiles", { count: files.length })}
          icon={<PencilIcon />}
          stats={stats ? <LineStats stat={stats} /> : undefined}
          onClick={() => onToggle("files")}
        />
      )}
    </div>
  );
}

/** Right-edge chrome toggle: hides/shows the whole pill row. */
function ChromeToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const label = open ? t("chat.runStatusCollapse") : t("chat.runStatusExpand");
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-[5px] border border-dashed border-border-button-default text-foreground-icon-tertiary transition-colors hover:bg-background-tertiary-default/60 hover:text-foreground-icon-secondary"
    >
      {open ? <PanelTopCloseIcon /> : <PanelTopIcon />}
    </button>
  );
}

export const RunStatusStrip = memo(function RunStatusStrip({
  sessionKey,
  engine,
  workspacePath,
}: {
  sessionKey: string;
  engine: string;
  workspacePath: string;
}) {
  const messages = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const subagentHistory = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.subagentHistory ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const streaming = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.streaming ?? false) : false,
  );
  const steps = useMemo(
    () => deriveAgentTaskSteps(
      subagentHistory.length ? [...subagentHistory, ...messages] : messages,
      streaming,
      engine,
    ),
    [subagentHistory, messages, streaming, engine],
  );
  const files = useMemo(() => deriveEditedFiles(messages), [messages]);
  const todos = useMemo(() => deriveTodoList(messages), [messages]);

  // git line stats for the 已编辑 pill; force-refresh when the turn settles.
  const gitStatus = useGitStore((s) =>
    workspacePath ? s.statusByWorkspace[workspacePath] : undefined,
  );
  const refreshGit = useGitStore((s) => s.refresh);
  useEffect(() => {
    if (!workspacePath || files.length === 0) return;
    void refreshGit(workspacePath, !streaming).catch(() => undefined);
  }, [workspacePath, streaming, files.length, refreshGit]);
  const { perFile, total } = useMemo(
    () => collectFileStats(files, gitStatus, workspacePath),
    [files, gitStatus, workspacePath],
  );

  const [chromeOpen, setChromeOpen] = useState(readChromeOpen);
  const [section, setSection] = useState<SectionId | null>(null);

  // A section whose data vanished collapses itself.
  // Render-time adjustment (React re-renders before paint): an effect would
  // flash the stale panel for a frame first.
  const sectionData: Record<SectionId, number> = {
    todo: todos.length,
    subagent: steps.length,
    files: files.length,
  };
  if (section && sectionData[section] === 0) setSection(null);

  // Esc collapses the open panel.
  useEffect(() => {
    if (!section) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section]);

  if (steps.length === 0 && files.length === 0 && todos.length === 0) return null;

  const toggleSection = (id: SectionId) =>
    setSection((current) => (current === id ? null : id));
  const toggleChrome = () => {
    setSection(null);
    const next = !chromeOpen;
    writeChromeOpen(next);
    setChromeOpen(next);
  };

  return (
    <div className="relative" data-testid="run-status-strip">
      <RunStatusPanel
        section={section}
        steps={steps}
        todos={todos}
        files={files}
        perFile={perFile}
        total={total}
        live={streaming}
      />
      <div className="flex min-h-7 items-center gap-1.5">
        {chromeOpen ? (
          <RunStatusPills
            section={section}
            steps={steps}
            todos={todos}
            files={files}
            stats={total}
            onToggle={toggleSection}
          />
        ) : (
          <div className="flex-1" />
        )}
        <ChromeToggle open={chromeOpen} onToggle={toggleChrome} />
      </div>
    </div>
  );
});
