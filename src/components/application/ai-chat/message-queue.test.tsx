import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { MessageQueue } from "./message-queue";

// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const QUEUE = [
  { id: "q-1", text: "第一条", images: [], queuedAt: 0 },
  { id: "q-2", text: "第二条", images: [], queuedAt: 1 },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function render(props: Partial<Parameters<typeof MessageQueue>[0]> = {}) {
  return act(async () => {
    root.render(
      <MessageQueue queue={QUEUE} onRemove={() => {}} {...props} />,
    );
  });
}

describe("MessageQueue", () => {
  it("offers send-now per row and reports the row it belongs to", async () => {
    const onSendNow = vi.fn();
    await render({ onSendNow });

    const rows = [...container.querySelectorAll("button[aria-label='发送']")];
    expect(rows).toHaveLength(2);

    // Newest first: the top row is the second message.
    await act(async () => {
      rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSendNow).toHaveBeenCalledWith("q-2");
  });

  it("leaves the row actions out when the caller cannot send now", async () => {
    await render();

    expect(container.querySelectorAll("button[aria-label='发送']")).toHaveLength(0);
    expect(container.querySelectorAll("button[aria-label='移出队列']")).toHaveLength(2);
  });
});
