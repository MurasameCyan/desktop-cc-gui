import { describe, expect, it } from "vitest";
import {
  EMPTY_ATTACHMENTS,
  moveComposerAttachments,
  withoutComposerAttachments,
  type ComposerAttachmentsByKey,
} from "./attachments";

function slice(images: string[], error: string | null = null) {
  return {
    images,
    previews: Object.fromEntries(
      images.map((path) => [path, { url: `data:image/png;base64,AA==`, name: path }]),
    ),
    error,
  };
}

describe("moveComposerAttachments", () => {
  it("moves a pending tab's chips to its native session key", () => {
    const pending = "new:claude:/tmp/ws";
    const native = "claude/s-1";
    const rec: ComposerAttachmentsByKey = { [pending]: slice(["/tmp/a.png"]) };

    const next = moveComposerAttachments(rec, pending, native);

    expect(next[pending]).toBeUndefined();
    expect(next[native]?.images).toEqual(["/tmp/a.png"]);
    expect(next[native]?.previews["/tmp/a.png"]).toBeTruthy();
  });

  it("keeps the destination's own chips and never duplicates a path", () => {
    const next = moveComposerAttachments(
      {
        "claude/pending": slice(["/tmp/a.png", "/tmp/b.png"]),
        "claude/s-1": slice(["/tmp/a.png", "/tmp/c.png"]),
      },
      "claude/pending",
      "claude/s-1",
    );

    expect(next["claude/s-1"]?.images).toEqual([
      "/tmp/a.png",
      "/tmp/c.png",
      "/tmp/b.png",
    ]);
  });

  it("is a no-op for a same-key migration and for an empty source", () => {
    const rec: ComposerAttachmentsByKey = { "claude/s-1": slice(["/tmp/a.png"]) };
    expect(moveComposerAttachments(rec, "claude/s-1", "claude/s-1")).toBe(rec);

    const empty: ComposerAttachmentsByKey = {
      "claude/pending": { ...EMPTY_ATTACHMENTS },
    };
    expect(moveComposerAttachments(empty, "claude/pending", "claude/s-1")).toBe(empty);
  });
});

describe("withoutComposerAttachments", () => {
  it("drops the dead session and keeps the record reference otherwise", () => {
    const rec: ComposerAttachmentsByKey = {
      "claude/s-1": slice(["/tmp/a.png"]),
      "claude/s-2": slice(["/tmp/b.png"]),
    };
    const next = withoutComposerAttachments(rec, ["claude/s-1"]);
    expect(next["claude/s-1"]).toBeUndefined();
    expect(next["claude/s-2"]?.images).toEqual(["/tmp/b.png"]);

    const untouched = withoutComposerAttachments(rec, ["claude/missing"]);
    expect(untouched).toBe(rec);
  });
});
