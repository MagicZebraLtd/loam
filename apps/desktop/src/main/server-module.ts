/**
 * The shape of the server bundle (dist/main/loam-server.js, from src/server-entry.ts) as the main process uses
 * it. Declared here rather than imported from the server's sources so the main process typechecks without
 * pulling the whole server into this project; the bundle is loaded once, at a boundary, and cast to this.
 */
import type { HostApi } from "@loam/schema";
import type { LogBook } from "@loam/tui";

/** What `startEmbeddedServer` hands back: the in-process host API and a way to stop the node. */
export type EmbeddedNode = {
  host: HostApi;
  close(): Promise<void>;
};

/** What a launcher passes `startEmbeddedServer` beside the env (see apps/server/src/embedded.ts). */
export type EmbeddedServerOptions = {
  hostToken: string;
  logStream: { write(line: string): void };
  handleSignals: false;
};

export type StartServer = (options: EmbeddedServerOptions) => Promise<EmbeddedNode>;

export type ServerModule = {
  startEmbeddedServer: StartServer;
  firstLanIPv4(): string;
  createLogBook(): LogBook;
  clean(text: string): string;
};

let loaded: Promise<ServerModule> | undefined;

/**
 * Import the server bundle (once per process). NODE_ENV must already be "production" (index.ts sets it first),
 * so the shipped app refuses Developer Mode exactly as the Android host does.
 */
export function loadServerModule(): Promise<ServerModule> {
  // A variable specifier keeps esbuild from trying to inline the bundle into the main process's own bundle.
  const specifier = "./loam-server.js";
  loaded ??= import(specifier) as Promise<ServerModule>;
  return loaded;
}
