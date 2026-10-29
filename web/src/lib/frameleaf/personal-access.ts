/**
 * Personal account access (FL-67): the rules behind the design template's `PersonalAccess` and
 * `PersonalForm` (`design/frameleaf/template/src/AccountsLibraries.jsx`), kept free of Svelte so
 * they can be tested on their own. Every action goes to the account's own endpoints; nothing here
 * stores a password, PIN, key or activation key.
 */
import { Permission, type ApiKeyResponseDto, type SessionResponseDto } from '@frameleaf/sdk';

/** The server's minimum for a new password (`ChangePasswordDto`). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const API_KEY_NAME_MAX_LENGTH = 100;

export type PasswordFormError = 'required' | 'too_short' | 'mismatch' | 'unchanged';

/** Why a password change cannot be sent yet, or undefined when it can. */
export const passwordFormError = (form: {
  current: string;
  next: string;
  confirm: string;
}): PasswordFormError | undefined => {
  if (!form.current || !form.next || !form.confirm) {
    return 'required';
  }
  if (form.next.length < PASSWORD_MIN_LENGTH) {
    return 'too_short';
  }
  if (form.next !== form.confirm) {
    return 'mismatch';
  }
  if (form.next === form.current) {
    return 'unchanged';
  }
  return undefined;
};

/** A complete PIN as the shared six-cell entry produces it. */
export const isCompletePin = (pin: string) => /^\d{6}$/.test(pin);

export type PinDialogMode = 'create' | 'change' | 'clear' | 'reset';

/** Whether a PIN form can be sent. `reset` uses the account password instead of the PIN. */
export const canSubmitPin = (
  mode: PinDialogMode,
  form: { current: string; next: string; confirm: string; password: string },
) => {
  switch (mode) {
    case 'create': {
      return isCompletePin(form.next) && form.next === form.confirm;
    }
    case 'change': {
      return isCompletePin(form.current) && isCompletePin(form.next) && form.next === form.confirm;
    }
    case 'clear': {
      return isCompletePin(form.current);
    }
    case 'reset': {
      return form.password.length > 0;
    }
  }
};

/** Every grantable permission except full access, in the server's order. */
/** Every permission a key holds; design permissions are reported in their own field. */
export const keyPermissions = (key: ApiKeyResponseDto): Permission[] => [
  ...(key.permissions as string[] as Permission[]),
  ...((key.designPermissions ?? []) as string[] as Permission[]),
];

export const INDIVIDUAL_PERMISSIONS: readonly Permission[] = Object.values(Permission).filter(
  (permission) => permission !== Permission.All,
);

/**
 * The permissions to send for a key. Choosing full access, or every individual permission, is
 * sent as `all`, as the previous key editor did; otherwise the choices are sent as they are.
 */
export const normalizeKeyPermissions = (selected: Permission[]): Permission[] => {
  const unique = [...new Set(selected)];
  if (unique.includes(Permission.All)) {
    return [Permission.All];
  }
  if (INDIVIDUAL_PERMISSIONS.every((permission) => unique.includes(permission))) {
    return [Permission.All];
  }
  return unique;
};

/**
 * FL-367: what a new key is for, in place of choosing from every permission. Each purpose is a
 * fixed list of existing permissions; "View only" does not download originals (defaulted on FL-367,
 * the owner's question is open), and "View and upload" may not change albums.
 *
 * `capture` is the "Browser extension" purpose (FL-622, `ApiKeys.jsx`): it saves images, links and
 * screenshots into Boards and lists the collections and tags to file them, and cannot see photos.
 * The order is the prototype's, with the browser extension just before Everything.
 */
export type KeyPurpose = 'view' | 'upload' | 'capture' | 'view-upload' | 'everything';
export const KEY_PURPOSES: readonly KeyPurpose[] = ['view', 'upload', 'view-upload', 'capture', 'everything'];
const VIEW_PERMISSIONS: readonly Permission[] = [
  Permission.AssetRead,
  Permission.AssetView,
  Permission.AlbumRead,
  Permission.TimelineRead,
  Permission.MemoryRead,
  Permission.PersonRead,
  Permission.TagRead,
  Permission.StackRead,
  Permission.MapRead,
];
export const PURPOSE_PERMISSIONS: Readonly<Record<KeyPurpose, readonly Permission[]>> = {
  view: VIEW_PERMISSIONS,
  upload: [Permission.AssetUpload],
  capture: [Permission.CaptureCreate, Permission.CaptureCatalogRead],
  'view-upload': [...VIEW_PERMISSIONS, Permission.AssetUpload],
  everything: [Permission.All],
};

/** The purpose a set of permissions matches exactly, or `custom` for anything else. */
export const keyPurpose = (permissions: readonly Permission[]): KeyPurpose | 'custom' => {
  const chosen = new Set(permissions);
  return (
    KEY_PURPOSES.find((purpose) => {
      const wanted = PURPOSE_PERMISSIONS[purpose];
      return wanted.length === chosen.size && wanted.every((permission) => chosen.has(permission));
    }) ?? 'custom'
  );
};

/** The permissions a key can grant that remove things, which the editor warns about. */
export const keyCanDelete = (permissions: Permission[]) =>
  permissions.some((permission) => permission === Permission.All || permission.endsWith('.delete'));

/** Permissions whose name contains the search, full access first. */
export const filterPermissions = (query: string): Permission[] => {
  const needle = query.trim().toLowerCase();
  return [Permission.All, ...INDIVIDUAL_PERMISSIONS].filter(
    (permission) => !needle || permission.toLowerCase().includes(needle),
  );
};

/** A key's permissions for its list row: the first few and how many more there are. */
export const summarizePermissions = (permissions: Permission[], shown = 4) => ({
  shown: permissions.slice(0, shown),
  more: Math.max(0, permissions.length - shown),
});

/** Signed-in devices other than this one, which "Sign out other devices" removes. */
export const otherSessions = (sessions: SessionResponseDto[]) => sessions.filter((session) => !session.current);

/** This device first, then the most recently active. */
export const sortSessions = (sessions: SessionResponseDto[]) =>
  [...sessions].sort(
    (a, b) => Number(b.current) - Number(a.current) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );

/** How a device is named in the list, from what the client reported. */
export const sessionDeviceName = (session: SessionResponseDto, unknown: string) =>
  [session.deviceOS, session.deviceType].filter((part) => part && part.trim()).join(' · ') || unknown;

/**
 * The provider account-management address, only when it is an http(s) URL. Anything else is
 * treated as not configured rather than opened.
 */
export const providerAccountLink = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** The extensions the server accepts for a profile photo (`mimeTypes.isProfile`). */
export const PROFILE_IMAGE_EXTENSIONS = ['.avif', '.dng', '.heic', '.heif', '.jpeg', '.jpg', '.png', '.webp', '.svg'];

/** Whether a chosen file can be sent as a profile photo; the server checks it again. */
export const isProfileImageFile = (file: Pick<File, 'name' | 'size'>) => {
  const name = file.name.toLowerCase();
  return file.size > 0 && PROFILE_IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
};
