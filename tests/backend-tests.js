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

module.exports = { runBackendTests };
