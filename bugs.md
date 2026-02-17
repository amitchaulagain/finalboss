# FINALBOSS

## Critical: Jobs must use local storage (not corpus-rag API)

- [ ] 1. **[MAJOR/CRITICAL]** Cover-letters and resume-enhancement pages fetch job list and job details from corpus-rag (`CORPUS_RAG_API/api/jobs` and `/api/jobs/[filename]`). Jobs should be stored and read locally in finalboss only — no corpus-rag API calls for job listing or retrieval.
  - **Current behavior:** `loadJobs()` in cover-letters and resume-enhancement calls corpus-rag. No jobs appear when corpus-rag has no jobs or is unreachable. Resume-enhancement's "save job" POST to finalboss `/api/jobs` has no POST handler, so saving is broken.
  - **Desired behavior:** A single local jobs store in finalboss (aggregating or replacing the current bot artifact directories: `src/bots/jobs/<jobId>/`, `jobs/linkedinjobs/<jobId>/`, `clients/<email>/jobs/<platform>/<jobId>/`). Cover-letters, resume-enhancement, and any other page that needs jobs must read from this local store only.
  - **Existing local storage (bots):** Bots already write job artifacts to `src/bots/jobs/`, `jobs/linkedinjobs/`, and `clients/<email>/jobs/<platform>/`. Existing finalboss API routes (`GET /api/jobs` reads only `jobs/linkedinjobs`; `GET /api-test/jobs` reads `src/bots/jobs`) are not used by the cover-letters or resume-enhancement pages.
  - **Files:** `src/routes/cover-letters/+page.svelte`, `src/routes/resume-enhancement/+page.svelte`, `src/lib/corpus-rag-client.js` (jobs API calls to remove), finalboss local jobs API/service (new or expanded, e.g. `src/routes/api/jobs/+server.ts` or `src/lib/services/jobService.ts`) for list + get + create that reads/writes local storage.

## Auth and onboarding

- [ ] 1. Use corpus-rag API to login/signup. Assign some free tokens to new users.
  - **Files:** `src/routes/login/+page.svelte`, `src/lib/authService.js`, `src/lib/corpus-rag-auth.js`; backend (corpus-rag) signup + token grant.
- [ ] 2. Requires startup guide for new users: make them fill basic information and compulsorily choose/edit a resume template.
  - **Files:** `src/routes/welcome/+page.svelte` (if exists), `src/routes/app/+page.svelte`, possibly new route or modal.
- [ ] 3. Session validation warning on boot that auto-disappears — investigate.
  - **Files:** `src/routes/+layout.svelte` (onMount, `CorpusRagAuth.validateSession`), `src/lib/corpus-rag-auth.js`.
- [ ] 4. Ensure user has filled basic form before running any bots to prevent unnecessary/unwanted job apply.
  - **Files:** `src/routes/choose-bot/+page.svelte`, `src/routes/frontend-form/+page.svelte`, `src/bots/core/registry.ts` / config load (e.g. `user-bots-config.json`).

## Build / tooling

- [ ] 1. PostCSS issue at startup on login (or similar) page.
  - **Files:** `src/app.css`, `postcss.config.js` (or Vite/Tailwind config), `package.json` (postcss/tailwind deps).

## Layout and sidebar

- [ ] 1. Remove Configuration from the sidebar; show that form when Account is clicked (where users expect it).
  - **Files:** `src/routes/+layout.svelte` (menu + drawer), `src/routes/app/+page.svelte` (Account/Profile area).
- [ ] 2. Highlight the selected menu item in the sidebar.
  - **Files:** `src/routes/+layout.svelte` (existing `$page.url.pathname === '...'` active classes).
- [ ] 3. Add light-theme selector.
  - **Files:** `src/routes/+layout.svelte`, DaisyUI/theme (e.g. `data-theme` or Tailwind theme).
- [ ] 4. Remove unnecessary sidebar items (e.g. API test, test functions).
  - **Files:** `src/routes/+layout.svelte` (links to `/api-test`, `/testfunctions`).

## Dashboard and navigation

- [ ] 1. Show current page name on all pages; match the name in page vs sidebar menu.
  - **Files:** Each `src/routes/**/+page.svelte` (page title), `src/routes/+layout.svelte` (menu labels).
- [ ] 2. Improve overall UI.
  - **Files:** `src/routes/app/+page.svelte`, `src/app.css`, shared components.
