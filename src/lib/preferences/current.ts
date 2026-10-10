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
