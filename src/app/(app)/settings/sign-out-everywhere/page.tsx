// Settings > Sign out everywhere (no-JS confirm page for the Account row, UXR-027). Owner only.
// Red appears only on the confirm button.
import { requireUser } from "@/lib/auth/guard";
import { SettingsFrame } from "../SettingsNav";
import { signOutEverywhereSelfAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SignOutEverywherePage() {
  await requireUser("admin", "/settings/sign-out-everywhere");
  return (
    <SettingsFrame
      title="Sign out everywhere"
      intro="This ends your sessions on every device, including this one. You will need to sign in again."
    >
      <form action={signOutEverywhereSelfAction}>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-danger px-4 text-sm font-semibold text-accent-contrast"
        >
          Sign out everywhere
        </button>
      </form>
    </SettingsFrame>
  );
}
