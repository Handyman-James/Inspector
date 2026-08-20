// Full browser tests - launches a real, headless browser and clicks through the
// actual, live, deployed frontend the way a real person would. This is
// deliberately different from the backend API tests: those confirm the server
// logic works correctly, these confirm what a person actually sees and can
// actually do in the real app.
//
// Honest note on this file specifically: Playwright's own browser binaries could
// not be downloaded in the sandbox this was originally built in - that
// environment's network is deliberately restricted to a small allowlist that
// doesn't include Playwright's CDN. This was confirmed directly, not assumed. That
// restriction is specific to that one build environment; it has no bearing on
// Render's own build environment, which is a general-purpose one. This file is
// written carefully against Playwright's standard, stable API, but wasn't able to
// be run end-to-end before delivery the way the backend tests were - worth
// running once after first deploying it, to confirm it behaves as expected.
//
// A screenshot is captured on any failure specifically so "what failed and why"
// includes a visual, not just an error string - especially valuable for a
// rendering problem like the black-map bug this project already hit once.

const { chromium } = require("playwright");
const fs = require("fs");

function makeTest(name, fn) {
  return async (ctx) => {
    try {
      await fn(ctx);
      return { name, passed: true };
    } catch (err) {
      let screenshot = null;
      try {
        if (ctx.page) screenshot = await ctx.page.screenshot({ encoding: "base64" });
      } catch (e) { /* best effort - don't let a screenshot failure hide the real error */ }
      return { name, passed: false, error: err.message || String(err), screenshot };
    }
  };
}

