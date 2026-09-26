# User Settings

Frameleaf gives each user the ability to manage their own settings. This includes being able to update their profile, toggle certain feature, generate API keys, manage the logged in devices, a view of account usage statistics, and more.

To open your settings:

1. Select your avatar in the top right corner of the screen.
2. Choose **Account settings**.

Settings opens on **Your preferences**, which holds your profile, library features and account access.

---

## Your account

Everything in this part of the settings changes only your own account.

- **Your profile**: upload or remove a profile photo, choose the avatar color shown when there is no photo, and change your display name and email. A photo the server cannot use leaves your current avatar in place.
- **Password**: enter your current password and the new one twice. **Sign out my other devices** is on by default; this device stays signed in.
- **Locked folder PIN**: create, change or clear the six-digit PIN that protects your Locked photos and videos. **Forgot your PIN?** clears it with your account password; when password sign-in is turned off, ask your administrator.
- **API keys**: create a key with only the permissions an application needs (or full access), edit its name and permissions, rotate it or delete it. A new or rotated key is shown once; the old value of a rotated key stops working at once.
- **Sign-in provider**: connect or disconnect your account from the server's sign-in provider, and open the provider's account page when your administrator configured one.
- **Signed-in devices**: see where your account is signed in, sign out one device or every device except this one.
- **Supporter status**: activate or remove personal supporter status with its key. Administrators also register or remove the server support key here, as a separate action.

## Locked tags & people

Choose which tags, people and pets stay Locked, and whether the rules cover only your own photos and videos or everything you can see. Nothing about the rules is shown until you unlock with your PIN, and they can only be changed while your session is unlocked.

- A tag inside a Locked tag is Locked too, and the list says so.
- A tag, person or pet that no longer exists stays in your rules, marked unavailable, until you remove it. Saving another change never unlocks it.
- If the rules were changed in another tab or on another device since you opened them, your changes are kept on screen and saving waits until you reload the latest rules. Changes to your other settings in the meantime do not get in the way.
- If your session locks before you save, your changes are dropped and you are asked to unlock again.

---

:::tip Reset Password
The admin can reset a user password through the [User Management](/administration/user-management.mdx) screen.
:::

:::tip Reset Admin Password
The admin password can be reset using a [Server Command](/administration/server-commands.md)
:::
