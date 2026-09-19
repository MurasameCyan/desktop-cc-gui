import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileIndexResult } from "@/lib/ipc";
import {
  matchMentionEntries,
  pruneMentionIndex,
  useMentionIndexStore,
} from "./mention-files";

const mocks = vi.hoisted(() => ({
  listFileIndex: vi.fn<() => Promise<FileIndexResult>>(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));

const ROOT = "S:/workspace";

afterEach(() => {
  pruneMentionIndex(ROOT);
  mocks.listFileIndex.mockReset();
});

describe("mention file index", () => {
  it("keeps capped index entries searchable by mentions", async () => {
    mocks.listFileIndex.mockResolvedValue({
      entries: [
        { rel: "src/App.tsx", isDir: false },
        { rel: "README.md", isDir: false },
        { rel: "src", isDir: true },
      ],
      truncated: true,
    });

    useMentionIndexStore.getState().ensure(ROOT);
    await vi.waitFor(() => {
      expect(useMentionIndexStore.getState().byRoot[ROOT]?.status).toBe("ready");
    });
    const { entries } = useMentionIndexStore.getState().byRoot[ROOT];

    expect(matchMentionEntries(entries, ROOT, "").map((entry) => entry.rel)).toEqual([
      "README.md",
      "src",
      "src/App.tsx",
    ]);
    expect(matchMentionEntries(entries, ROOT, `${ROOT}/SRC/APP`).map((entry) => entry.rel)).toEqual([
      "src/App.tsx",
    ]);
  });
});