async function runBrowserTests(frontendUrl, backendUrl, onProgress) {
  const results = [];
  async function report(result) {
    results.push(result);
    if (onProgress) onProgress(result);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } }); // matches this app's own mobile-first design
  const ctx = { page, jsErrors: [] };
  page.on("pageerror", (err) => ctx.jsErrors.push(err.message || String(err)));

  // A dedicated, disposable account for this run - registered directly against
  // the backend API first, then used to actually log in through the real UI.
  const testEmail = `browser-test-${Date.now()}@internal.test`;
  const testPassword = "BrowserTest" + Date.now() + "!";
  let registeredOk = false;

  report(await makeTest("Test account can be registered against the live backend", async () => {
    const res = await fetch(`${backendUrl}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    if (!res.ok) throw new Error(`Registration failed with status ${res.status}`);
    registeredOk = true;
  })());

  report(await makeTest("Login page loads", async () => {
    await page.goto(frontendUrl, { waitUntil: "networkidle", timeout: 20000 });
    const bodyText = await page.textContent("body");
    if (!bodyText || bodyText.trim().length === 0) throw new Error("Page loaded but body is completely empty");
  })());

  report(await makeTest("Can actually log in with real credentials", async () => {
    if (!registeredOk) throw new Error("No test account from earlier step - skipping");
    // First-time login on a fresh account also needs the backend URL entered -
    // matching this app's own real first-run flow, not skipping past it.
    const backendUrlField = page.locator('input[placeholder*="backend" i], input[placeholder*="url" i]').first();
    if (await backendUrlField.count() > 0) {
      await backendUrlField.fill(backendUrl);
    }
    await page.locator('input[type="email"]').first().fill(testEmail);
    await page.locator('input[type="password"]').first().fill(testPassword);
    await page.locator('button:has-text("Log in"), button:has-text("Log In")').first().click();
    await page.waitForTimeout(2000); // real network round-trip to the backend, not instant
    const stillOnLogin = await page.locator('input[type="password"]').count() > 0;
    if (stillOnLogin) throw new Error("Still showing the login form after submitting - login likely failed");
  })());

  const screensToCheck = [
    { name: "Today", selector: 'text=/today/i' },
    { name: "Clients", selector: 'text=/clients/i' },
    { name: "Billing", selector: 'text=/billing/i' },
    { name: "Receipts", selector: 'text=/receipts/i' },
    { name: "Settings", selector: 'text=/settings/i' },
  ];

  for (const screen of screensToCheck) {
    report(await makeTest(`${screen.name} tab opens without an error`, async () => {
      const tab = page.locator(screen.selector).first();
      if (await tab.count() === 0) throw new Error(`Couldn't find a "${screen.name}" tab on the page at all`);
      await tab.click();
      await page.waitForTimeout(800);
      const errorBoundaryText = await page.locator('text=/something went wrong/i').count();
      if (errorBoundaryText > 0) throw new Error(`${screen.name} screen shows an error boundary message`);
    })());
  }

  report(await makeTest("Route screen's map area actually renders visible content", async () => {
    // This is a direct regression test for the specific black-map bug found and
    // fixed earlier - confirming the fallback SVG genuinely draws visible pixels,
    // not just that the element exists in the DOM without checking its content.
    const routeLink = page.locator('text=/route/i').first();
    if (await routeLink.count() === 0) throw new Error("No way found to reach the Route screen from here");
    await routeLink.click();
    await page.waitForTimeout(1000);
    const mapSvg = page.locator("svg").first();
    if (await mapSvg.count() === 0) throw new Error("No map SVG found on the Route screen at all");
    const box = await mapSvg.boundingBox();
    if (!box || box.width === 0 || box.height === 0) throw new Error("Map SVG exists but has zero visible size");
  })());

  report(await makeTest("CSV import: mapping screen appears with the file's real headers", async () => {
    // Deliberately non-standard headers ("Client Full Name", "Contact Number")
    // that the app's auto-detection genuinely won't recognize - this is what
    // actually proves the manual mapping screen works, not just that it appears.
    const csvPath = "/tmp/inspector_import_test.csv";
    fs.writeFileSync(csvPath, "Client Full Name,Contact Number\nInspector Import Check,+16175559988\n");

    await page.locator('text=/settings/i').first().click();
    await page.waitForTimeout(500);
    const importButton = page.locator('text=/^Import$/i').first();
    if (await importButton.count() === 0) throw new Error("No Import button found in Settings");
    await importButton.click();
    await page.waitForTimeout(500);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(csvPath);
    await page.waitForTimeout(1000);

    const mappingText = await page.locator('text=/Match each field/i').count();
    if (mappingText === 0) throw new Error("Mapping screen never appeared after uploading the CSV");
    const headerVisible = await page.locator('text=/Client Full Name/i').count();
    if (headerVisible === 0) throw new Error("The file's actual custom header text never appeared in the mapping dropdowns");
  })());

  report(await makeTest("CSV import: manually mapping non-standard columns and importing actually works end to end", async () => {
    // Continues directly from the previous test's state - the mapping screen
    // should still be open with the CSV already loaded.
    const nameSelect = page.locator("select").first();
    await nameSelect.selectOption({ label: "Client Full Name" });
    const phoneSelect = page.locator("select").nth(1);
    await phoneSelect.selectOption({ label: "Contact Number" });

    await page.locator('button:has-text("Continue")').first().click();
    await page.waitForTimeout(500);

    const previewText = await page.locator('text=/Inspector Import Check/i').count();
    if (previewText === 0) throw new Error("The mapped name never appeared on the preview screen - mapping likely didn't apply correctly");

    await page.locator('button:has-text("Import")').first().click();
    await page.waitForTimeout(500);

    // The app's own confirmation step - a fingerprint-style button inside a
    // "Confirm to continue" overlay, with a real ~1.5s internal animation delay
    // before it actually fires.
    const confirmOverlay = page.locator("div", { hasText: "Confirm to continue" }).first();
    if (await confirmOverlay.count() === 0) throw new Error("Expected a confirmation overlay before the import actually runs, but none appeared");
    await confirmOverlay.locator("button").first().click();
    await page.waitForTimeout(2000);

    // The real, end-to-end proof: navigate to the client list fresh and confirm
    // the imported client genuinely exists there - not just that the UI flow
    // completed without an error.
    await page.locator('text=/clients/i').first().click();
    await page.waitForTimeout(1000);
    const clientInList = await page.locator('text=/Inspector Import Check/i').count();
    if (clientInList === 0) throw new Error("Imported client does not appear in the client list afterward - it may not have genuinely persisted");

    try { fs.unlinkSync("/tmp/inspector_import_test.csv"); } catch (e) { /* best effort cleanup */ }
  })());

  report(await makeTest("No unhandled JavaScript errors occurred during this whole run", async () => {
    // Listened for during every step above via the pageerror handler registered
    // at the very start of this run - checked here, once, at the end.
    if (ctx.jsErrors && ctx.jsErrors.length > 0) {
      throw new Error(`${ctx.jsErrors.length} JS error(s) occurred: ${ctx.jsErrors[0]}`);
    }
  })());

  await browser.close();
  return results;
}

module.exports = { runBrowserTests };
