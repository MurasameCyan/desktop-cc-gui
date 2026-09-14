import type {
  AfterTurnEvent,
  BeforeTurnEvent,
  BeforeTurnResult,
  Disposer,
  InternalMessageCapture,
  InternalMessageEvent,
  NormalizedRuntimeEvent,
  PromptContribution,
  RuntimeSwitchEvent,
  RuntimeSwitchHooks,
  SessionClosedEvent,
  SessionCreatedEvent,
  SessionHooks,
  SessionRestoredEvent,
  TurnHooks,
} from "@ccgui/plugin-sdk";

const DEFAULT_BEFORE_HOOK_TIMEOUT_MS = 2_000;
const DEFAULT_PROMPT_CONTRIBUTION_MAX_BYTES = 12 * 1024;
/// Largest internal-frame payload the host will ever hide. Mirrors the Rust
/// `MAX_RECORDED_FRAME_BYTES`: a frame the backend refuses to record an
/// identity for must not be hidden live either, or it reappears on reload.
const MAX_INTERNAL_CAPTURE_BYTES = 64 * 1024;

interface RegisteredHooks<T> {
  pluginId: string;
  hooks: T;
}

export interface RegisteredInternalMessageCapture {
  pluginId: string;
  capture: InternalMessageCapture;
}

export interface CollectedBeforeTurnResult {
  promptContributions: PromptContribution[];
  internalMessageCaptures: RegisteredInternalMessageCapture[];
}

export interface BeforeHookOptions {
  timeoutMs?: number;
}

export interface BeforeTurnOptions extends BeforeHookOptions {
  maxBytes?: number;
}

const sessionRegistrations: Array<RegisteredHooks<SessionHooks>> = [];
const turnRegistrations: Array<RegisteredHooks<TurnHooks>> = [];
const switchRegistrations: Array<RegisteredHooks<RuntimeSwitchHooks>> = [];
const encoder = new TextEncoder();
const confirmedContributions = new WeakSet<PromptContribution>();

interface HookGeneration {
  generation: number;
  cancel: () => void;
}

const turnGenerations = new Map<string, HookGeneration>();
const switchGenerations = new Map<string, HookGeneration>();

function register<T>(registrations: Array<RegisteredHooks<T>>, pluginId: string, hooks: T): Disposer {
  const entry = { pluginId, hooks };
  registrations.push(entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = registrations.indexOf(entry);
    if (index >= 0) registrations.splice(index, 1);
  };
}

export function registerSessionHooks(pluginId: string, hooks: SessionHooks): Disposer {
  return register(sessionRegistrations, pluginId, hooks);
}

export function registerTurnHooks(pluginId: string, hooks: TurnHooks): Disposer {
  return register(turnRegistrations, pluginId, hooks);
}

export function registerRuntimeSwitchHooks(pluginId: string, hooks: RuntimeSwitchHooks): Disposer {
  return register(switchRegistrations, pluginId, hooks);
}

function reportHookError(pluginId: string, hookName: string, error: unknown): void {
  console.error(`[plugins] ${pluginId} ${hookName} hook failed`, error);
}

function dispatchNonBlocking<T>(
  registrations: Array<RegisteredHooks<T>>,
  hookName: string,
  getHook: (hooks: T) => ((event: never) => void | Promise<void>) | undefined,
  event: unknown,
): void {
  for (const { pluginId, hooks } of [...registrations]) {
    const hook = getHook(hooks);
    if (!hook) continue;
    queueMicrotask(() => {
      try {
        void Promise.resolve(hook(event as never)).catch((error: unknown) =>
          reportHookError(pluginId, hookName, error),
        );
      } catch (error) {
        reportHookError(pluginId, hookName, error);
      }
    });
  }
}

export function dispatchSessionCreated(event: SessionCreatedEvent): void {
  dispatchNonBlocking(sessionRegistrations, "onCreated", ({ onCreated }) => onCreated, event);
}

export function dispatchSessionRestored(event: SessionRestoredEvent): void {
  dispatchNonBlocking(sessionRegistrations, "onRestored", ({ onRestored }) => onRestored, event);
}

export function dispatchSessionClosed(event: SessionClosedEvent): void {
  dispatchNonBlocking(sessionRegistrations, "onClosed", ({ onClosed }) => onClosed, event);
}

export function dispatchRuntimeEvent(event: NormalizedRuntimeEvent): void {
  dispatchNonBlocking(turnRegistrations, "onRuntimeEvent", ({ onRuntimeEvent }) => onRuntimeEvent, event);
}

export function dispatchAfterTurn(event: AfterTurnEvent): void {
  dispatchNonBlocking(turnRegistrations, "afterTurn", ({ afterTurn }) => afterTurn, event);
}

export function dispatchInternalMessage(pluginId: string, event: InternalMessageEvent): void {
  const registrations = turnRegistrations.filter((entry) => entry.pluginId === pluginId);
  if (registrations.length === 0) return;
  dispatchNonBlocking(
    registrations,
    "onInternalMessage",
    ({ onInternalMessage }) => onInternalMessage,
    event,
  );
}

