import { getAboutInfo, getVersionHistory } from '@frameleaf/sdk';
import { modalManager } from '@frameleaf/ui';
import AboutDialog from '$lib/components/frameleaf/AboutDialog.svelte';
import HelpFeedbackDialog from '$lib/components/frameleaf/HelpFeedbackDialog.svelte';
import { userInteraction } from '$lib/stores/user.svelte';

/**
 * The account menu's "Support and feedback" and "About Frameleaf" dialogs, shared with the command
 * palette's actions of the same name (CommandPalette.jsx, SHELL-P3) so both open the same thing.
 * The server's about details are read once per session and reused.
 */
export const openSupportDialog = async () => {
  const info = userInteraction.aboutInfo ?? (await getAboutInfo());
  await modalManager.show(HelpFeedbackDialog, { info });
};

export const openAboutDialog = async () => {
  const [info, versions] = await Promise.all([
    userInteraction.aboutInfo ?? getAboutInfo(),
    userInteraction.versions ?? getVersionHistory(),
  ]);
  userInteraction.aboutInfo = info;
  userInteraction.versions = versions;
  await modalManager.show(AboutDialog, { info, versions });
};
