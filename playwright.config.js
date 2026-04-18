const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});
