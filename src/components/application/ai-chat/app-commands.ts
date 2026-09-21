import i18n from "@/lib/i18n";
import type { SlashCommandEntry } from "@/lib/ipc";
import { useSlashCommandStore } from "./slash-commands";

/**
 * App-level commands: bare slash inputs ccgui handles itself instead of
 * sending to the engine. The CLIs only interpret their native commands in
 * interactive TUI mode — headless/protocol launches (how ccgui runs them)
 * never see them, so the GUI provides the equivalent.
 *
 * A workspace/global catalog entry of the same name always wins: the user
 * defined that command for the CLI, and the CLI expands it — the app
 * shortcut is only the fallback when no such command exists.
 */
export type AppCommand = "new" | "compact";

/** Bare input → catalog key. `/clear` is an alias of `/new`: in-place
 *  clearing is a TUI feature no headless/protocol launch honors, and a new
 *  session is the same net effect. */
const APP_COMMAND_NAMES: Record<string, AppCommand> = {
  "/new": "new",
  "/clear": "new",
  "/compact": "compact",
};

export function matchAppCommand(
  value: string,
  workspacePath: string | null,
): AppCommand | null {
  const command = APP_COMMAND_NAMES[value.trim()];
  if (!command || !workspacePath) return command ?? null;
  const pickerName = value.trim().slice(1);
  const entries = useSlashCommandStore.getState().byRoot[workspacePath]?.entries;
  if (
    entries?.some(
      (entry) =>
        entry.kind === "command" && entry.name.toLowerCase() === pickerName,
    )
  ) {
    return null;
  }
  return command;
}

/** The `/` picker's built-in group: one row per app-level command. Rows are
 *  frontend-injected (the backend catalog never emits kind "app"). */
export function appCommandEntries(): SlashCommandEntry[] {
  return [
    {
      name: "new",
      description: i18n.t("chat.slashAppNew"),
      source: "app",
      kind: "app",
    },
    {
      name: "clear",
      description: i18n.t("chat.slashAppClear"),
      source: "app",
      kind: "app",
    },
    {
      name: "compact",
      description: i18n.t("chat.slashAppCompact"),
      source: "app",
      kind: "app",
    },
  ];
}

/** App rows for a picker query: same contains-filter as the catalog, minus
 *  any name a user-defined catalog command claims (precedence parity with
 *  the submit interception). */
export function matchAppCommands(
  entries: SlashCommandEntry[] | undefined,
  query: string,
): SlashCommandEntry[] {
  const q = query.trim().toLowerCase();
  return appCommandEntries().filter((entry) => {
    if (
      q &&
      !entry.name.toLowerCase().includes(q) &&
      !(entry.description ?? "").toLowerCase().includes(q)
    ) {
      return false;
    }
    return !entries?.some(
      (catalog) =>
        catalog.kind === "command" && catalog.name.toLowerCase() === entry.name,
    );
  });
}
