// Playwright spec for the fixture app. Runs with `npx playwright test` once @playwright/test is
// installed in a copy of the fixture (Phase 4 does that). Not part of the plugin's own tests.
import { test, expect } from "@playwright/test";

test("the page lists the seeded todos and adds a new one", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/");
  await expect(page.getByRole("heading", { name: "Todos" })).toBeVisible();
  await expect(page.locator("#list li")).toHaveCount(2);
  await page.fill("#text", "Buy milk");
  await page.click("text=Add");
  await expect(page.locator("#list li", { hasText: "Buy milk" })).toBeVisible();
  await expect(page.locator("#count")).toContainText("2 left");
});
