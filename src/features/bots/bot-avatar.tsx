import { useId } from "react";
import type { BotAvatar } from "@/lib/ipc";
import { cx } from "@/utils/cx";

/**
 * Bot avatars, in three flavours (see `BotAvatar`):
 *
 *   generated  a paper avatar: one of nine silhouettes × a colour ramp × a
 *              face. Drawn as inline SVG so it is offline, crisp at every
 *              size and needs no asset pipeline.
 *   emoji      the v1 behaviour, kept so migrated agents look unchanged.
 *   image      a file the user dropped into the bot's directory.
 *
 * All three render through `BotAvatarView`, so the list, the editor, the `#`
 * picker and a chat badge always agree on what a bot looks like.
 */

export interface BotShapeOption {
  id: string;
  label: string;
}
export interface BotColorOption {
  value: string;
  label: string;
}
export interface BotFaceOption {
  id: string;
  label: string;
}

export const BOT_SHAPES: BotShapeOption[] = [
  { id: "petal", label: "圆角方" },
  { id: "flower", label: "四瓣" },
  { id: "star", label: "星" },
  { id: "heart", label: "心" },
  { id: "cloud", label: "云" },
  { id: "diamond", label: "菱" },
  { id: "shield", label: "盾" },
  { id: "slender", label: "瘦长" },
  { id: "pocket", label: "口袋" },
];

export const BOT_COLORS: BotColorOption[] = [
  { value: "#3b82f6", label: "蓝" },
  { value: "#14b8a6", label: "青" },
  { value: "#8b5cf6", label: "紫" },
  { value: "#ec4899", label: "粉" },
  { value: "#ef4444", label: "红" },
  { value: "#f97316", label: "橙" },
  { value: "#06b6d4", label: "天蓝" },
  { value: "#84cc16", label: "黄绿" },
  { value: "#22c55e", label: "绿" },
];

export const BOT_FACES: BotFaceOption[] = [
  { id: "neutral", label: "平静" },
  { id: "smile", label: "微笑" },
  { id: "curious", label: "好奇" },
  { id: "focused", label: "认真" },
  { id: "sleepy", label: "困了" },
  { id: "wink", label: "俏皮" },
];

export const DEFAULT_AVATAR: BotAvatar = {
  type: "generated",
  shape: "flower",
  color: "#14b8a6",
  face: "smile",
};

const SHAPE_IDS = BOT_SHAPES.map((s) => s.id);
const COLOR_VALUES = BOT_COLORS.map((c) => c.value);
const FACE_IDS = BOT_FACES.map((f) => f.id);

/** Deterministic avatar for a bot without one (e.g. a v1 entry whose icon was
 *  an ASCII preset id). Same seed ⇒ same look, so a migrated catalog does not
 *  reshuffle on every render. */
export function fallbackAvatar(seed: string): BotAvatar {
  let hash = 7;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  }
  return {
    type: "generated",
    shape: SHAPE_IDS[hash % SHAPE_IDS.length],
    color: COLOR_VALUES[Math.floor(hash / 7) % COLOR_VALUES.length],
    face: FACE_IDS[Math.floor(hash / 13) % FACE_IDS.length],
  };
}

/** v1 icon string → avatar. Non-ASCII icons are emoji (unchanged look); the
 *  legacy ASCII preset ids have no counterpart here, so they become the
 *  deterministic generated avatar instead of leaking a preset id into the UI. */
export function avatarFromLegacyIcon(icon?: string | null, seed = "legacy"): BotAvatar {
  const value = icon?.trim();
  if (value && /[^\x00-\x7F]/.test(value)) {
    return { type: "emoji", value };
  }
  return fallbackAvatar(seed || value || "legacy");
}

