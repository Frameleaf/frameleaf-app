import React, { useState, useEffect, useRef } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { loadResourceState } from "./account-library-data.mjs";
const key = "frameleaf:sharing-access:v1";
const initial = () => ({
  version: 1,
  partners: [{ id: "jamie", outgoing: true, incoming: true, inTimeline: true }],
  members: ["taylor", "jamie"],
  sent: [],
  received: [
    { id: "emma-family", name: "Emma’s recognition group", members: ["emma"] },
  ],
  history: [],
});
function read() {
  const base = initial();
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 100000) return base;
    const s = JSON.parse(raw);
    const ids = loadResourceState().users.map((x) => x.id);
    if (s.version !== 1) return base;
    return {
      version: 1,
      partners: Array.isArray(s.partners)
        ? s.partners
            .slice(0, 100)
            .filter((x) => ids.includes(x?.id) && x.id !== "taylor")
            .map((x) => ({
              id: x.id,
              outgoing: !!x.outgoing,
              incoming: !!x.incoming,
              inTimeline: !!x.incoming && !!x.inTimeline,
            }))
        : base.partners,
      members: Array.isArray(s.members)
        ? [...new Set(["taylor", ...s.members.filter((x) => ids.includes(x))])]
        : base.members,
      sent: Array.isArray(s.sent)
        ? [...new Set(s.sent.filter((x) => ids.includes(x) && x !== "taylor"))]
        : [],
      received: Array.isArray(s.received)
        ? base.received.filter((x) => s.received.some((y) => y?.id === x.id))
        : base.received,
      history: Array.isArray(s.history)
        ? s.history
            .slice(0, 30)
            .filter((x) => typeof x === "string" && x.length < 250)
        : [],
    };
  } catch {
    return base;
  }
}
export function SharingAccess({ section, onNavigate }) {
  const [state, setState] = useState(read),
    [dialog, setDialog] = useState(null),
    [userId, setUserId] = useState(""),
    [notice, setNotice] = useState("");
  const lastSaved = useRef(null);
  useEffect(() => {
    lastSaved.current = localStorage.getItem(key);
    const changed = (event) => {
      if (event.key === key || event.key === null) {
        setState(read());
        lastSaved.current = localStorage.getItem(key);
        setDialog(null);
        setNotice(
          "Sharing changed in another tab. Review the current access before making changes.",
        );
      }
    };
    addEventListener("storage", changed);
    return () => removeEventListener("storage", changed);
  }, []);
  const users = loadResourceState().users.filter((x) => x.status === "active");
  const person = (id) => users.find((x) => x.id === id)?.name || id;
  const partnerPage = section === "partner";
  const choices = users.filter(
    (x) =>
      x.id !== "taylor" &&
      (partnerPage
        ? !state.partners.some((p) => p.id === x.id && p.outgoing)
        : !state.members.includes(x.id) && !state.sent.includes(x.id)),
  );
  function commit(next, message) {
    try {
      if (localStorage.getItem(key) !== lastSaved.current) {
        setState(read());
        lastSaved.current = localStorage.getItem(key);
        setDialog(null);
        setNotice(
          "Sharing changed elsewhere. Review the current access before trying again.",
        );
        return;
      }
      const currentUsers = loadResourceState().users.filter(
        (user) => user.status === "active",
      );
      const targets =
        dialog?.kind === "partner-add" || dialog?.kind === "invite"
          ? [userId]
          : dialog?.kind === "accept"
            ? dialog.request.members
            : [];
      if (targets.some((id) => !currentUsers.some((user) => user.id === id))) {
        setNotice("An account is no longer available. Review your selection.");
        setDialog(null);
        return;
      }
      const value = {
        ...next,
        history: [message, ...state.history].slice(0, 30),
      };
      const serialized = JSON.stringify(value);
      localStorage.setItem(key, serialized);
      lastSaved.current = serialized;
      setState(value);
      setNotice(message);
      setDialog(null);
    } catch {
      setNotice("Device storage is unavailable. No changes were saved.");
    }
  }
  function confirm() {
    if (dialog.kind === "partner-add") {
      const existing = state.partners.find((x) => x.id === userId);
      commit(
        {
          ...state,
          partners: existing
            ? state.partners.map((x) =>
                x.id === userId ? { ...x, outgoing: true } : x,
              )
            : [
                ...state.partners,
                {
                  id: userId,
                  incoming: false,
                  outgoing: true,
                  inTimeline: false,
                },
              ],
        },
        `Sharing with ${person(userId)} enabled in this preview.`,
      );
    }
    if (dialog.kind === "partner-remove")
      commit(
        {
          ...state,
          partners: state.partners
            .map((x) => (x.id === dialog.id ? { ...x, outgoing: false } : x))
            .filter((x) => x.incoming || x.outgoing),
        },
        `Stopped sharing with ${person(dialog.id)}.`,
      );
    if (dialog.kind === "invite")
      commit(
        { ...state, sent: [...state.sent, userId] },
        `Invitation for ${person(userId)} added to the preview.`,
      );
    if (dialog.kind === "accept")
      commit(
        {
          ...state,
          members: ["taylor", ...dialog.request.members],
          sent: [],
          received: state.received.filter((x) => x.id !== dialog.request.id),
        },
        `Joined ${dialog.request.name}.`,
      );
    if (dialog.kind === "leave")
      commit(
        { ...state, members: ["taylor"], sent: [] },
        "Left the recognition group. Original libraries are retained.",
      );
  }
  return (
    <div className="cc-sharing-workspace">
      <div className="cc-sharing-intro">
        <div>
          <h3>{partnerPage ? "Partner libraries" : "Recognition groups"}</h3>
          <p>
            {partnerPage
              ? "Manage who can see your library and whose shared photos appear in your timeline."
              : "Choose whose recognition results help organize people in your library."}
          </p>
        </div>
        <Button
          primary
          disabled={!choices.length}
          onClick={() => {
            setUserId(choices[0]?.id || "");
            setDialog({ kind: partnerPage ? "partner-add" : "invite" });
          }}
        >
          {partnerPage ? "Add partner" : "Invite a member"}
        </Button>
      </div>
      {notice && (
        <p role="status" className="cc-notice">
          {notice}
        </p>
      )}
      {partnerPage ? (
        <div className="cc-sharing-list">
          {state.partners.length ? (
            state.partners.map((partner) => (
              <article key={partner.id}>
                <Icon name="mdiAccountOutline" />
                <div>
                  <strong>{person(partner.id)}</strong>
                  <p>
                    {partner.outgoing
                      ? "Can see your library"
                      : "You are not sharing with this account"}{" "}
                    ·{" "}
                    {partner.incoming
                      ? "Shares with you"
                      : "Does not share with you"}
                  </p>
                  {partner.incoming && (
                    <label>
                      <input
                        type="checkbox"
                        checked={partner.inTimeline}
                        onChange={(event) =>
                          commit(
                            {
                              ...state,
                              partners: state.partners.map((x) =>
                                x.id === partner.id
                                  ? { ...x, inTimeline: event.target.checked }
                                  : x,
                              ),
                            },
                            "Personal timeline preference updated.",
                          )
                        }
                      />
                      Show shared photos in my timeline
                    </label>
                  )}
                </div>
                {partner.outgoing && (
                  <Button
                    onClick={() =>
                      setDialog({ kind: "partner-remove", id: partner.id })
                    }
                  >
                    Stop sharing
                  </Button>
                )}
              </article>
            ))
          ) : (
            <p>No partner libraries connected.</p>
          )}
        </div>
      ) : (
        <>
          <div className="cc-sharing-list">
            {state.members.map((id) => (
              <article key={id}>
                <Icon name="mdiAccountOutline" />
                <div>
                  <strong>{person(id)}</strong>
                  <p>
                    {id === "taylor"
                      ? "Your account"
                      : "Recognition group member"}
                  </p>
                </div>
              </article>
            ))}
          </div>
          <div className="cc-section-action">
            <Button onClick={() => onNavigate("processing", "queues")}>
              Re-run face recognition
            </Button>
            <Button
              disabled={state.members.length < 2}
              onClick={() => setDialog({ kind: "leave" })}
            >
              Leave group
            </Button>
          </div>
          <h3>Invitations</h3>
          {state.received.map((request) => (
            <div className="cc-sharing-request" key={request.id}>
              <span>
                <strong>{request.name}</strong>
                <small>
                  Invited by {request.members.map(person).join(", ")}
                </small>
              </span>
              <Button onClick={() => setDialog({ kind: "accept", request })}>
                Review invitation
              </Button>
              <Button
                onClick={() =>
                  commit(
                    {
                      ...state,
                      received: state.received.filter(
                        (x) => x.id !== request.id,
                      ),
                    },
                    "Invitation declined.",
                  )
                }
              >
                Decline
              </Button>
            </div>
          ))}
          {state.sent.map((id) => (
            <div className="cc-sharing-request" key={id}>
              <span>
                <strong>{person(id)}</strong>
                <small>Awaiting response</small>
              </span>
              <Button
                onClick={() =>
                  commit(
                    { ...state, sent: state.sent.filter((x) => x !== id) },
                    "Invitation cancelled.",
                  )
                }
              >
                Cancel invitation
              </Button>
            </div>
          ))}
          {!state.received.length && !state.sent.length && (
            <p className="cc-subtle">No pending invitations.</p>
          )}
        </>
      )}
      {dialog && (
        <Dialog
          title={
            {
              "partner-add": "Review partner access",
              "partner-remove": "Stop sharing your library",
              invite: "Invite to recognition group",
              accept: "Review recognition group",
              leave: "Leave recognition group",
            }[dialog.kind]
          }
          close={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                primary
                disabled={
                  ["partner-add", "invite"].includes(dialog.kind) &&
                  !choices.some((x) => x.id === userId)
                }
                onClick={confirm}
              >
                {dialog.kind === "accept" ? "Accept invitation" : "Confirm"}
              </Button>
            </>
          }
        >
          {["partner-add", "invite"].includes(dialog.kind) && (
            <label>
              Account
              <select
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              >
                {choices.map((user) => (
                  <option value={user.id} key={user.id}>
                    {user.name} · {user.email}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p>
            {dialog.kind === "partner-add"
              ? `${person(userId)} will see photos and videos allowed by your sharing policy. Private media stays restricted. This action does not ask them to share their library.`
              : dialog.kind === "partner-remove"
                ? `${person(dialog.id)} loses the access you granted to your library. Their originals and any access they granted you are retained.`
                : dialog.kind === "invite"
                  ? "The recipient reviews membership before joining. Recognition membership does not grant unrestricted photo access."
                  : dialog.kind === "accept"
                    ? `Members: ${dialog.request.members.map(person).join(", ")}. Joining changes your recognition group; your original files remain in your account.`
                    : "You will have your own recognition group. Your originals and partner-sharing choices remain available."}
          </p>
          <small>
            Interactive preview · no invitations or messages are sent.
          </small>
        </Dialog>
      )}
    </div>
  );
}
