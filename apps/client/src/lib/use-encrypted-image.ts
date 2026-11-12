import { useEffect, useState } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";

import {
  apiUrl,
  encryptedImageUrl,
  getImageCacheGeneration,
  getImageTransportMode,
  releaseImageUrl,
  retainImageUrl,
  subscribeImageCacheCleared,
  subscribeImageTransportChanged,
} from "./transport";

/**
 * Resolve an image path to a render-ready `src` (docs/08). In the default (non-tunnel) case this is
 * just the same-origin URL, returned synchronously so there's no flash. When the tunnel is active
 * (`required` mode) the raw endpoint won't serve a direct `<img>` GET, so the bytes are fetched through
 * the tunnel and a `blob:` URL is swapped in once ready — `undefined` until then, so nothing renders a
 * broken image. If the tunnelled fetch FAILS, `encryptedImageUrl` fails closed with `""` (never the raw
 * plaintext URL, docs/20); we map that to `undefined` so no `src` is set — an empty `src` would make the
 * browser re-request the current page URL. `undefined` in → `undefined` out.
 *
 * @param path - The server-relative image path (e.g. `/api/avatars/<id>.webp`), or `undefined`.
 * @returns The `src` to use, or `undefined` while a tunnelled image is still resolving.
 */
export function useEncryptedImage(path: string | undefined): string | undefined {
  const mode = useSyncExternalStore(subscribeImageTransportChanged, getImageTransportMode);
  const [image, setImage] = useState<{ path: string; src: string }>();
  // The image cache's generation: `clearImageObjectUrls` (a wipe, an identity change) revokes every cached
  // `blob:` URL and bumps it, so an image still on screen re-resolves instead of keeping a dead URL.
  const [generation, setGeneration] = useState(getImageCacheGeneration);
  useEffect(() => subscribeImageCacheCleared(() => setGeneration(getImageCacheGeneration())), []);

  useEffect(() => {
    setImage(undefined);
    if (path === undefined || mode !== "tunnel") return;

    let active = true;
    // Hold the cached `blob:` URL for as long as this element shows it, so the bounded cache never revokes
    // a URL still on screen (it would render as a broken image). Retained BEFORE resolving, so a fetch that
    // completes and fills the cache in between can't evict it either.
    retainImageUrl(path);
    void encryptedImageUrl(path).then((resolved) => {
      if (active) {
        // Fail-closed "" → undefined: never set an empty src (the browser would re-request the page URL).
        setImage(resolved ? { path, src: resolved } : undefined);
      }
    });

    return () => {
      active = false;
      releaseImageUrl(path);
    };
  }, [path, mode, generation]);

  if (path === undefined || mode === "pending") return undefined;
  if (mode === "direct") return apiUrl(path);
  return image?.path === path ? image.src : undefined;
}
