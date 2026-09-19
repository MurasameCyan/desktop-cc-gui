import { lazy, Suspense } from "react";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { CenteredSpinner } from "@/components/base/empty-state";
import { BrowserPane, useBrowserNavSync } from "@/features/browser/BrowserPane";
import type { BrowserTab } from "@/features/browser/store";
import { DiffView } from "@/features/git/DiffView";
import type { DiffTarget } from "@/features/git/store";
import type { EngineInfo, GitStatus, Workspace } from "@/lib/ipc";
import { cx } from "@/utils/cx";
import { ChatConversation } from "./components/ChatConversation";
import type { ActiveSession } from "./store";

// CodeMirror + react-markdown are heavy; split them out of the startup chunk.
const EditorPane = lazy(() => import("@/features/files/EditorPane"));

/** Center tab content: the chat conversation, open file editors, and the
 * changes diff, stacked so only the active surface is visible. The inactive
 * surfaces stay mounted but invisible (never display:none) so WKWebView
 * keeps its scroll boxes and editor drafts alive — see the virtualizer note
 * in FileTree. */
export function ChatCenterPane({
  active,
  engines,
  workspaces,
  startNewChat,
  composerInputRef,
  openFiles,
  activeFilePath,
  browserTabs,
  activeBrowserId,
  diffView,
  diffStatus,
  closeDiff,
}: {
  active: ActiveSession | null;
  engines: EngineInfo[];
  workspaces: Workspace[];
  startNewChat: (workspacePath: string) => void;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
  openFiles: string[];
  activeFilePath: string | null;
  /** Open browser tabs and the one in view (mutually exclusive with
   *  activeFilePath; use-chat-tabs enforces it). */
  browserTabs: BrowserTab[];
  activeBrowserId: string | null;
  diffView: { workspacePath: string; target: DiffTarget } | null;
  diffStatus: GitStatus | undefined;
  closeDiff: () => void;
}) {
  // Native nav/title events → store, mounted once while this pane lives.
  useBrowserNavSync();
  const browserInView = activeBrowserId !== null && !diffView;
  return (
    <>
      <div
        className={cx(
          "flex min-w-0 flex-col overflow-hidden bg-background-primary-default",
          activeFilePath || browserInView || diffView
            ? "invisible absolute inset-0"
            : "relative min-w-0 flex-1 basis-0",
        )}
      >
        <ChatConversation
          active={active}
          engines={engines}
          workspaces={workspaces}
          startNewChat={startNewChat}
          composerInputRef={composerInputRef}
        />
      </div>

      {openFiles.length > 0 && (
        <div
          className={cx(
            "flex min-w-0 flex-col overflow-hidden bg-background-primary-default",
            activeFilePath && !browserInView && !diffView
              ? "relative min-w-0 flex-1 basis-0"
              : "invisible absolute inset-0",
          )}
        >
          <Suspense fallback={<CenteredSpinner />}>
            {openFiles.map((path) => (
              <div
                key={path}
                className={cx(
                  "min-h-0 flex-col",
                  path === activeFilePath
                    ? "flex flex-1"
                    : "invisible absolute inset-0",
                )}
              >
                <EditorPane path={path} />
              </div>
            ))}
          </Suspense>
        </div>
      )}

      {/* Browser tabs: one pane per tab, each owning a native child webview
          painted over its placeholder rect (see BrowserPane). */}
      {browserTabs.length > 0 && (
        <div
          className={cx(
            "flex min-w-0 flex-col overflow-hidden bg-background-primary-default",
            browserInView
              ? "relative min-w-0 flex-1 basis-0"
              : "invisible absolute inset-0",
          )}
        >
          {browserTabs.map((tab) => (
            <div
              key={tab.id}
              className={cx(
                "min-h-0 flex-col",
                tab.id === activeBrowserId
                  ? "flex flex-1"
                  : "invisible absolute inset-0",
              )}
            >
              <BrowserPane tab={tab} active={browserInView && tab.id === activeBrowserId} />
            </div>
          ))}
        </div>
      )}

      {/* Center diff, opened from the changes panel's file rows. Its tab
          sits in the strip; ← or closing the tab returns to the chat. */}
      {diffView && (
        <div className="relative flex min-w-0 flex-1 basis-0 flex-col overflow-hidden bg-background-primary-default">
          <DiffView
            workspacePath={diffView.workspacePath}
            target={diffView.target}
            status={diffStatus}
            onBack={closeDiff}
          />
        </div>
      )}
    </>
  );
}
