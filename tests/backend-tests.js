// Backend API tests - hits the real, live backend's real endpoints and confirms
// they behave correctly. Every test that creates data cleans up after itself,
// regardless of pass or fail, so repeated runs never accumulate junk in the real,
// live production database - the same lesson learned the hard way earlier tonight
// when a local test database wasn't reset between runs and produced misleading
// results.
//
// Deliberately does NOT trigger real SMS/email sends - that would text or email a
// real client's number every time someone runs this. Instead it confirms the
// dispatch endpoint responds sensibly (e.g. rejects a contact with no phone/email
// with a clear error), the same approach already used to test this path earlier
// in this build.

async function apiRequest(backendUrl, authToken, method, path, body) {
  const res = await fetch(`${backendUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Server responded with ${res.status}`);
  return data;
}

function makeTest(name, fn) {
  return async (ctx) => {
    try {
      await fn(ctx);
      return { name, passed: true };
    } catch (err) {
      return { name, passed: false, error: err.message || String(err) };
    }
  };
}

async function runBackendTests(backendUrl, onProgress) {
  const results = [];
  const cleanup = []; // functions to run at the end, regardless of pass/fail

  async function report(result) {
    results.push(result);
    if (onProgress) onProgress(result);
  }

  // A dedicated, disposable account for this run only - avoids needing any
  // pre-shared credential, and its own data gets cleaned up at the end.
  const testEmail = `test-runner-${Date.now()}@internal.test`;
  const testPassword = "TestRunner" + Date.now() + "!";
  let authToken = null;
  let createdClientId = null;
  let createdJobId = null;

  report(await makeTest("Health check responds", async () => {
    const health = await apiRequest(backendUrl, null, "GET", "/api/health");
    if (health.status !== "ok") throw new Error(`Expected status "ok", got "${health.status}"`);
  })());

  report(await makeTest("Registration creates a real account", async () => {
    const res = await apiRequest(backendUrl, null, "POST", "/api/auth/register", { email: testEmail, password: testPassword });
    if (!res.token) throw new Error("No token returned from registration");
    authToken = res.token;
  })());

  report(await makeTest("Login works with the same credentials", async () => {
    const res = await apiRequest(backendUrl, null, "POST", "/api/auth/login", { email: testEmail, password: testPassword });
    if (!res.token) throw new Error("No token returned from login");
  })());

  report(await makeTest("Rejects wrong password", async () => {
    // Checking for the specific, expected error message here matters - just
    // checking that "some error was thrown" would also pass if the server were
    // completely unreachable, which is a false positive, not a real pass. That
    // exact gap was caught directly while building this: an earlier version of
    // this test kept "passing" during a period when the whole server was down.
    let errorMessage = null;
    try {
      await apiRequest(backendUrl, null, "POST", "/api/auth/login", { email: testEmail, password: "wrong-password" });
    } catch (err) {
      errorMessage = err.message;
    }
    if (errorMessage === null) throw new Error("Login succeeded with an incorrect password - this should never happen");
    if (!errorMessage.toLowerCase().includes("incorrect")) throw new Error(`Got an error, but not the expected one - got: "${errorMessage}"`);
  })());

  report(await makeTest("Client can be created", async () => {
    if (!authToken) throw new Error("No auth token from earlier test - skipping");
    const client = await apiRequest(backendUrl, authToken, "POST", "/api/clients", { name: "Test Runner Client", phone: "+16175551234" });
    if (!client.id) throw new Error("No id returned for created client");
    createdClientId = client.id;
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/clients/${createdClientId}`).catch(() => {}));
  })());

  report(await makeTest("Client can be fetched back", async () => {
    if (!createdClientId) throw new Error("No client id from earlier test - skipping");
    const client = await apiRequest(backendUrl, authToken, "GET", `/api/clients/${createdClientId}`);
    if (client.name !== "Test Runner Client") throw new Error(`Expected "Test Runner Client", got "${client.name}"`);
  })());

  report(await makeTest("Job can be created for that client", async () => {
    if (!createdClientId) throw new Error("No client id from earlier test - skipping");
    const job = await apiRequest(backendUrl, authToken, "POST", "/api/jobs", {
      clientId: createdClientId, date: "2026-12-31", time: "Anytime", serviceType: "Test job", status: "scheduled",
      lineItems: [{ id: "r1", name: "Test service", price: 50 }], notes: "", photos: [],
    });
    if (!job.id) throw new Error("No id returned for created job");
    createdJobId = job.id;
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/jobs/${createdJobId}`).catch(() => {}));
  })());

  report(await makeTest("Invoice persists its sendMethod correctly", async () => {
    if (!createdClientId) throw new Error("No client id from earlier test - skipping");
    const invoice = await apiRequest(backendUrl, authToken, "POST", "/api/invoices", {
      clientId: createdClientId, total: 100, status: "sent", sendMethod: "email",
    });
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/invoices/${invoice.id}`).catch(() => {}));
    if (invoice.sendMethod !== "email") throw new Error(`sendMethod did not persist - expected "email", got "${invoice.sendMethod}"`);
  })());

  report(await makeTest("Estimate persists its sendMethod correctly", async () => {
    if (!createdClientId) throw new Error("No client id from earlier test - skipping");
    const estimate = await apiRequest(backendUrl, authToken, "POST", "/api/estimates", {
      clientId: createdClientId, rows: [{ id: "r1", description: "Test", laborHours: 1, laborRate: 85, partsCost: 0 }],
      subtotal: 85, total: 85, status: "sent", sendMethod: "sms",
    });
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/estimates/${estimate.id}`).catch(() => {}));
    if (estimate.sendMethod !== "sms") throw new Error(`sendMethod did not persist - expected "sms", got "${estimate.sendMethod}"`);
  })());

  report(await makeTest("Tax summary endpoint returns a well-formed response", async () => {
    const summary = await apiRequest(backendUrl, authToken, "GET", "/api/tax/summary?year=2026");
    if (typeof summary.totalRevenue !== "number") throw new Error("totalRevenue missing or not a number");
    if (typeof summary.totalDeductible !== "number") throw new Error("totalDeductible missing or not a number");
    if (!Array.isArray(summary.lineBreakdown)) throw new Error("lineBreakdown missing or not an array");
  })());

  report(await makeTest("Client relationships link and unlink correctly", async () => {
    if (!authToken) throw new Error("No auth token from earlier test - skipping");
    const clientB = await apiRequest(backendUrl, authToken, "POST", "/api/clients", { name: "Test Runner Client B" });
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/clients/${clientB.id}`).catch(() => {}));
    const linked = await apiRequest(backendUrl, authToken, "POST", "/api/clients", {
      name: "Test Runner Client C", relatedClientId: clientB.id, relationshipLabel: "Friend/family of",
    });
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/clients/${linked.id}`).catch(() => {}));
    if (linked.relatedClientId !== clientB.id) throw new Error("relatedClientId did not persist correctly");
  })());

  report(await makeTest("Message dispatch rejects a contact with no phone/email, without crashing", async () => {
    if (!authToken) throw new Error("No auth token from earlier test - skipping");
    const bareClient = await apiRequest(backendUrl, authToken, "POST", "/api/clients", { name: "No Contact Info" });
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/clients/${bareClient.id}`).catch(() => {}));
    let errorMessage = null;
    try {
      await apiRequest(backendUrl, authToken, "POST", "/api/messages", { clientId: bareClient.id, direction: "sent", body: "test", channel: "sms" });
    } catch (err) {
      errorMessage = err.message;
    }
    if (errorMessage === null) throw new Error("Expected a clean rejection for a contact with no phone number, but the request succeeded");
    if (!errorMessage.toLowerCase().includes("phone")) throw new Error(`Got an error, but not the expected one - got: "${errorMessage}"`);
  })());

  report(await makeTest("Multiple clients created in a batch all genuinely persist (import regression test)", async () => {
    // Direct regression test for a real bug found and fixed today: imported
    // clients previously only ever existed in temporary local state and
    // silently vanished on the next page load, never actually reaching the
    // backend at all. This models that same batch-creation pattern and
    // specifically re-fetches everything fresh afterward, rather than just
    // trusting each POST response, to prove it's genuinely saved.
    if (!authToken) throw new Error("No auth token from earlier test - skipping");
    const batch = ["Import Regression A", "Import Regression B", "Import Regression C"];
    const createdIds = [];
    for (const name of batch) {
      const client = await apiRequest(backendUrl, authToken, "POST", "/api/clients", { name });
      createdIds.push(client.id);
      cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/clients/${client.id}`).catch(() => {}));
    }
    const freshList = await apiRequest(backendUrl, authToken, "GET", "/api/clients");
    const allFound = createdIds.every((id) => freshList.some((c) => c.id === id));
    if (!allFound) throw new Error("Not all batch-created clients were found in a fresh fetch afterward - the exact failure mode this test exists to catch");
  })());

  // ---------------------------------------------------------------------------
  // EVENTS / SERVICE-REQUESTS SYSTEM
  // The whole event flow built after this Inspector was first written: creating an
  // event, per-recipient tokens, tokenised client responses, server-side job
  // creation on acceptance, the accepted/declined breakdown, editing, deleting,
  // and the self-healing job backfill. This is the area that had the most bugs, so
  // it gets the most coverage.
  // ---------------------------------------------------------------------------
  let eventId = null;
  let eventClientId = null;
  let eventClientId2 = null;

  report(await makeTest("Event (service request) can be created with per-recipient tokens", async () => {
    if (!authToken) throw new Error("No auth token from earlier test - skipping");
    const ec1 = await apiRequest(backendUrl, authToken, "POST", "/api/clients", { name: "Event Client One", address: "1 Test St" });
    const ec2 = await apiRequest(backendUrl, authToken, "POST", "/api/clients", { name: "Event Client Two", address: "2 Test St" });
    eventClientId = ec1.id; eventClientId2 = ec2.id;
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/clients/${ec1.id}`).catch(() => {}));
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/clients/${ec2.id}`).catch(() => {}));
    const ev = await apiRequest(backendUrl, authToken, "POST", "/api/service-requests", {
      groupName: "Test Group", serviceIds: ["r1", "r2"], dutyDate: "2026-12-30", message: "Inspector event",
      responses: [{ clientId: ec1.id, respondedAt: null, selections: [] }, { clientId: ec2.id, respondedAt: null, selections: [] }],
    });
    if (!ev.id) throw new Error("No id returned for created event");
    eventId = ev.id;
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/service-requests/${ev.id}`).catch(() => {}));
    const tokens = (ev.responses || []).map((r) => r.token);
    if (tokens.length !== 2 || !tokens[0] || !tokens[1]) throw new Error("Server did not generate a token per recipient");
    if (tokens[0] === tokens[1]) throw new Error("Recipient tokens are not unique - a client could respond as another");
  })());

  report(await makeTest("Response token identifies the right client automatically", async () => {
    if (!eventId) throw new Error("No event from earlier test - skipping");
    const ev = await apiRequest(backendUrl, authToken, "GET", "/api/service-requests");
    const mine = ev.find((sr) => sr.id === eventId);
    const token = mine.responses.find((r) => r.clientId === eventClientId).token;
    // Public token lookup - no auth, mimicking a client tapping their link.
    const info = await apiRequest(backendUrl, null, "GET", `/api/public/respond/${token}`);
    if (info.clientId !== eventClientId) throw new Error("Token resolved to the wrong client");
    if (info.clientName !== "Event Client One") throw new Error("Token lookup did not return the client's name");
    if (info.alreadyResponded !== false) throw new Error("Fresh response wrongly reported as already responded");
  })());

  report(await makeTest("Bogus response token is rejected", async () => {
    let rejected = false;
    try { await apiRequest(backendUrl, null, "GET", "/api/public/respond/deadbeefdeadbeefdeadbeefdeadbeef"); }
    catch (e) { rejected = true; }
    if (!rejected) throw new Error("A made-up token was accepted - it should be rejected");
  })());

  report(await makeTest("Accepting via token creates a routable job on the owner's schedule", async () => {
    if (!eventId) throw new Error("No event from earlier test - skipping");
    const ev = await apiRequest(backendUrl, authToken, "GET", "/api/service-requests");
    const mine = ev.find((sr) => sr.id === eventId);
    const token = mine.responses.find((r) => r.clientId === eventClientId).token;
    // Client accepts one service via their token, sending selection details.
    await apiRequest(backendUrl, null, "PUT", `/api/public/respond/${token}`, {
      selections: ["r1"], selectionDetails: [{ id: "r1", name: "Diagnostic visit", price: 65 }],
    });
    // The owner should now have a booked job for that client on the event date -
    // a direct regression test for the bug where an acceptance created no job and
    // the route button never appeared.
    const jobs = await apiRequest(backendUrl, authToken, "GET", "/api/jobs");
    const booked = jobs.find((j) => j.clientId === eventClientId && j.date === "2026-12-30" && j.notes === "Booked via service request response.");
    if (!booked) throw new Error("Accepting via token did not create a booked job - the route button would find nothing");
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/jobs/${booked.id}`).catch(() => {}));
  })());

  report(await makeTest("Accepting twice does not create a duplicate job", async () => {
    if (!eventId) throw new Error("No event from earlier test - skipping");
    const ev = await apiRequest(backendUrl, authToken, "GET", "/api/service-requests");
    const mine = ev.find((sr) => sr.id === eventId);
    const token = mine.responses.find((r) => r.clientId === eventClientId).token;
    await apiRequest(backendUrl, null, "PUT", `/api/public/respond/${token}`, {
      selections: ["r1"], selectionDetails: [{ id: "r1", name: "Diagnostic visit", price: 65 }],
    });
    const jobs = await apiRequest(backendUrl, authToken, "GET", "/api/jobs");
    const booked = jobs.filter((j) => j.clientId === eventClientId && j.date === "2026-12-30" && j.notes === "Booked via service request response.");
    if (booked.length !== 1) throw new Error(`Expected exactly one booked job after a double-submit, found ${booked.length}`);
  })());

  report(await makeTest("Event can be edited (date, services, message) without losing responses", async () => {
    if (!eventId) throw new Error("No event from earlier test - skipping");
    const ev = await apiRequest(backendUrl, authToken, "GET", "/api/service-requests");
    const mine = ev.find((sr) => sr.id === eventId);
    const edited = await apiRequest(backendUrl, authToken, "PUT", `/api/service-requests/${eventId}`, {
      ...mine, dutyDate: "2026-12-31", serviceIds: ["r1", "r2", "r3"], message: "Edited by Inspector",
    });
    if (edited.dutyDate !== "2026-12-31") throw new Error("Edit did not change the date");
    if (edited.serviceIds.length !== 3) throw new Error("Edit did not change the services");
    if (edited.message !== "Edited by Inspector") throw new Error("Edit did not change the message");
    const stillResponded = edited.responses.find((r) => r.clientId === eventClientId && r.respondedAt);
    if (!stillResponded) throw new Error("Editing the event wiped an existing client response");
  })());

  report(await makeTest("A responses-only update still works after an edit (client reply path)", async () => {
    if (!eventId) throw new Error("No event from earlier test - skipping");
    // This is the exact shape the public respond flow sends; a JSON-handling bug
    // here previously would have broken clients replying. Verify it still works
    // and preserves the edited date rather than reverting it.
    const ru = await apiRequest(backendUrl, authToken, "PUT", `/api/service-requests/${eventId}`, {
      responses: [{ clientId: eventClientId2, respondedAt: new Date().toISOString(), selections: [] }],
    });
    if (ru.dutyDate !== "2026-12-31") throw new Error("A responses-only update reverted the edited date");
  })());

  report(await makeTest("Event can be deleted", async () => {
    if (!eventId) throw new Error("No event from earlier test - skipping");
    await apiRequest(backendUrl, authToken, "DELETE", `/api/service-requests/${eventId}`);
    const ev = await apiRequest(backendUrl, authToken, "GET", "/api/service-requests");
    if (ev.some((sr) => sr.id === eventId)) throw new Error("Event still present after delete");
    eventId = null; // already gone; skip the cleanup delete
  })());

  report(await makeTest("Client geocoded position (geo) persists across a save and reload", async () => {
    if (!authToken) throw new Error("No auth token from earlier test - skipping");
    // Regression test for the 're-geocode every login' bug: geo must be stored on
    // the backend, not just held in local state, or every login re-geocodes.
    const c = await apiRequest(backendUrl, authToken, "POST", "/api/clients", {
      name: "Geo Persist Client", address: "3 Test St", coords: { x: 1.5, y: -0.5 },
      geo: { lat: 42.4467, lng: -71.227, formatted: "3 Test St" },
    });
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/clients/${c.id}`).catch(() => {}));
    const reloaded = (await apiRequest(backendUrl, authToken, "GET", "/api/clients")).find((x) => x.id === c.id);
    if (!reloaded.geo || Math.abs(reloaded.geo.lat - 42.4467) > 0.0001) throw new Error("Client geo did not persist - the app would re-geocode on every login");
  })());

  report(await makeTest("Job backfill self-heals an accepted response that has no job", async () => {
    if (!authToken) throw new Error("No auth token from earlier test - skipping");
    // Recreate the 'stuck event' state: an accepted response with no booked job,
    // then confirm that simply loading service-requests creates the missing job.
    const c = await apiRequest(backendUrl, authToken, "POST", "/api/clients", { name: "Backfill Client", address: "4 Test St" });
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/clients/${c.id}`).catch(() => {}));
    const ev = await apiRequest(backendUrl, authToken, "POST", "/api/service-requests", {
      groupName: "Backfill Group", serviceIds: ["r1"], dutyDate: "2026-12-29",
      responses: [{ clientId: c.id, respondedAt: new Date().toISOString(), selections: ["r1"], selectionDetails: [{ id: "r1", name: "Diagnostic visit", price: 65 }] }],
    });
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/service-requests/${ev.id}`).catch(() => {}));
    // Loading service-requests should trigger the backfill and create the job.
    await apiRequest(backendUrl, authToken, "GET", "/api/service-requests");
    const jobs = await apiRequest(backendUrl, authToken, "GET", "/api/jobs");
    const healed = jobs.find((j) => j.clientId === c.id && j.date === "2026-12-29" && j.notes === "Booked via service request response.");
    if (!healed) throw new Error("Backfill did not create the missing job for an accepted response");
    cleanup.push(() => apiRequest(backendUrl, authToken, "DELETE", `/api/jobs/${healed.id}`).catch(() => {}));
  })());

  // ---------------------------------------------------------------------------
  // SECURITY HARDENING
  // Confirms the protective measures are actually live on the real backend, so a
  // future deploy can't silently drop them. Uses raw fetch (not the throwing
  // apiRequest helper) because these tests deliberately expect certain failures
  // (429 Too Many Requests, a blocked cross-origin request).
  // ---------------------------------------------------------------------------

  report(await makeTest("Security headers are present (helmet is active)", async () => {
    const res = await fetch(`${backendUrl}/api/health`);
    // helmet sets these by default; their presence is a good proxy for it being on.
    const frame = res.headers.get("x-frame-options");
    const noSniff = res.headers.get("x-content-type-options");
    if (!frame && !noSniff) throw new Error("No security headers found - helmet may not be active");
    if (!noSniff) throw new Error("Missing X-Content-Type-Options header (MIME-sniffing protection)");
  })());

  report(await makeTest("CORS is locked to the real frontend, not open to every origin", async () => {
    // An allowed origin should be echoed back in Access-Control-Allow-Origin; a
    // random origin should NOT be. If a random origin is echoed, CORS is wide open.
    const evil = await fetch(`${backendUrl}/api/health`, { headers: { Origin: "https://definitely-not-allowed.example.com" } });
    const evilAllow = evil.headers.get("access-control-allow-origin");
    if (evilAllow === "https://definitely-not-allowed.example.com" || evilAllow === "*") {
      throw new Error("CORS echoes back an arbitrary origin - it is open to every website");
    }
  })());

  report(await makeTest("Protected endpoints reject requests with no token", async () => {
    // A core guarantee: without a valid token, data endpoints must refuse. This
    // would catch an accidental removal of the auth middleware.
    const res = await fetch(`${backendUrl}/api/clients`);
    if (res.status !== 401) throw new Error(`Expected 401 for an unauthenticated request to /api/clients, got ${res.status}`);
  })());

  report(await makeTest("Protected endpoints reject a forged/garbage token", async () => {
    const res = await fetch(`${backendUrl}/api/clients`, { headers: { Authorization: "Bearer not-a-real-token" } });
    if (res.status !== 401) throw new Error(`Expected 401 for a forged token, got ${res.status}`);
  })());

  report(await makeTest("Server survived the full test run", async () => {
    const health = await apiRequest(backendUrl, null, "GET", "/api/health");
    if (health.status !== "ok") throw new Error("Server did not report healthy after the test run");
  })());

  // Clean up everything created during this run, regardless of what passed or failed.
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch (e) { /* best effort - a failed cleanup shouldn't fail the run */ }
  }

  return results;
}

// Runs LAST of everything (after the browser suite), because tripping the login
// rate limiter blocks even correct logins for the rest of the window - so it must
// not run before anything that needs to log in. Fires more than the failed-login
// limit and confirms the backend starts returning 429 rather than accepting
// unlimited guesses. Uses a junk account so it only ever exercises the limiter.
async function runRateLimitProbe(backendUrl, onProgress) {
  const result = await (async () => {
    try {
      let sawTooMany = false;
      const junkEmail = `ratelimit-probe-${Date.now()}@internal.test`;
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`${backendUrl}/api/auth/login`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: junkEmail, password: "definitely-wrong" }),
        });
        if (res.status === 429) { sawTooMany = true; break; }
      }
      if (!sawTooMany) throw new Error("Login accepted 15 rapid failed attempts without ever rate-limiting - brute-force protection may be off");
      return { name: "Login is rate-limited against brute force", passed: true };
    } catch (err) {
      return { name: "Login is rate-limited against brute force", passed: false, error: err.message || String(err) };
    }
  })();
  if (onProgress) onProgress(result);
  return [result];
}

module.exports = { runBackendTests, runRateLimitProbe };
