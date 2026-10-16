import type { HostUser } from "@loam/schema";
import { useEffect, useState } from "preact/hooks";

import type { DesktopBridge, DesktopState } from "../../shared/ipc";
import { attempt } from "../lib/attempt";
import { clock } from "../lib/format";
import { canMakeAdmin, nameKey, sharedNames, shortId } from "../lib/people";
import { t } from "../lib/strings";

type RowNote = { kind: "error" | "done"; text: string };

/**
 * People (the TUI's People screen): who has joined, who is online or waiting, and one action, Make admin,
 * behind a second step that says what it means. Each row shows the end of the id and flags a name someone
 * else also uses, since a copied name mustn't be enough to be promoted. Refreshed on every state push.
 * Everything else about people (approvals, bans) happens in the web app.
 */
export function PeopleScreen({ bridge, state }: { bridge: DesktopBridge; state: DesktopState }) {
  const running = state.phase === "running";
  const [users, setUsers] = useState<HostUser[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, RowNote>>({});

  useEffect(() => {
    if (!running) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    void attempt(() => bridge.host.users()).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setUsers(result.value);
        setLoadError(undefined);
      } else {
        setLoadError(t("people.loadFailed", { error: result.error }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, state, running]);

  async function makeAdmin(user: HostUser): Promise<void> {
    setBusy(true);
    const result = await attempt(() => bridge.host.makeAdmin(user.id));
    setBusy(false);
    setConfirming(undefined);
    setNotes((current) => ({
      ...current,
      [user.id]: result.ok ? { kind: "done", text: t("people.done", { name: user.displayName }) } : { kind: "error", text: result.error },
    }));
    if (result.ok) {
      setUsers((current) => current.map((candidate) => (candidate.id === user.id ? result.value : candidate)));
    }
  }

  if (!running) {
    return (
      <main className="screen">
        <div className="screen-column">
          <section className="card">
            <h1>{t("people.title")}</h1>
            <p className="muted">{t("people.notRunning")}</p>
          </section>
        </div>
      </main>
    );
  }

  const { people } = state.node;
  const shared = sharedNames(users);
  return (
    <main className="screen">
      <div className="screen-column">
        <section aria-labelledby="people-title" className="card">
          <h1 id="people-title">{t("people.title")}</h1>
          <p>
            <strong>
              {people.total === 1 ? t("people.summaryOne", { online: people.online }) : t("people.summary", { total: people.total, online: people.online })}
            </strong>
            {people.pending ? <span className="muted"> · {t("running.pending", { n: people.pending })}</span> : null}
          </p>
          <p className="muted">{t("people.note")}</p>
          {loadError ? (
            <p className="form-error" role="alert">
              {loadError}
            </p>
          ) : null}
          {users.length === 0 && !loadError ? <p className="muted">{t("people.empty")}</p> : null}
          {users.length ? (
            <ul className="list people-list">
              {users.map((user) => {
                const sameName = shared.has(nameKey(user.displayName));
                const note = notes[user.id];
                return (
                  <li className="list-row person" key={user.id}>
                    <span
                      aria-label={user.online ? t("people.online") : t("people.offline")}
                      className={`person-dot${user.online ? " is-online" : ""}`}
                      role="img"
                    />
                    <span className="row-text">
                      <span className="row-title">{user.displayName}</span>
                      <span className="row-meta">
                        {t("people.joined", { id: shortId(user.id), time: clock(user.createdAt) })}
                        {user.isAdmin ? <span className="badge badge-primary">{t("people.admin")}</span> : null}
                        {user.pending ? <span className="badge badge-accent">{t("people.waiting")}</span> : null}
                        {user.banned ? <span className="badge badge-danger">{t("people.banned")}</span> : null}
                        {sameName ? <span className="badge">{t("people.sameName")}</span> : null}
                      </span>
                    </span>
                    <span className="row-actions">
                      {canMakeAdmin(user) && confirming !== user.id ? (
                        <button className="btn btn-secondary btn-sm" onClick={() => setConfirming(user.id)} type="button">
                          {t("people.makeAdmin")}
                        </button>
                      ) : null}
                    </span>
                    {confirming === user.id ? (
                      <div aria-label={t("people.confirmTitle", { name: user.displayName })} className="row-detail confirm" role="group">
                        <p>
                          <strong>{t("people.confirmTitle", { name: user.displayName })}</strong>
                        </p>
                        {sameName ? <p className="notice">{t("people.confirmSameName")}</p> : null}
                        {user.pending ? <p>{t("people.confirmPending")}</p> : null}
                        <p className="muted">{t("people.confirmBody")}</p>
                        <div className="actions">
                          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void makeAdmin(user)} type="button">
                            {t("people.makeAdmin")}
                          </button>
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirming(undefined)} type="button">
                            {t("common.cancel")}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {note ? (
                      <p className={`row-detail ${note.kind === "error" ? "form-error" : "muted"}`} role={note.kind === "error" ? "alert" : "status"}>
                        {note.text}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      </div>
    </main>
  );
}
