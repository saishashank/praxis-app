import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("owner records sharing acknowledgement and adds a viewer (ROL-104, ROL-107)", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.goto("/users");

  await expect(page.getByText("Acknowledge sharing first")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add user" })).toBeDisabled();

  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Record acknowledgement" }).click();
  await expect(page.getByText(/Recorded .* by owner@praxis\.test/)).toBeVisible();

  await page.getByLabel("Google email").fill("new.viewer@praxis.test");
  await page.getByRole("button", { name: "Add user" }).click();

  const users = page.getByRole("table", { name: "Allowlisted users" });
  await expect(users.getByRole("rowheader", { name: "new.viewer@praxis.test" })).toBeVisible();

  const audit = page.getByRole("table", { name: "Audit log" });
  await expect(
    audit.getByRole("row").filter({ hasText: "owner@praxis.test" }).first(),
  ).toBeVisible();
  await expect(audit.getByText(/user\.add|add/i).first()).toBeVisible();
});