/** Avatar fields with defaults filled in — the renderer's single entry point. */
export function normalizeAvatar(avatar?: BotAvatar | null, seed = "bot"): BotAvatar {
  if (!avatar) return fallbackAvatar(seed);
  if (avatar.type === "emoji") {
    return avatar.value?.trim()
      ? { type: "emoji", value: avatar.value }
      : fallbackAvatar(seed);
  }
  if (avatar.type === "image") {
    return avatar.value?.trim() ? avatar : fallbackAvatar(seed);
  }
  return {
    type: "generated",
    shape: avatar.shape && SHAPE_IDS.includes(avatar.shape) ? avatar.shape : "flower",
    color: avatar.color && /^#[0-9a-fA-F]{6}$/.test(avatar.color) ? avatar.color : "#14b8a6",
    face: avatar.face && FACE_IDS.includes(avatar.face) ? avatar.face : "smile",
  };
}

/** How the picture is described to a screen reader / in a title. */
export function avatarLabel(avatar: BotAvatar): string {
  if (avatar.type === "emoji") return avatar.value ?? "";
  if (avatar.type === "image") return avatar.value ?? "";
  const shape = BOT_SHAPES.find((s) => s.id === avatar.shape)?.label;
  const face = BOT_FACES.find((f) => f.id === avatar.face)?.label;
  return [shape, face].filter(Boolean).join(" · ");
}

/** Faces are drawn in ink over the shape, sized for a 100×100 viewBox. */
const FACES: Record<string, JSX.Element> = {
  neutral: (
    <>
      <circle cx="38" cy="50" r="4.6" />
      <circle cx="62" cy="50" r="4.6" />
      <rect x="42" y="65" width="16" height="3.4" rx="1.7" />
    </>
  ),
  smile: (
    <>
      <circle cx="38" cy="49" r="4.6" />
      <circle cx="62" cy="49" r="4.6" />
      <path d="M41 62q9 9 18 0" fill="none" strokeWidth="3.6" strokeLinecap="round" />
    </>
  ),
  curious: (
    <>
      <circle cx="37" cy="48" r="5.6" />
      <circle cx="63" cy="50" r="4" />
      <circle cx="50" cy="67" r="3.6" />
    </>
  ),
  focused: (
    <>
      <rect x="28" y="40" width="15" height="3.4" rx="1.7" transform="rotate(-8 35 42)" />
      <rect x="58" y="40" width="15" height="3.4" rx="1.7" transform="rotate(8 65 42)" />
      <circle cx="37" cy="52" r="4.4" />
      <circle cx="63" cy="52" r="4.4" />
      <rect x="42" y="67" width="16" height="3.4" rx="1.7" />
    </>
  ),
  sleepy: (
    <>
      <path d="M31 50q7 8 14 0" fill="none" strokeWidth="3.8" strokeLinecap="round" />
      <path d="M55 50q7 8 14 0" fill="none" strokeWidth="3.8" strokeLinecap="round" />
      <circle cx="50" cy="68" r="3.6" />
    </>
  ),
  wink: (
    <>
      <circle cx="38" cy="49" r="4.6" />
      <path d="M56 49q6 6 12 0" fill="none" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M41 63q9 8 18 -1" fill="none" strokeWidth="3.6" strokeLinecap="round" />
    </>
  ),
};

