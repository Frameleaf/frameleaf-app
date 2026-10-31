/**
 * FL-426: "First line of an invitation" (`templates.email.invitationFirstLine`), the greeting at the
 * top of an invitation email in place of the standard "Hey {name}!". It is one line of plain text:
 * spaces and line breaks run together, and `{recipientName}` and `{senderName}` become the names.
 * Undefined when none is set, so the email keeps its standard greeting.
 */
export const invitationFirstLine = (
  line: string | undefined,
  names: { recipientName: string; senderName: string },
): string | undefined => {
  const text = (line ?? '').replaceAll(/\s+/g, ' ').trim();
  if (!text) {
    return;
  }
  // replacer functions: a name is inserted as written, never read as a `$&` pattern
  return text
    .replaceAll('{recipientName}', () => names.recipientName)
    .replaceAll('{senderName}', () => names.senderName);
};
