import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { AssetList, ErrorView, errorText, getSession } from "./components.tsx";

export default function Command() {
  const { data, isLoading, error, revalidate } = useCachedPromise(async () => (await getSession()).api.albums(), [], {
    keepPreviousData: true,
    onError: (failure) => void showToast({ style: Toast.Style.Failure, title: errorText(failure) }),
  });
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
