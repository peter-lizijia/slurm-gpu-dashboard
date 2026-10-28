import { expect, test } from "@playwright/test";

test("demo is local, responsive, themed and has an expandable GPU map", async ({ page }) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:5179/") && !request.url().startsWith("data:")) {
      external.push(request.url());
    }
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Slurm GPU Dashboard" })).toBeVisible();
  await expect(page.getByText("Sample", { exact: true })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: /Show per-node GPU map/ }).first().click();
  await expect(page.getByRole("button", { name: /Hide per-node GPU map/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("demo supports create/edit/delete, replaceable GPU input and conflict checks", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByLabel(/Slurm username/).fill("alex");
  const gpus = page.getByLabel("GPUs", { exact: true });
  await gpus.fill("");
  await expect(gpus).toHaveValue("");
  await gpus.fill("16");
  await expect(page.getByText(/Only \d+ of ATLAS's/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Book", exact: true })).toBeDisabled();
  await gpus.fill("1");
  await page.getByLabel("Note", { exact: true }).fill("Browser test reservation");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Book", exact: true }).click();
  await expect(page.getByText(/Browser test reservation/)).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "Browser test reservation" });
  await row.getByRole("button", { name: "Edit reservation", exact: true }).click();
  await page.getByLabel("Note", { exact: true }).fill("Edited browser reservation");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.getByText(/Edited browser reservation/)).toBeVisible();
  const editedRow = page.getByRole("listitem").filter({ hasText: "Edited browser reservation" });
  page.once("dialog", (dialog) => dialog.accept());
  await editedRow.getByRole("button", { name: "Delete reservation", exact: true }).click();
  await expect(page.getByText(/Edited browser reservation/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete reservation", exact: true })).toHaveCount(4);
});
