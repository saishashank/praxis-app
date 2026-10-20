// Result codes of the card-note action and the plain text shown for each. No internals.
export type NoteResult = { ok: true } | { error: string };

const NOTE_ERROR_TEXT: Record<string, string> = {
  invalid: "Write a note of 1 to 1,000 characters.",
  not_found: "This card was not found.",
  forbidden: "You do not have access to add notes.",
  unavailable: "Something went wrong and the note was not saved. Please try again.",
};

export const noteErrorText = (code: string): string =>
  NOTE_ERROR_TEXT[code] ?? NOTE_ERROR_TEXT.unavailable!;
