import {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  List,
  openExtensionPreferences,
  showHUD,
  showInFinder,
  showToast,
  Toast,
  Keyboard,
} from "@raycast/api";
import { useCachedPromise, usePromise } from "@raycast/utils";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { useEffect, useState } from "react";
import { ConnectError, fileName, saveNew, type Asset, type Variant } from "./lib/connect.ts";
import { forgetSignIn, openSession, tempDir, type Session } from "./lib/session.ts";

let sessionPromise: Promise<Session> | undefined;
async function reconnect(forgetLibrary = false) {
  await forgetSignIn(forgetLibrary);
  sessionPromise = undefined;
}

/** One connection per command run, retried after a failure. */
export function getSession(): Promise<Session> {
  return (sessionPromise ??= openSession().catch((error) => {
    sessionPromise = undefined;
    throw error;
  }));
}

export const errorText = (error: unknown) =>
  error instanceof ConnectError ? error.message : "Something went wrong. Try again.";

export function ErrorView({ error, retry }: { error: unknown; retry: () => void }) {
  const kind = error instanceof ConnectError ? error.kind : "server";
  const needsSignIn = kind === "revoked" || kind === "declined" || kind === "identity";
  return (
    <List.EmptyView
      icon={kind === "offline" ? Icon.WifiDisabled : needsSignIn ? Icon.Plug : Icon.Warning}
      title={kind === "offline" ? "Library unavailable" : needsSignIn ? "Not connected" : "Couldn’t load"}
      description={errorText(error)}
      actions={
        <ActionPanel>
          {needsSignIn ? (
            <Action
              title="Connect Again"
              icon={Icon.Plug}
              onAction={async () => {
                await reconnect(kind === "identity");
                retry();
              }}
            />
          ) : (
            <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={retry} />
          )}
          <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    />
  );
}

async function withToast(title: string, task: () => Promise<string | void>) {
  const toast = await showToast({ style: Toast.Style.Animated, title });
  try {
    const done = await task();
    if (done) await showHUD(done);
    else await toast.hide();
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = errorText(error);
  }
}

async function download(asset: Asset, variant: Variant) {
  const { api } = await getSession();
  const { bytes, type } = await api.rendition(asset.id, variant);
  const path = await saveNew(
    join(homedir(), "Downloads"),
    asset,
    type,
    bytes,
    variant === "original" ? " original" : "",
  );
  await showInFinder(path);
}

async function copyImage(asset: Asset) {
  const { api } = await getSession();
  const { bytes, type } = await api.rendition(asset.id, "display");
  // The clipboard holds a file reference, so keep only the most recent copy on disk.
  const dir = tempDir("clipboard");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName(asset, type));
  await writeFile(path, bytes);
  await Clipboard.copy({ file: path });
}

