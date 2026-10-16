// esbuild entry for the desktop app's server bundle (dist/main/loam-server.js, built by scripts/build.mjs with
// the shared recipe in scripts/lib/bundle-server.mjs). The main process imports it once, after setting
// NODE_ENV=production, and boots the node with `startEmbeddedServer` (env-driven, plus a log stream and a host
// token). `firstLanIPv4` is the best join address; `createLogBook` and `clean` are the terminal UI's in-memory
// log and its control-character filter, so the desktop's Activity screen reads the log exactly as `loamnet`
// does. The shape the main process relies on is `ServerModule` in src/main/server-module.ts.
export { firstLanIPv4, startEmbeddedServer } from "../../server/src/embedded.js";
export { clean, createLogBook } from "@loam/tui";
