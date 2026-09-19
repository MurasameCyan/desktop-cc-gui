import { useEffect, useState } from "react";
import FileImage from "lucide-react/dist/esm/icons/file-image";
import { ipc } from "@/lib/ipc";
import { ImageLightbox } from "@/components/base/image-lightbox";
import { fileName } from "@/features/files/store";

/** Display name for an image ref; data URLs carry no filename. */
function imageName(ref: string): string {
  if (ref.startsWith("data:")) return "image";
  return fileName(ref);
}

/** Image attachments of one user message. Data URLs render directly; file
 * paths resolve through the backend (`read_file` returns a data URL).
 * Unreadable files (e.g. pasted images swept at startup) degrade to a
 * filename chip. Clicking a thumbnail opens the lightbox. */
export function MessageImages({ images }: { images: string[] }) {
  // ref -> resolved URL; absent = still loading, null = unreadable.
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const [zoom, setZoom] = useState<{ src: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const initial: Record<string, string | null> = {};
    for (const ref of images) {
      if (ref.startsWith("data:")) initial[ref] = ref;
    }
    setUrls(initial);
    for (const ref of images) {
      if (ref.startsWith("data:")) continue;
      ipc
        .readFile(ref)
        .then((content) => {
          if (cancelled) return;
          setUrls((prev) => ({
            ...prev,
            [ref]: content.kind === "image" ? content.dataUrl : null,
          }));
        })
        .catch(() => {
          if (!cancelled) setUrls((prev) => ({ ...prev, [ref]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [images]);

  return (
    <>
      <div className="flex flex-wrap gap-2 pb-1.5">
        {images.map((ref) => {
          const url = urls[ref];
          const name = imageName(ref);
          if (url === undefined) {
            return (
              <div
                key={ref}
                className="h-24 w-32 animate-pulse rounded-lg bg-white/20"
                aria-hidden
              />
            );
          }
          if (url === null) {
            return (
              <span
                key={ref}
                className="inline-flex items-center gap-1 rounded-md bg-white/15 px-2 py-1 text-caption-1-medium text-text-white/80"
                title={ref.startsWith("data:") ? undefined : ref}
              >
                <FileImage className="size-3.5" aria-hidden />
                {name}
              </span>
            );
          }
          return (
            <button
              key={ref}
              type="button"
              onClick={() => setZoom({ src: url, name })}
              className="cursor-zoom-in overflow-hidden rounded-lg"
              aria-label={name}
            >
              <img
                src={url}
                alt={name}
                className="max-h-48 max-w-64 rounded-lg object-cover"
                loading="lazy"
              />
            </button>
          );
        })}
      </div>
      {zoom && (
        <ImageLightbox src={zoom.src} name={zoom.name} onClose={() => setZoom(null)} />
      )}
    </>
  );
}
