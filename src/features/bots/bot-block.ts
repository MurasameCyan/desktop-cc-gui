import type { BotConfig } from "@/lib/ipc";
import { cachedInstalledSkills } from "@/features/skills/api";
import { buildBotBlock } from "@/features/chat/components/agent-block";
import { assembleBotPrompt, type SkillIndexEntry } from "./bot-prompt";

/**
 * Bot → outgoing prompt block. The send path freezes the result on the
 * thread's selection (see selected-bot.ts), so this runs once per session,
 * not once per message.
 *
 * What goes in today is what exists today: identity, SOUL, AGENTS and the
 * skills index. The USER profile, MEMORY and the memory guide arrive with the
 * memory phase; 协作者 arrives with delegation. `assembleBotPrompt` marks
 * those blocks as planned instead of silently leaving them out, and the send
 * path passes no `memoryAvailable`, so the model is never told about a tool
 * this build does not have.
 */

/** Avatar → the single character the transcript badge can carry. Generated
 *  and image avatars carry none: the badge resolves those from the bot id. */
export function avatarGlyph(bot: BotConfig): string {
  return bot.avatar.type === "emoji" ? (bot.avatar.value?.trim() ?? "") : "";
}

/** Enabled skills of one bot. `["*"]` means every skill the hub knows. */
export async function skillIndexFor(bot: BotConfig): Promise<SkillIndexEntry[]> {
  const enabled = bot.capabilities.skills;
  if (enabled.length === 0) return [];
  const all = await cachedInstalledSkills().catch(() => null);
  if (!all) return [];
  const entries = all.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
  }));
  if (enabled.includes("*")) return entries;
  // A skill the user enabled but that has since been uninstalled simply
  // drops out of the index; the bot keeps working without it.
  return entries.filter((entry) => enabled.includes(entry.name));
}

/** Build the `## Agent Role and Instructions` tail block for a bot. */
export async function buildBotPromptBlock(bot: BotConfig): Promise<string> {
  const skills = await skillIndexFor(bot);
  const assembled = assembleBotPrompt({ bot, skills });
  return buildBotBlock({
    name: bot.name,
    icon: avatarGlyph(bot),
    botId: bot.id,
    body: assembled.text,
  });
}
