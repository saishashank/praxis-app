// Reading holdings from a screenshot (M21 B1, UXN-316, D-944, D-1220): not built. This stub is what the disabled control
// on /holdings calls; it reads nothing and answers "not available" (client-side OCR is a listed P3 follow-up).
export const OCR_NOT_AVAILABLE_TEXT = "Not available yet: screenshots are not read in this version";

export type OcrResult = { ok: false; error: "not_available" };

export async function OcrNotAvailable(): Promise<OcrResult> {
  return { ok: false, error: "not_available" };
}
