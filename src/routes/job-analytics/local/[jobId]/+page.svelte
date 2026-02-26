<script>
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { invoke } from '@tauri-apps/api/core';

  const TABS = ['Job details', 'Resume', 'Cover letter', 'Q&A'];

  $: jobId = $page.params.jobId;
  $: BASE = $page.url.searchParams.get('base') || `jobs/seek/${jobId}`;

  /** @type {any} */
  let details = null;
  /** @type {any} */
  let qna = null;
  /** @type {any} */
  let cover = null;
  /** @type {any} */
  let resumeData = null;

  let isLoading = true;
  let error = '';
  let activeTab = 'Job details';

  onMount(() => {
    loadData();
  });

  async function loadData() {
    isLoading = true;
    error = '';
    try {
      const [detailsRaw, qnaRaw, coverRaw, resumeRaw] = await Promise.allSettled([
        invoke('read_file_async', { filename: `${BASE}/job_details.json` }),
        invoke('read_file_async', { filename: `${BASE}/qna.json` }),
        invoke('read_file_async', { filename: `${BASE}/cover_letter_response.json` }),
        invoke('read_file_async', { filename: `${BASE}/resume_response.json` }),
      ]);

      details = detailsRaw.status === 'fulfilled' ? JSON.parse(/** @type {string} */ (detailsRaw.value)) : null;
      qna = qnaRaw.status === 'fulfilled' ? JSON.parse(/** @type {string} */ (qnaRaw.value)) : null;
      cover = coverRaw.status === 'fulfilled' ? JSON.parse(/** @type {string} */ (coverRaw.value)) : null;
      resumeData = resumeRaw.status === 'fulfilled' ? JSON.parse(/** @type {string} */ (resumeRaw.value)) : null;

      if (!details && !qna) {
        error = `No local data found for job ${jobId}`;
      }
    } catch (e) {
      error = String(e);
    } finally {
      isLoading = false;
    }
  }

  /**
   * @param {string | undefined} d
   * @returns {string}
   */
  function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /** @param {any} path */
  async function openPdf(path) {
    try {
      await invoke('open_file_path', { path });
    } catch (e) {
      alert('Could not open PDF: ' + e);
    }
  }

  $: qnaQuestions = qna?.questions ?? [];
  $: qnaSummary = qna?.summary ?? null;
  $: fillPct = qnaSummary?.total > 0 ? Math.round((qnaSummary.success / qnaSummary.total) * 100) : null;
  $: coverLetter = cover?.cover_letter ?? cover?.coverLetter ?? null;
  $: hasAiResume = resumeData?.resume != null;
</script>

<svelte:head>
  <title>
    {details ? `${details.title || jobId} – ${details.company || ''}` : jobId} | Local run
  </title>
</svelte:head>

