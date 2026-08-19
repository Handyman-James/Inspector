const express = require("express");
const path = require("path");
const { runBackendTests } = require("./tests/backend-tests");
const { runBrowserTests } = require("./tests/browser-tests");

const app = express();
const PORT = process.env.PORT || 10000;

const BACKEND_URL = process.env.BACKEND_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  // The dashboard needs to know if it's actually configured before offering to
  // run anything - a clear setup message beats a confusing failure.
  res.json({ configured: Boolean(BACKEND_URL && FRONTEND_URL), backendUrl: BACKEND_URL, frontendUrl: FRONTEND_URL });
});

app.get("/api/run-tests", async (req, res) => {
  if (!BACKEND_URL || !FRONTEND_URL) {
    res.status(400).json({ error: "BACKEND_URL and FRONTEND_URL environment variables must both be set" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function sendEvent(type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    sendEvent("section-start", { section: "Backend API" });
    const backendResults = await runBackendTests(BACKEND_URL, (result) => sendEvent("result", { section: "Backend API", ...result }));

    sendEvent("section-start", { section: "Browser (live app)" });
    const browserResults = await runBrowserTests(FRONTEND_URL, BACKEND_URL, (result) => sendEvent("result", { section: "Browser (live app)", ...result }));

    const all = [...backendResults, ...browserResults];
    const passed = all.filter((r) => r.passed).length;
    sendEvent("done", { total: all.length, passed, failed: all.length - passed });
  } catch (err) {
    // A crash in the test runner itself is still something to surface clearly,
    // not something that should just hang the page with no explanation.
    sendEvent("fatal-error", { message: err.message || String(err) });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Handyman James test runner listening on port ${PORT}`);
  if (!BACKEND_URL || !FRONTEND_URL) {
    console.warn("BACKEND_URL and/or FRONTEND_URL not set - the dashboard will show a setup message until both are configured.");
  }
});