export function dispatchAfterSwitch(event: RuntimeSwitchEvent): void {
  dispatchNonBlocking(switchRegistrations, "afterSwitch", ({ afterSwitch }) => afterSwitch, event);
}

function normalizedTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_BEFORE_HOOK_TIMEOUT_MS;
  return Math.max(0, timeoutMs);
}

function startGeneration(
  generations: Map<string, HookGeneration>,
  key: string,
): { generation: number; invalidated: Promise<void> } {
  const previous = generations.get(key);
  previous?.cancel();
  const invalidation = Promise.withResolvers<void>();
  const generation = (previous?.generation ?? 0) + 1;
  generations.set(key, { generation, cancel: invalidation.resolve });
  return { generation, invalidated: invalidation.promise };
}

function releaseGeneration(
  generations: Map<string, HookGeneration>,
  key: string,
  generation: number,
): boolean {
  if (generations.get(key)?.generation !== generation) return false;
  generations.delete(key);
  return true;
}

async function waitWithDeadline<T>(
  work: Promise<T>,
  invalidated: Promise<void>,
  timeoutMs: number,
): Promise<T | undefined> {
  const timeout = Promise.withResolvers<void>();
  const timer = setTimeout(timeout.resolve, timeoutMs);
  try {
    return await Promise.race([
      work,
      timeout.promise.then(() => undefined),
      invalidated.then(() => undefined),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function collectBeforeTurnContributions(
  event: BeforeTurnEvent,
  options: BeforeTurnOptions = {},
): Promise<CollectedBeforeTurnResult> {
  const key = event.runId;
  const { generation, invalidated } = startGeneration(turnGenerations, key);
  const registrations = [...turnRegistrations];
  const results: Array<{
    pluginId: string;
    result?: BeforeTurnResult | void;
  }> = registrations.map(({ pluginId }) => ({ pluginId }));
  const work = Promise.allSettled(
    registrations.map(async ({ pluginId, hooks }, index) => {
      if (!hooks.beforeTurn) return;
      try {
        results[index].result = await hooks.beforeTurn(event);
      } catch (error) {
        reportHookError(pluginId, "beforeTurn", error);
      }
    }),
  );
  await waitWithDeadline(work, invalidated, normalizedTimeout(options.timeoutMs));
  if (!releaseGeneration(turnGenerations, key, generation)) {
    return { promptContributions: [], internalMessageCaptures: [] };
  }

  const promptContributions: PromptContribution[] = [];
  const internalMessageCaptures: RegisteredInternalMessageCapture[] = [];
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_PROMPT_CONTRIBUTION_MAX_BYTES);
  let usedBytes = 0;
  for (const { pluginId: _pluginId, result } of results) {
    if (!result) continue;
    if (result.internalMessageCapture) {
      const capture = result.internalMessageCapture;
      // A plugin's declared budget is untrusted input: an unbounded value lets
      // one unterminated opening tag hold a whole turn's output, and anything
      // past the host ceiling would be hidden live but visible on reload.
      // Non-finite collapses to 0 — nothing is hidden the host cannot record.
      const declared = Number.isFinite(capture.maxBytes) ? capture.maxBytes : 0;
      internalMessageCaptures.push({
        pluginId: _pluginId,
        capture: {
          ...capture,
          maxBytes: Math.min(MAX_INTERNAL_CAPTURE_BYTES, Math.max(0, declared)),
        },
      });
    }
    for (const contribution of result.promptContributions ?? []) {
      const contributionBytes = encoder.encode(contribution.content).byteLength;
      if (usedBytes + contributionBytes > maxBytes) continue;
      usedBytes += contributionBytes;
      promptContributions.push(contribution);
    }
  }
  return { promptContributions, internalMessageCaptures };
}

/** Commit contributions after the engine accepts the launch carrying them.
 * Idempotent because session-scoped contributions may be re-injected later. */
export function confirmPromptContributions(contributions: PromptContribution[]): void {
  for (const contribution of contributions) {
    if (confirmedContributions.has(contribution)) continue;
    confirmedContributions.add(contribution);
    try {
      contribution.onAccepted?.();
    } catch (error) {
      reportHookError("host", "promptContribution.onAccepted", error);
    }
  }
}

export async function runBeforeSwitch(
  event: RuntimeSwitchEvent,
  options: BeforeHookOptions = {},
): Promise<void> {
  const key = `${event.sourceEngine}->${event.targetEngine}@${event.workspace.id}`;
  const { generation, invalidated } = startGeneration(switchGenerations, key);
  const work = Promise.all(
    [...switchRegistrations].map(async ({ pluginId, hooks }) => {
      if (!hooks.beforeSwitch) return;
      try {
        await hooks.beforeSwitch(event);
      } catch (error) {
        reportHookError(pluginId, "beforeSwitch", error);
      }
    }),
  );
  await waitWithDeadline(work, invalidated, normalizedTimeout(options.timeoutMs));
  releaseGeneration(switchGenerations, key, generation);
}