<div class="p-6 max-w-4xl mx-auto">
  <div class="mb-4">
    <a href="/job-analytics" class="btn btn-ghost btn-sm">← Back to list</a>
  </div>

  {#if isLoading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else if error}
    <div class="alert alert-error">
      <span>{error}</span>
      <button type="button" class="btn btn-ghost btn-sm" on:click={loadData}>Retry</button>
    </div>
  {:else}
    <!-- Header -->
    <div class="card bg-base-200 mb-4">
      <div class="card-body py-4">
        <div class="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <h1 class="card-title text-xl">{details?.title || details?.raw_title || jobId}</h1>
            <p class="text-lg text-base-content/80">{details?.company || '—'}</p>
            <div class="flex flex-wrap gap-2 text-sm text-base-content/70 mt-1">
              {#if details?.location}<span>{details.location}</span>{/if}
              {#if details?.work_type}<span>• {details.work_type}</span>{/if}
              {#if details?.salary_note}<span>• {details.salary_note}</span>{/if}
            </div>
            {#if details?.url}
              <a href={details.url} target="_blank" rel="noopener noreferrer" class="link link-primary text-sm mt-1 block">Open job posting</a>
            {/if}
          </div>
          <span class="badge badge-ghost badge-sm">Local run</span>
        </div>
        <div class="flex flex-wrap gap-4 mt-1 text-xs text-base-content/50">
          {#if details?.scrapedAt}<span>Scraped: {formatDate(details.scrapedAt)}</span>{/if}
          {#if qnaSummary?.runAt}<span>Bot run: {formatDate(qnaSummary.runAt)}</span>{/if}
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex flex-wrap gap-2 mb-6">
      {#each TABS as tab}
        <button
          type="button"
          class="btn btn-sm font-bold px-6 py-2 {activeTab === tab ? 'btn-primary' : 'border border-base-300'}"
          style={activeTab !== tab ? 'background-color: #bfdbfe; color: #1e3a5f;' : ''}
          on:click={() => (activeTab = tab)}
        >
          {tab}
        </button>
      {/each}
    </div>

    <!-- Tab content -->
    <div class="min-h-[200px]">
      {#if activeTab === 'Job details'}
        <div class="flex flex-col gap-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80">Job ID</h3>
                <p class="text-base font-mono">{jobId}</p>
              </div>
            </div>
            {#if details?.company}
              <div class="card bg-base-200">
                <div class="card-body p-4">
                  <h3 class="font-semibold text-sm opacity-80">Company</h3>
                  <p class="text-base">{details.company}</p>
                </div>
              </div>
            {/if}
            {#if details?.location}
              <div class="card bg-base-200">
                <div class="card-body p-4">
                  <h3 class="font-semibold text-sm opacity-80">Location</h3>
                  <p class="text-base">{details.location}</p>
                </div>
              </div>
            {/if}
            {#if details?.work_type}
              <div class="card bg-base-200">
                <div class="card-body p-4">
                  <h3 class="font-semibold text-sm opacity-80">Work type</h3>
                  <p class="text-base">{details.work_type}</p>
                </div>
              </div>
            {/if}
            {#if details?.salary_note}
              <div class="card bg-base-200">
                <div class="card-body p-4">
                  <h3 class="font-semibold text-sm opacity-80">Salary</h3>
                  <p class="text-base">{details.salary_note}</p>
                </div>
              </div>
            {/if}
          </div>

          {#if details?.details}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80 mb-2">Job description</h3>
                <div class="prose prose-sm max-w-none whitespace-pre-wrap">{details.details}</div>
              </div>
            </div>
          {/if}
        </div>

      {:else if activeTab === 'Resume'}
        <div class="card bg-base-200">
          <div class="card-body">
            <div class="flex items-center gap-3 mb-3">
              <h2 class="card-title text-base">Resume</h2>
              {#if hasAiResume}
                <span class="badge badge-accent badge-sm">AI Enhanced</span>
              {:else}
                <span class="badge badge-ghost badge-sm">Original CV</span>
              {/if}
            </div>
            {#if hasAiResume}
              <div class="prose prose-sm max-w-none whitespace-pre-wrap">{resumeData.resume}</div>
            {:else}
              <p class="text-base-content/70 mb-3">Original CV was uploaded for this application.</p>
              <button class="btn btn-sm btn-outline gap-2" on:click={() => openPdf(`${BASE}/resume.pdf`)}>
                📄 Open resume.pdf
              </button>
            {/if}
          </div>
        </div>

      {:else if activeTab === 'Cover letter'}
        <div class="card bg-base-200">
          <div class="card-body">
            {#if coverLetter}
              <h2 class="card-title text-base mb-3">Cover letter</h2>
              <div class="prose prose-sm max-w-none whitespace-pre-wrap">{coverLetter}</div>
            {:else}
              <p class="text-base-content/70">No cover letter for this application.</p>
            {/if}
          </div>
        </div>

      {:else if activeTab === 'Q&A'}
        <div class="card bg-base-200">
          <div class="card-body">
            {#if qnaSummary}
              <div class="flex items-center gap-3 mb-4">
                <h2 class="card-title text-base">Questions & answers</h2>
                {#if fillPct != null}
                  <span class="badge {fillPct === 100 ? 'badge-success' : fillPct >= 50 ? 'badge-warning' : 'badge-error'}">
                    {qnaSummary.success}/{qnaSummary.total} filled
                  </span>
                {/if}
                {#if qnaSummary.errors > 0}
                  <span class="badge badge-error badge-sm">{qnaSummary.errors} errors</span>
                {/if}
              </div>
            {/if}
            {#if qnaQuestions.length > 0}
              <ul class="space-y-4">
                {#each qnaQuestions as qa}
                  <li class="border-l-2 border-base-300 pl-4">
                    <p class="font-medium text-sm mb-1">{qa.question}</p>
                    {#if qa.status}
                      {@const badgeClass = qa.status === 'success' ? 'badge-success'
                        : qa.status === 'failed' ? 'badge-error'
                        : qa.status === 'skipped' ? 'badge-warning'
                        : 'badge-ghost'}
                      <span class="badge badge-xs {badgeClass} mb-1">
                        {qa.status === 'success' ? 'Filled' : qa.status === 'failed' ? 'Fill failed' : qa.status}
                      </span>
                    {/if}
                    {#if qa.options && qa.options.length > 0}
                      <div class="flex flex-wrap gap-2 mb-2">
                        {#each qa.options as option, optionIndex}
                          {@const selectedSingle = typeof qa.selected === 'number' && qa.selected === optionIndex}
                          {@const selectedText = typeof qa.selected === 'string' && qa.selected === option}
                          {@const selectedMulti = Array.isArray(qa.selected) && qa.selected.includes(option)}
                          <span class="badge badge-sm {selectedSingle || selectedText || selectedMulti ? 'badge-primary' : 'badge-outline'}">{option}</span>
                        {/each}
                      </div>
                    {/if}
                    <p class="text-xs text-base-content/60 mb-1">
                      <strong>Answer:</strong>
                      {#if qa.answer}
                        {qa.answer}
                      {:else}
                        —
                      {/if}
                    </p>
                    {#if qa.answerSource}
                      <p class="text-xs text-base-content/50">Source: {qa.answerSource}</p>
                    {/if}
                    {#if qa.failureReason && qa.failureReason !== 'none'}
                      <p class="text-xs text-error/70">Reason: {qa.failureReason}</p>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="text-base-content/70">No Q&A data for this application.</p>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
