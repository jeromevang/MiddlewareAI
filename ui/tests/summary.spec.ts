import { test } from "@playwright/test";

const SUMMARY_URL = process.env.SUMMARY_URL || "http://localhost:5174/summary";

test("summary page loads", async ({ page }) => {
  page.on("console", (msg) => {
    console.log(`[browser:${msg.type()}] ${msg.text()}`);
  });
  await page.goto(SUMMARY_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
});
