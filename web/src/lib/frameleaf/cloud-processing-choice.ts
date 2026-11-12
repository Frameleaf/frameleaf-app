import { getUserPreferencesAdmin, searchUsersAdmin } from '@frameleaf/sdk';

/**
 * FL-1484: each person's own choice of whether AI work on their photos may use Frameleaf Cloud (Your
 * preferences › Where your photos are processed). Administrators see it in Computers; only the person
 * changes it.
 */
export type PersonCloudChoice = { id: string; name: string; home: boolean };

/** Everyone on this server and their choice, for an administrator. Nothing readable: an empty list. */
export const loadCloudChoices = async (): Promise<PersonCloudChoice[]> => {
  try {
    const users = ((await searchUsersAdmin({})) ?? []).filter((user) => !user.deletedAt);
    return await Promise.all(
      users.map(async (user) => {
        const preferences = await getUserPreferencesAdmin({ id: user.id });
        return { id: user.id, name: user.name, home: preferences?.cloudProcessing?.enabled === false };
      }),
    );
  } catch {
    return [];
  }
};

/** The people who keep their photos at home, by name, for a sentence. */
export const keptHome = (choices: readonly PersonCloudChoice[]): string[] =>
  choices.filter((choice) => choice.home).map((choice) => choice.name);