- [ ] 3. Analytics and Job analytics — clarify the difference.
  - **Files:** `src/routes/backend-analytics/+page.svelte`, `src/routes/job-analytics/+page.svelte`, sidebar labels in `+layout.svelte`.

## Billing and tokens

- [ ] 1. Buy tokens page: "Error loading plans: Failed to get plans" (investigate).
  - **Files:** `src/routes/plans/+page.svelte`, `src/lib/services/planService.js`, corpus-rag `/api/plans`.
- [ ] 2. Orders page: "Error loading orders: Failed to get orders".
  - **Files:** `src/routes/orders/+page.svelte`, `src/lib/services/orderService.js`.
- [ ] 3. Token history page: "Error loading transactions: Failed to get transactions".
  - **Files:** `src/routes/tokens/history/+page.svelte`, `src/lib/services/tokenService.js`.
- [ ] 4. "Authentication Required: Failed to get JWT token: Authentication failed" — fix or improve messaging.
  - **Files:** `src/routes/api-test/+page.svelte`, `src/lib/services/tokenService.js`, `src/lib/authService.js`, `src/lib/corpus-rag-auth.js`; pages that call `getHeaders()` and show errors.

## Job tracker

- [ ] 1. Replace hardcoded information with real data.
  - **Files:** `src/routes/control-bar/+page.svelte`, `src/routes/backend-analytics/+page.svelte`.
- [ ] 2. Improve the user interface.
  - **Files:** `src/routes/control-bar/+page.svelte`, `src/routes/backend-analytics/+page.svelte`.

## Resume builder

- [ ] 1. Add option to upload resume.
  - **Files:** `src/routes/resume-builder/+page.svelte`, `src/routes/resume-builder/my-resumes/+page.svelte`, `src/lib/resume/`.
- [ ] 2. If user uploads a resume: extract text, send to AI, then try to fill one of the resume templates.
  - **Files:** `src/routes/resume-builder/+page.svelte`, `src/lib/resume/` (generator, store).
- [ ] 3. Compulsorily ask the user to verify the resume (extraction is never 100% reliable).
  - **Files:** `src/routes/resume-builder/+page.svelte`, `src/routes/resume-builder/edit/[id]/+page.svelte`.
- [ ] 4. Disclaimer: "The exported resume docx may look slightly different".
  - **Files:** `src/routes/resume-builder/edit/[id]/+page.svelte`, `src/lib/resume/` (generator, components).
- [ ] 5. Try to match the CSS styling of the resume.
  - **Files:** `src/lib/resume/` (ResumeRenderer, templates, configs).
- [ ] 6. Add export-to-PDF option.
  - **Files:** `src/routes/resume-builder/edit/[id]/+page.svelte`, `src/lib/resume/generator.ts`.
- [ ] 7. Remove the "resume is downloaded" toast.
  - **Files:** `src/routes/resume-builder/edit/[id]/+page.svelte` (alert on download).

## Configuration form

- [ ] 1. Remove hardcoded config. Make sure the user fills basic config form.
  - **Files:** `src/routes/frontend-form/+page.svelte`, `src/bots/core/user-bots-config.json`, `src/bots/core/registry.ts`, `src/bots/core/browser_manager.ts`.
- [ ] 2. Add auto-scroll to advanced options when the advanced button is clicked.
  - **Files:** `src/routes/frontend-form/+page.svelte` (toggleAdvancedMode, advanced section).

## API pages (cover letter, resume enhancement)

- [ ] 1. Investigate "no saved jobs" issue on new app boot; show a more user-friendly toast. *(Root cause: jobs are fetched from corpus-rag instead of local storage — see "Critical: Jobs must use local storage" above.)*
  - **Files:** `src/routes/cover-letters/+page.svelte`, `src/routes/resume-enhancement/+page.svelte`, `src/lib/corpus-rag-client.js` (jobs API).
- [ ] 2. Replace default error overlay "Failed to load jobs: Unknown error" with clearer messaging.
  - **Files:** `src/routes/cover-letters/+page.svelte`, `src/routes/resume-enhancement/+page.svelte`, error/alert copy.
- [ ] 3. Fix the same issue on all pages that require saved jobs.
  - **Files:** `src/routes/cover-letters/+page.svelte`, `src/routes/resume-enhancement/+page.svelte`, `src/lib/corpus-rag-client.js`.

## Job analytics

