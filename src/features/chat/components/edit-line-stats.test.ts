import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/ipc";
import { countEditLines, deriveEditLineStats } from "./edit-line-stats";

function editRow(seq: number, path: string, args: unknown, text = "edit · Applying"): Message {
  return { seq, role: "tool", text, ts: null, path, args } as Message;
}

describe("countEditLines", () => {
  it("counts +/- rows of a unified patch", () => {
    const stat = countEditLines({
      file_path: "src/a.ts",
      patch: "@@ -1,4 +1,5 @@\n ctx\n-gone\n-also gone\n+fresh\n+more\n+tail\n ctx2",
    });
    expect(stat).toEqual({ additions: 3, deletions: 2 });
  });

  it("counts the changed span of an old/new string pair, ignoring common context", () => {
    const stat = countEditLines({
      old_string: "keep\nold one\nold two\ntail",
      new_string: "keep\nnew one\ntail",
    });
    expect(stat).toEqual({ additions: 1, deletions: 2 });
  });

  it("counts a whole-file content write as pure additions", () => {
    expect(countEditLines({ path: "src/new.ts", content: "a\nb\nc" })).toEqual({
      additions: 3,
      deletions: 0,
    });
  });

  it("prefers the patch over the string pair, matching the diff viewer", () => {
    const stat = countEditLines({
      patch: "@@ -1 +1 @@\n-x\n+y",
      old_string: "1\n2\n3\n4\n5",
      new_string: "",
    });
    expect(stat).toEqual({ additions: 1, deletions: 1 });
  });

  it("returns null when the args carry no edit payload", () => {
    expect(countEditLines({ file_path: "src/a.ts", offset: 10 })).toBeNull();
    expect(countEditLines(undefined)).toBeNull();
    expect(countEditLines("edit src/a.ts")).toBeNull();
  });
});

describe("deriveEditLineStats", () => {
  it("counts gitignored paths git status never reports", () => {
    const stats = deriveEditLineStats([
      editRow(1, ".omp/docs/x.md", { old_string: "one\ntwo", new_string: "uno" }),
    ]);
    expect(stats.get(".omp/docs/x.md")).toEqual({ additions: 1, deletions: 2 });
  });

  it("accumulates repeated edits of one path instead of the last winning", () => {
    const stats = deriveEditLineStats([
      editRow(1, "src/a.ts", { content: "a\nb" }),
      editRow(2, "src/a.ts", { old_string: "x\ny\nz", new_string: "" }),
      editRow(3, "src/a.ts", { patch: "@@ -1 +1,2 @@\n+p\n+q" }),
    ]);
    expect(stats.get("src/a.ts")).toEqual({ additions: 4, deletions: 3 });
  });

  it("ignores non-file targets carrying a URI scheme", () => {
    const stats = deriveEditLineStats([
      editRow(1, "xd://ast_edit", { content: "a\nb\nc" }),
      editRow(2, "src/a.ts", { content: "a" }),
    ]);
    expect([...stats.keys()]).toEqual(["src/a.ts"]);
  });

  it("skips rows that are not edit-class tools", () => {
    const stats = deriveEditLineStats([
      editRow(1, "src/a.ts", { content: "a\nb" }, "read · Reading the file"),
      { seq: 2, role: "assistant", text: "write", ts: null } as Message,
    ]);
    expect(stats.size).toBe(0);
  });
});
