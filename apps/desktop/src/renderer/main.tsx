import { render } from "preact";

import { App } from "./app";
import { t } from "./lib/strings";
import "./styles.css";

/**
 * The host shell's entry. In the app, the preload has put the main process's bridge on
 * `window.loamDesktop`. Under plain `vite` in a browser there is none, so the development build installs
 * an in-memory fake (lib/fake-bridge.ts) to work on the screens with; a packaged build never does, and
 * says the window couldn't connect instead of showing invented data.
 */
async function start(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) {
    return;
  }
  if (!window.loamDesktop && import.meta.env.DEV) {
    const { installFakeBridge } = await import("./lib/fake-bridge");
    installFakeBridge();
  }
  if (!window.loamDesktop) {
    render(
      <main className="screen screen-centred">
        <p className="form-error" role="alert">
          {t("error.unknown.title")}
        </p>
      </main>,
      root,
    );
    return;
  }
  render(<App bridge={window.loamDesktop} />, root);
}

void start();
