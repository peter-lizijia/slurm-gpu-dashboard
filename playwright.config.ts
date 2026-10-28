import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:5179",
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    timezoneId: "America/New_York",
    colorScheme: "light",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1050 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5179 --strictPort",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: false,
    env: { VITE_DATA_SOURCE: "demo" },
  },
});
