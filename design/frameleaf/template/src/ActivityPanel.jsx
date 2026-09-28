import React, { useEffect, useRef, useState } from "react";
import { Button } from "./App";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import { plural, timeAgo } from "./collections-data.mjs";
import "./collections.css";

/**
 * Comments & likes for a collection, or for one asset inside it when
 * `assetId` is set. Renders as a 320px right-side panel; on phones the
 * stylesheet turns it into a bottom sheet.
 */
export function ActivityPanel({
  activity = [],
  users = [],
  currentUserId = "taylor",
  assetId = null,
  assetName = "",
  onLike,
  onComment,
  onDelete,
  onClose,
  enabled = true,
  title,
}) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const list = useRef(null);
  const composer = useRef(null);
  const scoped = assetId
    ? activity.filter((entry) => entry.assetId === assetId)
    : activity;
  const likes = scoped.filter((entry) => entry.type === "like");
  const liked = likes.some((entry) => entry.userId === currentUserId);
  const comments = scoped
    .filter((entry) => entry.type === "comment")
    .sort((a, b) => a.at.localeCompare(b.at));
  const userFor = (id) =>
    users.find((user) => user.id === id) || { id, name: id };

  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [comments.length]);

  const send = () => {
    const text = draft.trim();
    if (!text || !enabled) return;
    onComment?.(text);
    setDraft("");
    setNote("Comment added");
    composer.current?.focus();
  };
  const likeLabel =
    likes.length === 0
      ? "No likes yet"
      : likes.length === 1
        ? `${likes[0].userId === currentUserId ? "You" : userFor(likes[0].userId).name} like${likes[0].userId === currentUserId ? "" : "s"} this`
        : plural(likes.length, "like");

  return (
    <aside
      className="activity-panel"
      aria-label={assetId ? "Activity for this item" : "Album activity"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose?.();
        }
      }}
    >
      <header className="ap-head">
        <div>
          <h2>{title || (assetId ? "This item" : "Activity")}</h2>
          {assetId && assetName && <small>{assetName}</small>}
        </div>
        <Button
          icon="mdiClose"
          aria-label="Close activity"
          onClick={onClose}
          data-initial-focus
        />
      </header>
      <div className="ap-likes">
        <button
          type="button"
          className={`ap-like${liked ? " on" : ""}`}
          aria-pressed={liked}
          disabled={!enabled}
          onClick={() => onLike?.()}
        >
          <Icon name={liked ? "mdiHeart" : "mdiHeartOutline"} />
          <span>{liked ? "Liked" : "Like"}</span>
        </button>
        <span className="ap-like-count">{likeLabel}</span>
      </div>
      {!enabled ? (
        <p className="ap-off">
          <Icon name="mdiCommentOutline" />
          Comments and likes are turned off for this collection. The owner
          can turn them back on under Options.
        </p>
      ) : (
        <>
          <ol className="ap-list" ref={list} aria-label="Comments">
            {comments.length === 0 && (
              <li className="ap-empty">
                No comments yet. Say something about{" "}
                {assetId ? "this item" : "this album"}.
              </li>
            )}
            {comments.map((entry) => {
              const user = userFor(entry.userId);
              const own = entry.userId === currentUserId;
              return (
                <li key={entry.id} className={`ap-item${own ? " own" : ""}`}>
                  <PersonAvatar person={user} size={28} />
                  <div className="ap-bubble">
                    <div className="ap-meta">
                      <strong>{own ? "You" : user.name}</strong>
                      <time dateTime={entry.at}>{timeAgo(entry.at)}</time>
                      {own && onDelete && (
                        <button
                          type="button"
                          className="ap-delete"
                          aria-label="Delete your comment"
                          title="Delete comment"
                          onClick={() => {
                            onDelete(entry.id);
                            setNote("Comment deleted");
                          }}
                        >
                          <Icon name="mdiDeleteOutline" />
                        </button>
                      )}
                    </div>
                    <p>{entry.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
          <form
            className="ap-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <PersonAvatar person={userFor(currentUserId)} size={28} />
            <textarea
              ref={composer}
              value={draft}
              rows={1}
              maxLength={2000}
              placeholder="Write a comment"
              aria-label="Write a comment"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <Button
              type="submit"
              primary
              icon="mdiArrowUp"
              aria-label="Send comment"
              disabled={!draft.trim()}
            />
          </form>
        </>
      )}
      <p className="ap-note" role="status" aria-live="polite">
        {note}
      </p>
    </aside>
  );
}
