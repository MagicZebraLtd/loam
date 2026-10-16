import { t, type StringKey } from "../lib/strings";

/** Starting, resetting, or waiting for the first state: one calm line and a pulsing dot, nothing to press. */
export function BusyScreen({ body, title }: { body?: StringKey; title: StringKey }) {
  return (
    <main className="screen screen-centred">
      <div aria-live="polite" className="busy" role="status">
        <span aria-hidden="true" className="status-pill status-connecting">
          <span className="status-dot" />
        </span>
        <h1>{t(title)}</h1>
        {body ? <p className="muted">{t(body)}</p> : null}
      </div>
    </main>
  );
}
