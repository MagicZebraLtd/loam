/**
 * Where the app's own files are. The main process runs from dist/main/index.js (inside app.asar once
 * packaged); everything it needs ships beside it in dist/: the server bundle and the SQLCipher driver in
 * dist/main/, the web client in dist/client/, the host shell in dist/renderer/, the preloads in dist/preload/.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(mainDir, "..");

export const appPaths = {
  /** The server bundle (scripts/build.mjs); the SQLCipher driver resolves next to it (dist/main/node_modules). */
  serverBundle: join(mainDir, "loam-server.js"),
  /** The web client the node serves (LOAM_CLIENT_DIST). */
  clientDist: join(distDir, "client"),
  /** The host shell's page. */
  rendererIndex: join(distDir, "renderer", "index.html"),
  hostPreload: join(distDir, "preload", "host.cjs"),
  clientPreload: join(distDir, "preload", "client.cjs"),
  /** The LOAM mark, for the tray and the window icon on Linux. */
  icon: join(distDir, "assets", "icon.png"),
};

/** The node's data folder inside Electron's userData: database, media, config.json. */
export function nodeDataDir(userData: string): string {
  return join(userData, "node");
}
