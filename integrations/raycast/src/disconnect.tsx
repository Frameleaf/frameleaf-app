import { Alert, confirmAlert, showHUD, showToast, Toast } from "@raycast/api";
import { ConnectError } from "./lib/connect.ts";
import { disconnect } from "./lib/session.ts";

export default async function Command() {
  const confirmed = await confirmAlert({
    title: "Disconnect your Library?",
    message: "Raycast will lose access to your albums. Photos you already downloaded stay on this computer.",
    primaryAction: { title: "Disconnect", style: Alert.ActionStyle.Destructive },
  });
  if (!confirmed) return;
  try {
    await disconnect();
    await showHUD("Disconnected from your Library");
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Couldn’t disconnect",
      message:
        error instanceof ConnectError && error.kind === "offline"
          ? "Your Library can’t be reached, so Raycast kept its sign-in. Try again, or remove Raycast under Connected apps in your Library’s settings."
          : "Try again, or remove Raycast under Connected apps in your Library’s settings.",
    });
  }
}