function AssetActions({ asset, session, reload }: { asset: Asset; session?: Session; reload: () => void }) {
  const url = session ? `${session.api.origin}/photos/${asset.id}` : undefined;
  return (
    <ActionPanel>
      <ActionPanel.Section>
        {url && <Action.OpenInBrowser title="Open in Frameleaf" url={url} />}
        {asset.type === "IMAGE" && (
          <Action
            title="Copy Image"
            icon={Icon.CopyClipboard}
            shortcut={Keyboard.Shortcut.Common.Copy}
            onAction={() => withToast("Copying image…", async () => (await copyImage(asset), "Copied image"))}
          />
        )}
        {url && (
          <Action.CopyToClipboard
            title="Copy Link"
            content={url}
            shortcut={{
              macOS: { modifiers: ["cmd", "shift"], key: "l" },
              Windows: { modifiers: ["ctrl", "shift"], key: "l" },
            }}
          />
        )}
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title={asset.type === "VIDEO" ? "Download Still" : "Download"}
          icon={Icon.Download}
          shortcut={{ macOS: { modifiers: ["cmd"], key: "d" }, Windows: { modifiers: ["ctrl"], key: "d" } }}
          onAction={() => withToast("Downloading…", () => download(asset, "display"))}
        />
        {session?.originalsAllowed && (
          <Action
            title="Download Original"
            icon={Icon.SaveDocument}
            shortcut={{
              macOS: { modifiers: ["cmd", "shift"], key: "d" },
              Windows: { modifiers: ["ctrl", "shift"], key: "d" },
            }}
            onAction={() => withToast("Downloading original…", () => download(asset, "original"))}
          />
        )}
        {session?.originalsNeedConsent && (
          <Action
            title="Allow Original Downloads"
            icon={Icon.Lock}
            onAction={async () => {
              await reconnect();
              reload();
            }}
          />
        )}
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title="Reload"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={reload}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

/** Fetches a preview only for the selected item, into a folder cleared when the command opens and closes. */
function AssetDetail({ asset }: { asset: Asset }) {
  const { data: path, error } = usePromise(
    async (id: string) => {
      const { api } = await getSession();
      const { bytes, type } = await api.rendition(id, "preview");
      const dir = tempDir("previews");
      await mkdir(dir, { recursive: true });
      const file = join(dir, fileName(asset, type));
      await writeFile(file, bytes);
      return file;
    },
    [asset.id],
  );
  const image = path ? `![](${pathToFileURL(path).href}?raycast-height=320)` : error ? errorText(error) : "";
  return (
    <List.Item.Detail
      isLoading={!path && !error}
      markdown={[image, asset.description ?? ""].filter(Boolean).join("\n\n")}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="Taken" text={new Date(asset.createdAt).toLocaleString()} />
          <List.Item.Detail.Metadata.Label title="Type" text={asset.type === "VIDEO" ? "Video" : "Photo"} />
          {asset.width && asset.height ? (
            <List.Item.Detail.Metadata.Label title="Size" text={`${asset.width} × ${asset.height}`} />
          ) : null}
          {asset.duration ? (
            <List.Item.Detail.Metadata.Label title="Length" text={`${Math.round(asset.duration / 1000)} s`} />
          ) : null}
        </List.Item.Detail.Metadata>
      }
    />
  );
}

const PAGE_SIZE = 50;
type Filter = "all" | "IMAGE" | "VIDEO";

export function AssetList({ albumId, navigationTitle }: { albumId?: string; navigationTitle?: string }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const { data: session, revalidate: refreshSession } = usePromise(getSession);

  useEffect(() => {
    const clear = () => rm(tempDir("previews"), { recursive: true, force: true });
    void clear();
    return () => void clear();
  }, []);

  const { data, isLoading, error, pagination, revalidate } = useCachedPromise(
    (q: string, type: Filter, album?: string) =>
      async ({ page }: { page: number }) => {
        const { api } = await getSession();
        const result = await api.assets({
          q: q.trim() || undefined,
          albumId: album,
          type: type === "all" ? undefined : type,
          page: page + 1,
          size: PAGE_SIZE,
        });
        return { data: result.items, hasMore: (page + 1) * PAGE_SIZE < result.total };
      },
    [query, filter, albumId],
    {
      keepPreviousData: true,
      onError: (failure) => void showToast({ style: Toast.Style.Failure, title: errorText(failure) }),
    },
  );

  const reload = () => {
    refreshSession();
    revalidate();
  };

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={!!data?.length}
      navigationTitle={navigationTitle}
      searchBarPlaceholder="Search file names and captions"
      onSearchTextChange={setQuery}
      throttle
      pagination={pagination}
      onSelectionChange={setSelected}
      searchBarAccessory={
        <List.Dropdown tooltip="Type" onChange={(value) => setFilter(value as Filter)} storeValue>
          <List.Dropdown.Item title="Photos and Videos" value="all" />
          <List.Dropdown.Item title="Photos" value="IMAGE" />
          <List.Dropdown.Item title="Videos" value="VIDEO" />
        </List.Dropdown>
      }
    >
      {error && !data?.length ? (
        <ErrorView error={error} retry={reload} />
      ) : (
        <>
          <List.EmptyView icon={Icon.Image} title={query ? "No matches" : "Nothing here yet"} />
          {data?.map((asset) => (
            <List.Item
              key={asset.id}
              id={asset.id}
              icon={asset.type === "VIDEO" ? Icon.Video : Icon.Image}
              title={asset.description?.split("\n")[0] || new Date(asset.createdAt).toLocaleDateString()}
              detail={selected === asset.id ? <AssetDetail asset={asset} /> : <List.Item.Detail isLoading />}
              actions={<AssetActions asset={asset} session={session} reload={reload} />}
            />
          ))}
        </>
      )}
    </List>
  );
}
