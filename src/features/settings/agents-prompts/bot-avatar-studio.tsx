import { useTranslation } from "react-i18next";
import { Input } from "@/components/base/input/input";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { cx } from "@/utils/cx";
import {
  BOT_COLORS,
  BOT_FACES,
  BOT_SHAPES,
  BotAvatarView,
  normalizeAvatar,
} from "@/features/bots/bot-avatar";
import type { BotAvatar } from "@/lib/ipc";

/** Emoji quick picks for the emoji avatar source (v1's grid, plus a few). */
const QUICK_EMOJI = [
  "🤖", "🧠", "🦊", "🧭", "🛠️", "🎨", "📝", "🔍", "🧪",
  "📊", "🚀", "💡", "🐛", "📚", "🏛", "🧩", "🌐", "⚡",
];

/**
 * Avatar studio: pick the flavour (generated paper look / emoji / image) and,
 * for a generated one, its shape, colour and face. Every control previews with
 * the *current* other choices, so the swatch row shows what the bot will
 * actually look like instead of an abstract colour.
 */
export function BotAvatarStudio({
  avatar,
  seed,
  onChange,
}: {
  avatar: BotAvatar;
  /** Identity used when nothing is chosen yet (deterministic fallback). */
  seed: string;
  onChange: (avatar: BotAvatar) => void;
}) {
  const { t } = useTranslation();
  const value = normalizeAvatar(avatar, seed);
  const type = avatar.type ?? "generated";

  const setType = (next: "generated" | "emoji" | "image") => {
    if (next === type) return;
    if (next === "generated") {
      // Carry the current look over when leaving emoji/image, so switching
      // source does not throw away the user's colour/face choices.
      onChange({
        type: "generated",
        shape: value.shape,
        color: value.color,
        face: value.face,
      });
      return;
    }
    if (next === "emoji") {
      onChange({ type: "emoji", value: value.type === "emoji" ? value.value : "🤖" });
      return;
    }
    onChange({ type: "image", value: value.type === "image" ? value.value : "" });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-background-tertiary-default/40 py-4">
        <BotAvatarView avatar={value} seed={seed} size={96} />
        <p className="text-caption-1-regular text-text-tertiary">
          {t(`settings.botAvatarKind.${value.type}`)}
        </p>
      </div>

      <PillTabList className="self-center">
        <PillTab
          variant="gray"
          isSelected={type === "generated"}
          onSelect={() => setType("generated")}
        >
          {t("settings.botAvatarGenerated")}
        </PillTab>
        <PillTab
          variant="gray"
          isSelected={type === "emoji"}
          onSelect={() => setType("emoji")}
        >
          {t("settings.botAvatarEmoji")}
        </PillTab>
        <PillTab
          variant="gray"
          isSelected={type === "image"}
          onSelect={() => setType("image")}
        >
          {t("settings.botAvatarImage")}
        </PillTab>
      </PillTabList>

      {type === "generated" && (
        <div className="flex flex-col gap-3 rounded-2xl border border-separator-border bg-background-primary-default p-3">
          <div>
            <p className="mb-1.5 text-caption-1-medium text-text-tertiary">
              {t("settings.botAvatarShape")}
            </p>
            <div className="flex flex-wrap gap-1">
              {BOT_SHAPES.map((shape) => (
                <button
                  key={shape.id}
                  type="button"
                  aria-label={shape.label}
                  title={shape.label}
                  aria-pressed={value.shape === shape.id}
                  onClick={() => onChange({ ...value, type: "generated", shape: shape.id })}
                  className={cx(
                    "flex size-8 cursor-pointer items-center justify-center rounded-lg border border-transparent",
                    "transition-colors hover:bg-background-secondary-hover",
                    "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                    value.shape === shape.id && "border-text-secondary bg-background-tertiary-default",
                  )}
                >
                  <BotAvatarView
                    avatar={{ type: "generated", shape: shape.id, color: value.color, face: "smile" }}
                    size={20}
                  />
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-caption-1-medium text-text-tertiary">
              {t("settings.botAvatarColor")}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {BOT_COLORS.map((color) => (
                <button
                  key={color.value}
                  type="button"
                  aria-label={color.label}
                  title={color.label}
                  aria-pressed={value.color === color.value}
                  onClick={() => onChange({ ...value, type: "generated", color: color.value })}
                  style={{ backgroundColor: color.value }}
                  className={cx(
                    "size-6 cursor-pointer rounded-full border-2 transition-transform",
                    "outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                    value.color === color.value ? "border-white" : "border-transparent",
                  )}
                />
              ))}
              <label
                title={t("settings.botAvatarColorCustom")}
                className="relative size-6 cursor-pointer overflow-hidden rounded-full border-2 border-transparent"
                style={{
                  backgroundImage:
                    "conic-gradient(from 0deg,#ef4444,#f97316,#84cc16,#22c55e,#06b6d4,#3b82f6,#8b5cf6,#ec4899,#ef4444)",
                }}
              >
                <input
                  type="color"
                  aria-label={t("settings.botAvatarColorCustom")}
                  value={value.color}
                  onChange={(event) =>
                    onChange({ ...value, type: "generated", color: event.target.value })
                  }
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </label>
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-caption-1-medium text-text-tertiary">
              {t("settings.botAvatarFace")}
            </p>
            <div className="flex flex-wrap gap-1">
              {BOT_FACES.map((face) => (
                <button
                  key={face.id}
                  type="button"
                  aria-label={face.label}
                  title={face.label}
                  aria-pressed={value.face === face.id}
                  onClick={() => onChange({ ...value, type: "generated", face: face.id })}
                  className={cx(
                    "flex size-8 cursor-pointer items-center justify-center rounded-lg border border-transparent",
                    "transition-colors hover:bg-background-secondary-hover",
                    "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                    value.face === face.id && "border-text-secondary bg-background-tertiary-default",
                  )}
                >
                  <BotAvatarView
                    avatar={{ type: "generated", shape: "petal", color: value.color, face: face.id }}
                    size={20}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {type === "emoji" && (
        <div className="flex flex-col gap-2 rounded-2xl border border-separator-border bg-background-primary-default p-3">
          <div className="flex flex-wrap gap-1">
            {QUICK_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={emoji}
                aria-pressed={value.type === "emoji" && value.value === emoji}
                onClick={() => onChange({ type: "emoji", value: emoji })}
                className={cx(
                  "flex size-8 cursor-pointer items-center justify-center rounded-lg border border-transparent text-base",
                  "transition-colors hover:bg-background-secondary-hover",
                  "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                  value.type === "emoji" && value.value === emoji &&
                    "border-text-secondary bg-background-tertiary-default",
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
          <Input
            size="small"
            value={value.type === "emoji" ? (value.value ?? "") : ""}
            onChange={(next) => onChange({ type: "emoji", value: next })}
            placeholder={t("settings.agentIconPlaceholder")}
            aria-label={t("settings.agentIcon")}
            maxLength={4}
          />
        </div>
      )}

      {type === "image" && (
        <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-border-button-default p-3">
          <p className="text-caption-1-regular text-text-tertiary">
            {t("settings.botAvatarImageHint")}
          </p>
          <Input
            size="small"
            value={value.type === "image" ? (value.value ?? "") : ""}
            onChange={(next) => onChange({ type: "image", value: next })}
            placeholder="avatar.png"
            aria-label={t("settings.botAvatarImageName")}
          />
        </div>
      )}
    </div>
  );
}