- [ ] 1. HTTP 404: show a more user-friendly error for non-technical users; use the same error/warning window for all such cases.
  - **Files:** `src/routes/job-analytics/+page.svelte`, `src/routes/job-analytics/[id]/+page.svelte` (loadDetail, error state).

## Bot: Seek

- [ ] 1. Cloudflare check does not pass.
  - **Files:** `src/bots/core/browser_manager.ts` (Chrome/stealth), `src/bots/seek/seek_impl.ts`; Indeed has `indeed_selectors.json` cloudflare_challenge — Seek may need similar or driver config.
- [ ] 2. Hardcoded search and location.
  - **Files:** `src/bots/seek/seek_impl.ts` (build_search_url, ctx from config), `src/bots/core/user-bots-config.json`, config load path in `registry.ts` / `browser_manager.ts`.
- [ ] 3. Too long timeout to run after sign in.
  - **Files:** `src/bots/core/core_configurations.ts` (timeouts.login_wait), `src/bots/seek/seek_steps.yaml` and steps that wait after sign-in.
- [ ] 4. While Seek is running, turn the Start Seek bot button to running indication.
  - **Files:** `src/routes/choose-bot/+page.svelte` (runBot, runningBots, button state per bot).
- [ ] 5. Opens new tab for every job. Should work on the jobs one by one.
  - **Files:** `src/bots/seek/seek_impl.ts` (Quick Apply click, switch to new tab ~804–812; loop over jobs).
- [ ] 6. Overlay comes up too late.
  - **Files:** `src/bots/core/universal_overlay.ts`, `src/bots/seek/seek_impl.ts` (where overlay is created/updated), `src/bots/core/workflow_engine.ts`.
- [ ] 7. Wrong overlay information.
  - **Files:** `src/bots/core/universal_overlay.ts`, `src/bots/seek/seek_impl.ts` (updateJobProgress, updateOverlay calls).
- [ ] 8. Does not work if window is minimized to tablet size (half screen in laptop).
  - **Files:** `src/bots/core/universal_overlay.ts`, `src/bots/seek/seek_impl.ts` (overlay visibility/sizing).
- [ ] 9. Overlay should appear on other pages also; currently it does not.
  - **Files:** `src/bots/core/universal_overlay.ts`, `src/bots/core/workflow_engine.ts` (fallback overlay); in-app progress in `src/routes/choose-bot/+page.svelte`.
- [ ] 10. No error msg or overlay if the API is not connected or whatever else is the issue on the applying pages.
  - **Files:** `src/bots/seek/seek_impl.ts` (handlers that call API), `src/bots/core/universal_overlay.ts` (showMessage / error state).
- [ ] 11. Takes too long timeout if the first job fails.
  - **Files:** `src/bots/seek/seek_impl.ts` (retry/timeout around first job), `src/bots/core/core_configurations.ts`.
- [ ] 12. Agent is unaware of what error occurred and what to do next.
  - **Files:** `src/bots/seek/seek_impl.ts` (error handling), `src/bots/core/workflow_engine.ts` (error handling and transitions).

## Bot: LinkedIn

- [ ] 1. LinkedIn search defaults to "javajava".
  - **Files:** `src/bots/linkedin/linkedin_impl.ts` (URL/build with keywords), `src/bots/core/user-bots-config.json` (formData.keywords); possible duplicate in form save or URL param handling.
- [ ] 2. Does not wait long enough for user to sign in before redirecting.
  - **Files:** `src/bots/linkedin/linkedin_impl.ts` (showSignInOverlay), `src/bots/core/core_configurations.ts` (login_wait).
- [ ] 3. No overlay in LinkedIn flow.
  - **Files:** `src/bots/linkedin/linkedin_impl.ts` (ctx.overlay usage vs in-app progress); `src/routes/choose-bot/+page.svelte` (bot-progress events).
- [ ] 4. Default search and location keywords are hardcoded or used as fallback. Configuration form is empty at first start; ensure LinkedIn has no fallbacks. Require basic form to be filled before running LinkedIn bot.
  - **Files:** `src/bots/linkedin/linkedin_impl.ts`, `src/bots/core/user-bots-config.json`, `src/routes/frontend-form/+page.svelte` (loadConfig), `src/routes/choose-bot/+page.svelte` (guard before run).

## Bot: Indeed

- [ ] *(No items yet.)*
  - **Files:** `src/bots/indeed/` (for future items).

## Infrastructure / deployment

- [ ] 1. Keep corpus-rag on a server.
  - **Files:** Documentation / deployment only.