function GeneratedAvatar({ avatar }: { avatar: BotAvatar }) {
  const gradientId = useId();
  const color = avatar.color ?? "#14b8a6";
  const shape = avatar.shape ?? "flower";
  const face = avatar.face ?? "smile";
  const fill = `url(#${gradientId})`;

  let body: JSX.Element;
  let notch: JSX.Element | null = null;
  switch (shape) {
    case "petal":
      body = <path d="M50 4C84 4 96 16 96 50C96 84 84 96 50 96C16 96 4 84 4 50C4 16 16 4 50 4Z" fill={fill} />;
      break;
    case "star":
      body = (
        <polygon
          points="50,8 62,37 93,39 69,58 78,88 50,71 22,88 31,58 7,39 38,37"
          fill={fill}
          stroke={fill}
          strokeWidth="13"
          strokeLinejoin="round"
        />
      );
      break;
    case "heart":
      body = (
        <path
          d="M50 90C20 68 8 52 8 36C8 22 19 12 32 12C40 12 46 16 50 23C54 16 60 12 68 12C81 12 92 22 92 36C92 52 80 68 50 90Z"
          fill={fill}
        />
      );
      break;
    case "cloud":
      body = (
        <g fill={fill}>
          <circle cx="30" cy="60" r="20" />
          <circle cx="52" cy="45" r="26" />
          <circle cx="74" cy="60" r="18" />
          <circle cx="50" cy="66" r="24" />
        </g>
      );
      break;
    case "diamond":
      body = (
        <path
          d="M50 6C53 6 56 7 59 10L90 41C96 47 96 53 90 59L59 90C53 96 47 96 41 90L10 59C4 53 4 47 10 41L41 10C44 7 47 6 50 6Z"
          fill={fill}
        />
      );
      break;
    case "shield":
      body = (
        <path
          d="M50 5C61 11 73 14 87 14C89 40 88 62 76 78C68 89 59 94 50 96C41 94 32 89 24 78C12 62 11 40 13 14C27 14 39 11 50 5Z"
          fill={fill}
        />
      );
      break;
    case "slender":
      body = (
        <path
          d="M50 5C61 5 70 14 70 25L70 75C70 86 61 95 50 95C39 95 30 86 30 75L30 25C30 14 39 5 50 5Z"
          fill={fill}
        />
      );
      break;
    case "pocket":
      body = (
        <path
          d="M24 5H76C86 5 95 14 95 24V76C95 86 86 95 76 95H24C14 95 5 86 5 76V24C5 14 14 5 24 5Z"
          fill={fill}
        />
      );
      notch = <rect x="16" y="16" width="68" height="24" rx="12" fill="rgba(0,0,0,.16)" />;
      break;
    case "flower":
    default:
      body = (
        <g fill={fill}>
          <circle cx="50" cy="26" r="22" />
          <circle cx="74" cy="50" r="22" />
          <circle cx="50" cy="74" r="22" />
          <circle cx="26" cy="50" r="22" />
          <circle cx="50" cy="50" r="26" />
        </g>
      );
      break;
  }

  return (
    <svg viewBox="0 0 100 100" role="img" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="1" />
          <stop offset="1" stopColor={color} stopOpacity="0.72" />
        </linearGradient>
      </defs>
      {body}
      {notch}
      <g fill="#0d0d0d" fillOpacity="0.78" stroke="#0d0d0d" strokeOpacity="0.78">
        {FACES[face] ?? FACES.smile}
      </g>
      <ellipse cx="50" cy="34" rx="30" ry="17" fill="#fff" fillOpacity="0.16" />
    </svg>
  );
}

/**
 * One bot avatar at a square size. `size` drives both the box and the font
 * size of an emoji, so callers never hand-tune either.
 */
export function BotAvatarView({
  avatar,
  seed,
  size = 24,
  className,
  title,
}: {
  avatar?: BotAvatar | null;
  /** Used when the avatar is missing/unusable: same seed ⇒ same look. */
  seed?: string;
  size?: number;
  className?: string;
  /** Overrides the derived label (used by the list/editor for `aria-label`). */
  title?: string;
}) {
  const resolved = normalizeAvatar(avatar, seed);
  const label = title ?? avatarLabel(resolved);
  return (
    <span
      className={cx("inline-flex shrink-0 items-center justify-center overflow-hidden", className)}
      style={{ width: size, height: size }}
      aria-hidden={label ? undefined : true}
      aria-label={label || undefined}
      role={label ? "img" : undefined}
      title={label || undefined}
      data-testid="bot-avatar"
      data-avatar-type={resolved.type}
    >
      {resolved.type === "emoji" ? (
        <span className="leading-none" style={{ fontSize: Math.round(size * 0.78) }} aria-hidden>
          {resolved.value}
        </span>
      ) : resolved.type === "image" ? (
        <img alt="" src={resolved.value} className="size-full object-cover" />
      ) : (
        <GeneratedAvatar avatar={resolved} />
      )}
    </span>
  );
}
