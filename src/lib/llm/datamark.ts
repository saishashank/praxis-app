// Datamarking of untrusted text (LLM-073, D-246). Inside DATA blocks every whitespace run is replaced
// with one fixed character, so an instruction hidden in third-party text no longer reads as running
// prose and the model is told that marked text is data. The marker is a constant: the same input gives
// the same prompt, hence the same prompt hash. The injection phrase filter runs before this.

/** U+02C6 MODIFIER LETTER CIRCUMFLEX ACCENT. */
export const DATAMARK = "ˆ";

const WHITESPACE_RUN = new RegExp("\\s+", "g");

export function datamark(text: string): string {
  return text.replace(WHITESPACE_RUN, DATAMARK);
}
