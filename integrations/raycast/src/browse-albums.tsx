import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { AssetList, ErrorView, getSession, libraryKey, showFailure } from "./components.tsx";

export default function Command() {
  const { data, isLoading, error, revalidate } = useCachedPromise(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the address is only part of the cache key
    async (library: string) => (await getSession()).api.albums(),
    [libraryKey()],
    { keepPreviousData: true, onError: (failure) => showFailure(failure, () => revalidate()) },
  );
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter albums">
      {error && !data?.length ? (
        <ErrorView error={error} retry={revalidate} />
      ) : (
        <>
          <List.EmptyView
            icon={Icon.Folder}
            title="No albums"
            description="Choose which albums Raycast can read when you connect, or later in your Library’s settings."
          />
          {data?.map((album) => (
            <List.Item
              key={album.id}
              icon={album.workspace === "design" ? Icon.Brush : Icon.Folder}
              title={album.name}
              actions={
                <ActionPanel>
                  <Action.Push
                    title="Show Photos"
                    icon={Icon.Image}
                    target={<AssetList albumId={album.id} navigationTitle={album.name} />}
                  />
                  <Action title="Reload" icon={Icon.ArrowClockwise} onAction={revalidate} />
                </ActionPanel>
              }
            />
          ))}
        </>
      )}
    </List>
  );
}
