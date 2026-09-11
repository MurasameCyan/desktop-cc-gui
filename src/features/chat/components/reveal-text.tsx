import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { StreamReveal, createVisibleTextReader } from "./stream-reveal";

/** Only the text runs crossing the reveal cursor rerender each frame.
 * Markdown parsing, code highlighting and the timeline stay out of this loop.
 */
export const RevealText = memo(function RevealText({ controller, start, children, windowSize }: {
  controller: StreamReveal;
  start: number;
  children: string;
  windowSize?: number;
}) {
  const subscribe = useCallback((notify: () => void) => controller.subscribe(start, children.length, notify), [controller, start, children.length]);
  const snapshot = useCallback(() => controller.read(start, children.length), [controller, start, children.length]);
  const count = useSyncExternalStore(subscribe, snapshot, () => children.length);
  const reader = useMemo(() => createVisibleTextReader(children), [children]);
  return <span>{windowSize ? reader.window(count, windowSize) : reader.prefix(count)}</span>;
});
