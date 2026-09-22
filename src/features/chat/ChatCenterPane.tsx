import { lazy, Suspense, type ReactNode } from "react";
import { centerTabRegistry, pluginIdFromRegistryKey, useRegistry } from "@ccgui/plugin-sdk";
import { PluginBoundary } from "@/features/plugins/boundary/PluginBoundary";
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

/** One stacked center surface: invisible surfaces stay mounted (never
 * display:none) so WKWebView keeps its scroll boxes and editor drafts
 * alive — see the virtualizer note in FileTree. */
function Surface({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <div
      className={cx(
        "flex min-w-0 flex-col overflow-hidden bg-background-primary-default",
        visible ? "relative min-w-0 flex-1 basis-0" : "invisible absolute inset-0",
      )}
    >
      {children}
    </div>
  );
}

/** One keep-alive item inside a surface; only the active item is laid out. */
function SurfaceItem({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className={cx("min-h-0 flex-col", active ? "flex flex-1" : "invisible absolute inset-0")}>
      {children}
    </div>
  );
}

/** One plugin center tab (SDK 0.3.12 ui:center-tab): renders its registered
 * component inside a plugin-scoped crash boundary. Stale ids (plugin
 * unloaded with a tab open) render nothing. */
function PluginCenterTab({ tabId, active }: { tabId: string; active: boolean }) {
  const centerTabDefs = useRegistry(centerTabRegistry);
  const def = centerTabDefs.find((d) => d.id === tabId);
  if (!def) return null;
  const TabComponent = def.component;
  return (
    <SurfaceItem active={active}>
      <PluginBoundary pluginId={pluginIdFromRegistryKey(tabId)}>
        <TabComponent />
      </PluginBoundary>
    </SurfaceItem>
  );
}

/** Center tab content: the chat conversation, open file editors, and the
 * changes diff, stacked so only the active surface is visible. */
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
  pluginTabs,
  activePluginTabId,
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
  /** Open plugin center tabs (registry ids) and the one in view (mutually
   *  exclusive with the other surfaces; use-chat-tabs enforces it). */
  pluginTabs: string[];
  activePluginTabId: string | null;
  diffView: { workspacePath: string; target: DiffTarget } | null;
  diffStatus: GitStatus | undefined;
  closeDiff: () => void;
}) {
  // Native nav/title events → store, mounted once while this pane lives.
  useBrowserNavSync();
  const browserInView = activeBrowserId !== null && !diffView;
  const pluginInView = activePluginTabId !== null && !diffView;
  return (
    <>
      <Surface visible={!(activeFilePath || browserInView || pluginInView || diffView)}>
        <ChatConversation
          active={active}
          engines={engines}
          workspaces={workspaces}
          startNewChat={startNewChat}
          composerInputRef={composerInputRef}
        />
      </Surface>

      {openFiles.length > 0 && (
        <Surface visible={activeFilePath !== null && !browserInView && !pluginInView && !diffView}>
          <Suspense fallback={<CenteredSpinner />}>
            {openFiles.map((path) => (
              <SurfaceItem key={path} active={path === activeFilePath}>
                <EditorPane path={path} />
              </SurfaceItem>
            ))}
          </Suspense>
        </Surface>
      )}

      {/* Browser tabs: one pane per tab, each owning a native child webview
          painted over its placeholder rect (see BrowserPane). */}
      {browserTabs.length > 0 && (
        <Surface visible={browserInView}>
          {browserTabs.map((tab) => (
            <SurfaceItem key={tab.id} active={tab.id === activeBrowserId}>
              <BrowserPane tab={tab} active={browserInView && tab.id === activeBrowserId} />
            </SurfaceItem>
          ))}
        </Surface>
      )}

      {/* Plugin center tabs: one pane per open tab, keep-alive like the
          other surfaces. */}
      {pluginTabs.length > 0 && (
        <Surface visible={pluginInView}>
          {pluginTabs.map((tabId) => (
            <PluginCenterTab key={tabId} tabId={tabId} active={tabId === activePluginTabId} />
          ))}
        </Surface>
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
