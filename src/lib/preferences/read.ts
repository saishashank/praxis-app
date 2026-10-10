// Server-side read of a user's preferences for rendering (time format on pages, theme in the root
// layout). Never throws: a database problem means defaults, so a preferences outage can not take
// pages down (UX-110 is cosmetic).
import { authDb } from "@/lib/db/client";
import { DEFAULT_PREFERENCES, getPreferences, type Preferences } from "./service";

export async function userPreferences(userId: number): Promise<Preferences> {
  try {
    return await getPreferences(authDb(), userId);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}
