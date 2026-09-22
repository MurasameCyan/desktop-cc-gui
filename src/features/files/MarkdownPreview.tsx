import { useDeferredValue, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { fileUrl, openExternal } from "@/lib/platform";
import type { Pluggable } from "unified";

const REMARK_PLUGINS = [remarkGfm];
// rehype-raw parses inline HTML (<div align>, <img>, badges); sanitize keeps
// it safe; highlight runs last so its classes survive sanitization.
const REHYPE_PLUGINS: Pluggable[] = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      tagNames: [
        ...(defaultSchema.tagNames ?? []),
        "details",
        "summary",
        "abbr",
        "mark",
        "ins",
        "del",
        "sub",
        "sup",
        "kbd",
        "var",
        "samp",
      ],
      attributes: {
        ...defaultSchema.attributes,
        "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "class"],
      },
    },
  ],
  rehypeHighlight,
];
const BROWSER_LOADABLE_SRC_RE = /^(?:https?:|data:|blob:|asset:)/i;

function normalizePathSegments(path: string): string {
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path);
  const segments = path.split(/[\\/]+/);
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (isAbsolute) {
    const prefix = /^[a-zA-Z]:/.test(path) ? "" : "/";
    return prefix + joined;
  }
  return joined;
}

/** Local relative image src → absolute path next to the markdown file. */
function resolveMarkdownImageSrc(src: string, sourceFilePath: string): string {
  let cleaned: string;
  try {
    cleaned = decodeURIComponent(src);
  } catch {
    cleaned = src;
  }
  if (BROWSER_LOADABLE_SRC_RE.test(cleaned)) return cleaned;
  if (!/\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(cleaned)) {
    return cleaned;
  }
  const pathOnly = cleaned.replace(/[?#].*$/, "");
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(pathOnly)) {
    return fileUrl(normalizePathSegments(pathOnly));
  }
  const sepIdx = Math.max(
    sourceFilePath.lastIndexOf("/"),
    sourceFilePath.lastIndexOf("\\"),
  );
  if (sepIdx <= 0) return cleaned;
  try {
    return fileUrl(
      normalizePathSegments(`${sourceFilePath.slice(0, sepIdx)}/${pathOnly}`),
    );
  } catch {
    return cleaned;
  }
}

export function MarkdownPreview({ path, draft }: { path: string; draft: string }) {
  // Preview parses a deferred copy of the draft: the full rehype pipeline
  // (raw → sanitize → highlight) per keystroke would jank typing.
  const deferredDraft = useDeferredValue(draft);
  const markdownComponents = useMemo(
    () => ({
      // Unstyled <pre> from rehype-highlight gets basic chrome here.
      pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
        <pre
          {...props}
          className="my-2 overflow-auto rounded-lg bg-background-secondary-default p-3 text-caption-1-regular"
        />
      ),
      code: (props: React.HTMLAttributes<HTMLElement>) => (
        <code {...props} className="font-mono text-[0.85em]" />
      ),
      img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
        <img
          {...props}
          src={props.src ? resolveMarkdownImageSrc(String(props.src), path) : props.src}
          className="max-w-full"
        />
      ),
      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
        const href = props.href ?? "";
        if (/^https?:/i.test(href)) {
          return (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openExternal(href);
              }}
            />
          );
        }
        return <a {...props} />;
      },
    }),
    [path],
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 text-body-medium text-text-primary [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2 [&_a]:text-accent-600 [&_a]:underline [&_kbd]:inline-flex [&_kbd]:items-center [&_kbd]:gap-1 [&_kbd]:rounded-md [&_kbd]:border [&_kbd]:border-separator-border [&_kbd]:bg-background-tertiary-default [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:align-middle [&_kbd]:text-caption-1-regular">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={markdownComponents}
      >
        {deferredDraft}
      </ReactMarkdown>
    </div>
  );
}
