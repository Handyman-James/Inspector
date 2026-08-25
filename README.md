# Handyman James \u2014 System Inspection

A dashboard that tests the real, live backend and the real, live frontend \u2014 not a
simulation of either. Open it, tap "Run Inspection," and watch results stream in
live, grouped into two sections:

- **Backend API** \u2014 hits real endpoints directly (auth, clients, jobs, invoices,
  estimates, tax summary, client relationships, message dispatch, batch client
  import) and confirms they behave correctly. Also covers the whole **events /
  service-request system** added later: creating an event with per-recipient
  tokens, a token resolving to the right client automatically, bogus tokens being
  rejected, a client accepting via their token creating a real routable job on the
  owner's schedule (and not creating a duplicate on a double-submit), editing an
  event without wiping responses, the client-reply path still working after an
  edit, deleting an event, geocoded client positions persisting across a reload
  (so the app doesn't re-geocode every login), and the self-healing job backfill
  recovering an accepted response that somehow has no job yet. Each of these is a
  direct regression test for a real bug found and fixed.
- **Browser (live app)** \u2014 launches a real, headless browser and clicks through
  the actual deployed frontend the way a real person would: logs in for real,
  opens each tab, confirms both "Add job" and "Add event" exist on Today and that
  the event screen actually opens, specifically re-checks the Route screen's map
  for visible content (a direct regression test for the black-map bug found and
  fixed earlier), and runs a full, genuine CSV import end to end \u2014 uploading a real
  file with deliberately non-standard column headers, manually mapping them
  through the app's own UI, confirming the import, and verifying the client
  actually appears in the client list afterward.

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

**This uses a Dockerfile, not Render's standard Node build** \u2014 a deliberate
choice, not the original one. The first attempt used a plain Node web service
with `npx playwright install --with-deps chromium` as the build command, and hit
a real, confirmed failure: that flag needs root access to install system-level
libraries via `apt-get`, and Render's standard build environment doesn't grant
that. The Dockerfile starts from Playwright's own official image instead, which
already has Chromium and everything it needs pre-installed \u2014 sidestepping the
permission problem entirely rather than working around it.

1. Push this folder to its own new GitHub repo (a new repo, separate from the
   existing backend and frontend ones) \u2014 make sure `Dockerfile` ends up at the
   repo's own root, not nested inside a subfolder.
2. In Render: New \u2192 Web Service \u2192 connect that repo.
3. Render should auto-detect the Dockerfile and switch to "Docker" as the
   runtime automatically. If it doesn't, select Docker explicitly. **With Docker
   selected, the Build Command and Start Command fields disappear entirely** \u2014
   the Dockerfile's own COPY/RUN/CMD lines replace both, so there's nothing to
   enter in either field this time.
4. Add two environment variables, same as before:
   - `BACKEND_URL` \u2014 your live backend's URL (e.g.
     `https://handyman-s4l1.onrender.com`)
   - `FRONTEND_URL` \u2014 your live frontend's URL (e.g.
     `https://frontend-bq90.onrender.com`)
5. Deploy. This first build pulls Playwright's full base image, which is
   several hundred MB \u2014 noticeably slower than a typical Node build, so give it
   a few extra minutes.

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
