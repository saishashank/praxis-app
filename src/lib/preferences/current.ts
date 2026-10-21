// The signed-in user's theme for the root layout (UXN-280). Never throws: signed out or any
// failure means the default theme.
import { getCurrentUser } from "@/lib/auth/session";
import { userPreferences } from "./read";
import { DEFAULT_PREFERENCES, type Preferences } from "./service";

export async function currentTheme(): Promise<Preferences["theme"]> {
  try {
    const user = await getCurrentUser();
    return user ? (await userPreferences(user.id)).theme : DEFAULT_PREFERENCES.theme;
  } catch {
    return DEFAULT_PREFERENCES.theme;
  }
}

// The look of the page for the root layout: theme (UXN-280) and the Motion switch (UXN-281).
export async function currentLook(): Promise<Pick<Preferences, "theme" | "motion">> {
  try {
    const user = await getCurrentUser();
    const p = user ? await userPreferences(user.id) : DEFAULT_PREFERENCES;
    return { theme: p.theme, motion: p.motion };
  } catch {
    return { theme: DEFAULT_PREFERENCES.theme, motion: DEFAULT_PREFERENCES.motion };
  }
}
