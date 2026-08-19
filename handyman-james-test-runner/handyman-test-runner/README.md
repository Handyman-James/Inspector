# Handyman James \u2014 System Inspection

A dashboard that tests the real, live backend and the real, live frontend \u2014 not a
simulation of either. Open it, tap "Run Inspection," and watch results stream in
live, grouped into two sections:

- **Backend API** \u2014 hits real endpoints directly (auth, clients, jobs, invoices,
  estimates, tax summary, client relationships, message dispatch) and confirms
  they behave correctly.
- **Browser (live app)** \u2014 launches a real, headless browser and clicks through
  the actual deployed frontend the way a real person would: logs in for real,
  opens each tab, and specifically re-checks the Route screen's map for visible
  content \u2014 a direct regression test for the black-map bug found and fixed
  earlier in this project.

Any failure shows its exact error message. Browser-test failures also capture a
screenshot at the moment of failure, shown inline \u2014 useful for a rendering
problem, not just a logic one.

## What gets created and cleaned up

Every test run registers its own, fresh, disposable test account and creates
whatever data it needs (a test client, a test job, and so on). All of it is
deleted again at the end of the run, regardless of whether tests passed or
failed \u2014 confirmed directly by checking the database after a run and finding
zero leftover rows. Safe to run repeatedly against the real, live production
backend without it slowly filling up with junk test data.

Deliberately does **not** send real text messages or emails \u2014 that would
actually text or email a real number every time this runs. Instead, it confirms
the send logic behaves correctly (e.g. cleanly rejects a contact with no phone
number on file) without triggering an actual send.

## Deploying this to Render

This is a separate, third Render service \u2014 alongside the existing backend and
frontend, not a replacement for either.

1. Push this folder to its own new GitHub repo (a new repo, separate from the
   existing backend and frontend ones).
2. In Render: New \u2192 Web Service \u2192 connect that repo.
3. **Build Command:** `npm install && npx playwright install --with-deps chromium`
   (the second half installs the actual browser binary Playwright needs \u2014 without
   it, the browser tests fail immediately.)
4. **Start Command:** `npm start`
5. Add two environment variables:
   - `BACKEND_URL` \u2014 your live backend's URL (the same one already used
     elsewhere, e.g. `https://handyman-s4l1.onrender.com`)
   - `FRONTEND_URL` \u2014 your live frontend's URL (e.g.
     `https://frontend-bq90.onrender.com`)
6. Deploy. The dashboard itself will show a clear setup message instead of a
   confusing failure if either variable is missing.

## An honest note on the browser tests specifically

The backend API tests were run and thoroughly verified directly, against a real,
live backend, before being delivered \u2014 including confirming the cleanup logic
genuinely leaves the database untouched afterward. The browser tests were written
carefully against Playwright's standard, stable API, but this project's own
sandbox couldn't download Playwright's browser binary at all \u2014 its network is
deliberately restricted to a small allowlist that doesn't include Playwright's
CDN, confirmed directly rather than assumed. That restriction is specific to that
one build environment, not to Render's own build environment, which is
general-purpose. Worth running once after first deploying, to confirm the browser
half behaves as expected \u2014 it wasn't able to be run end-to-end before delivery
the way the backend half was.

## Local development

```
npm install
npx playwright install chromium
BACKEND_URL=https://your-backend.onrender.com FRONTEND_URL=https://your-frontend.onrender.com npm start
```

Then open `http://localhost:10000`.
