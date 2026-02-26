<script>
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  /**
   * @typedef {{
   *   jobId: string,
   *   title: string,
   *   company: string,
   *   location: string,
   *   platform: string,
   *   status: string,
   *   runAt: string|null,
   *   filled: number|null,
   *   total: number|null,
   *   hasResume: boolean,
   *   hasCoverLetter: boolean,
   *   hasQna: boolean,
   *   basePath: string,
   *   steps: Array<{label: string, done: boolean}>,
   * }} JobEntry
   */

  /** @type {JobEntry[]} */
  let localJobs = [];
  let localLoading = true;
  let localError = '';
  let lastRefreshed = '';
  let refreshing = false;

  /** @type {ReturnType<typeof setInterval> | null} */
  let pollInterval = null;

  onMount(() => {
    loadLocalJobs();
    pollInterval = setInterval(refreshSilently, 5000);
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  /** @param {string | undefined} url @param {string} dirPlatform */
  function inferPlatform(url, dirPlatform) {
    if (dirPlatform && dirPlatform !== 'unknown') return dirPlatform;
    if (!url) return '—';
    if (url.includes('seek.com'))     return 'seek';
    if (url.includes('linkedin.com')) return 'linkedin';
    if (url.includes('indeed.com'))   return 'indeed';
    return 'other';
  }

  /** @param {any} appStatus @param {boolean} hasQna @param {boolean} hasCoverLetter @param {boolean} hasResume */
  function deriveStatus(appStatus, hasQna, hasCoverLetter, hasResume) {
    if (appStatus?.status) return appStatus.status;
    if (hasQna)                       return 'pending';
    if (hasCoverLetter || hasResume)  return 'abandoned';
    return 'abandoned';
  }

  /** @param {JobEntry} a @param {JobEntry} b */
  function progressScore(a) {
    return (a.status === 'applied' ? 8 : 0)
      + (a.hasQna ? 4 : 0)
      + (a.hasCoverLetter ? 2 : 0)
      + (a.hasResume ? 1 : 0);
  }

  /** @param {string} raw */
  function tryParse(raw) {
    try { return JSON.parse(raw); } catch { return {}; }
  }

  /**
   * Build the progress step list from saved applicationSteps (or infer a fallback).
   * @param {string[]} applicationSteps  step names from job_details.json
   * @param {boolean} hasResume
   * @param {boolean} hasCoverLetter
   * @param {boolean} hasQna
   * @param {string} status
   * @returns {Array<{label: string, done: boolean}>}
   */
  function buildSteps(applicationSteps, hasResume, hasCoverLetter, hasQna, status) {
    const stepNames = applicationSteps?.length
      ? applicationSteps
      : hasQna
        ? ['Choose documents', 'Answer employer questions', 'Review and submit']
        : ['Choose documents', 'Review and submit'];

    return stepNames.map(label => {
      let done = false;
      if (label === 'Choose documents')             done = hasResume || hasCoverLetter;
      else if (label === 'Answer employer questions') done = hasQna;
      else if (label === 'Review and submit')        done = status === 'applied';
      // 'Update SEEK profile' is always skipped by the bot — never done
      return { label, done };
    });
  }

  /** @param {string} status */
  function statusBadgeClass(status) {
    if (status === 'applied')   return 'badge-success';
    if (status === 'pending')   return 'badge-warning';
    if (status === 'abandoned') return 'badge-error';
    return 'badge-ghost';
  }

  /**
   * Load one job dir's data.
   * @param {string} basePath   e.g. "jobs/seek"
   * @param {string} jobId
   * @param {string} platform   e.g. "seek"
   * @returns {Promise<JobEntry>}
   */
  async function loadJobEntry(basePath, jobId, platform) {
    const dir = `${basePath}/${jobId}`;
    const [detailsRaw, qnaRaw, statusRaw, coverRaw, resumeRaw] = await Promise.allSettled([
      invoke('read_file_async', { filename: `${dir}/job_details.json` }),
      invoke('read_file_async', { filename: `${dir}/qna.json` }),
      invoke('read_file_async', { filename: `${dir}/application_status.json` }),
      invoke('read_file_async', { filename: `${dir}/cover_letter_response.json` }),
      invoke('read_file_async', { filename: `${dir}/resume_response.json` }),
    ]);

    const details   = detailsRaw.status === 'fulfilled' ? tryParse(/** @type {string} */(detailsRaw.value))   : {};
    const qna       = qnaRaw.status     === 'fulfilled' ? tryParse(/** @type {string} */(qnaRaw.value))       : {};
    const appStatus = statusRaw.status  === 'fulfilled' ? tryParse(/** @type {string} */(statusRaw.value))    : {};

    const hasQna         = qnaRaw.status    === 'fulfilled' && !!(qna?.questions?.length > 0 || qna?.summary);
    const hasCoverLetter = coverRaw.status  === 'fulfilled';
    const hasResume      = resumeRaw.status === 'fulfilled';

    const status = deriveStatus(appStatus, hasQna, hasCoverLetter, hasResume);
    const runAt  = appStatus?.appliedAt ?? qna?.summary?.runAt ?? null;
    const steps  = buildSteps(details?.applicationSteps, hasResume, hasCoverLetter, hasQna, status);

    return {
      jobId,
      title:    details?.title    || details?.raw_title || jobId,
      company:  details?.company  || '—',
      location: details?.location || '',
      platform: inferPlatform(details?.url, platform),
      status,
      runAt,
      filled: qna?.summary?.success ?? null,
      total:  qna?.summary?.total   ?? null,
      hasResume,
      hasCoverLetter,
      hasQna,
      basePath: dir,
      steps,
    };
  }

  /**
   * List numeric subdirs of `path`; returns [] if path doesn't exist.
   * @param {string} path
   * @returns {Promise<string[]>}
   */
  async function listNumericDirs(path) {
    try {
      /** @type {string[]} */
      const entries = await invoke('list_files', { path });
      return entries.filter((/** @type {string} */ d) => /^\d+$/.test(d));
    } catch {
      return [];
    }
  }

  async function refreshSilently() {
    if (refreshing) return; // skip if a refresh is already running
    refreshing = true;
    await scanAndUpdate();
    refreshing = false;
  }

  async function loadLocalJobs() {
    localLoading = true;
    localError = '';
    await scanAndUpdate();
    localLoading = false;
  }

  async function scanAndUpdate() {
    try {
      const PLATFORMS = ['seek', 'linkedin', 'indeed'];

      // Canonical location: jobs/{platform}/{jobId}/
      /** @type {Array<{dir: string, platform: string}>} */
      const scanDirs = PLATFORMS.map(p => ({ dir: `jobs/${p}`, platform: p }));

      // Scan all dirs, deduplicate by jobId (keep entry with highest progress score)
      /** @type {Map<string, JobEntry>} */
      const jobMap = new Map();

      await Promise.all(scanDirs.map(async ({ dir, platform }) => {
        const ids = await listNumericDirs(dir);
        await Promise.all(ids.map(async (jobId) => {
          const entry = await loadJobEntry(dir, jobId, platform);
          const existing = jobMap.get(jobId);
          if (!existing || progressScore(entry) > progressScore(existing)) {
            jobMap.set(jobId, entry);
          }
        }));
      }));

      const rank = { applied: 0, pending: 1, abandoned: 2 };
      localJobs = [...jobMap.values()].sort((a, b) => {
        const ra = rank[a.status] ?? 3, rb = rank[b.status] ?? 3;
        if (ra !== rb) return ra - rb;
        if (a.runAt && b.runAt) return b.runAt.localeCompare(a.runAt);
        if (a.runAt) return -1;
        if (b.runAt) return 1;
        return Number(b.jobId) - Number(a.jobId);
      });
      lastRefreshed = new Date().toLocaleTimeString();
    } catch (e) {
      localError = String(e);
    }
  }
</script>

<svelte:head>
  <title>Job Analytics – Quest Bot</title>
</svelte:head>

<div class="p-6 max-w-7xl mx-auto">
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <h1 class="text-2xl font-bold">Job Analytics</h1>
      <div class="flex items-center gap-3">
        {#if refreshing}
          <span class="loading loading-spinner loading-xs opacity-40"></span>
        {:else if lastRefreshed}
          <span class="text-xs text-base-content/40">Updated {lastRefreshed}</span>
        {/if}
        <span class="badge badge-xs badge-ghost gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-success inline-block animate-pulse"></span>
          live
        </span>
      </div>
    </div>

    {#if localLoading}
      <div class="flex justify-center py-12">
        <span class="loading loading-spinner loading-lg"></span>
      </div>
    {:else if localError}
      <div class="alert alert-warning">
        <span>{localError}</span>
        <button type="button" class="btn btn-ghost btn-sm" on:click={loadLocalJobs}>Retry</button>
      </div>
    {:else if localJobs.length === 0}
      <div class="card bg-base-200">
        <div class="card-body items-center text-center py-12">
          <p class="text-base-content/70">No local job runs found.</p>
          <p class="text-sm text-base-content/60">Run the Seek bot to see applications here.</p>
        </div>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm table-zebra">
          <thead>
            <tr>
              <th>Date</th>
              <th>Title</th>
              <th>Company</th>
              <th>Location</th>
              <th>Platform</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Q&A fill</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each localJobs as job}
              <tr>
                <td class="text-xs text-base-content/60 whitespace-nowrap">
                  {job.runAt ? new Date(job.runAt).toLocaleString() : '—'}
                </td>
                <td class="font-medium">{job.title}</td>
                <td>{job.company}</td>
                <td class="text-sm">{job.location}</td>
                <td><span class="badge badge-ghost badge-sm">{job.platform}</span></td>
                <td>
                  <span class="badge badge-sm {statusBadgeClass(job.status)}">{job.status}</span>
                </td>
                <td>
                  <div class="flex items-center gap-1">
                    {#each job.steps as step, i}
                      {#if i > 0}
                        <span class="w-3 border-t border-base-300 inline-block"></span>
                      {/if}
                      <span
                        title={step.label}
                        class="w-2.5 h-2.5 rounded-full inline-block cursor-default {step.done ? 'bg-success' : 'bg-base-300'}"
                      ></span>
                    {/each}
                  </div>
                </td>
                <td>
                  {#if job.total != null}
                    {@const pct = Math.round((job.filled / job.total) * 100)}
                    <span class="badge badge-sm {pct === 100 ? 'badge-success' : pct >= 50 ? 'badge-warning' : 'badge-error'}">
                      {job.filled}/{job.total}
                    </span>
                  {:else}
                    <span class="text-base-content/40 text-xs">—</span>
                  {/if}
                </td>
                <td>
                  <a href="/job-analytics/local/{job.jobId}?base={encodeURIComponent(job.basePath)}" class="btn btn-xs btn-primary">View</a>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
