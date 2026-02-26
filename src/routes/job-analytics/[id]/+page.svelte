<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { authService } from '$lib/authService.js';
  import { tokenService } from '$lib/services/tokenService.js';
  import { invoke } from '@tauri-apps/api/core';

  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

  const TABS = ['Job details', 'Resume', 'Cover letter', 'Q&A'];

  /** @type {any} */
  let app = null;
  let isLoading = true;
  let error = '';
  /** @type {string} */
  let activeTab = 'Job details';

  /** @type {Array<{question:string,answer:string,type?:string,options?:string[],selected?:any,answerSource?:string,status?:string}> | null} */
  let localQna = null;

  $: id = $page.params.id;
  $: backendQa = app?.application?.questionAnswers ?? [];
  $: displayQa = backendQa.length > 0 ? backendQa : (localQna ?? []);
  $: isLocalQnaSource = backendQa.length === 0 && displayQa.length > 0;

  onMount(() => {
    const auth = get(authService);
    if (!auth || !auth.isLoggedIn) {
      goto('/login');
      return;
    }
    loadDetail();
  });

  async function loadDetail() {
    if (!id) {
      error = 'Invalid ID';
      isLoading = false;
      return;
    }
    isLoading = true;
    error = '';
    try {
      const headers = await tokenService.getHeaders();
      const response = await fetch(`${API_BASE}/api/job-applications/${id}`, { headers });

      if (response.status === 404) {
        error = 'Application not found';
        app = null;
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.success && data.data) {
        app = data.data;
        // If backend has no Q&A, eagerly try to load from local qna.json
        if (!app.application?.questionAnswers?.length) {
          loadLocalQna();
        }
      } else {
        app = null;
      }
    } catch (e) {
      error = String((e && typeof e === 'object' && 'message' in e ? e.message : e) || 'Failed to load application');
      app = null;
    } finally {
      isLoading = false;
    }
  }

  /**
   * Parse raw qna.json content into the same shape used by the backend questionAnswers array.
   * @param {any} raw
   * @returns {Array<{question:string,answer:string,type?:string,options?:string[],selected?:any,answerSource?:string,status?:string}>}
   */
  function parseLocalQna(raw) {
    const list = raw?.questions ?? raw?.questionAnswers ?? (Array.isArray(raw) ? raw : []);
    /** @type {Array<{question:string,answer:string,type?:string,options?:string[],selected?:any,answerSource?:string,status?:string}>} */
    const result = [];
    for (const item of list) {
      const question = typeof item?.question === 'string' ? item.question
        : typeof item?.q === 'string' ? item.q : '';

      let answerValue = item?.answer ?? item?.a ?? item?.textAnswer ?? item?.selectedAnswer;
      if (typeof answerValue === 'number' && Array.isArray(item?.opts) && item.opts[answerValue]) {
        answerValue = item.opts[answerValue];
      }
      if (typeof answerValue === 'number' && Array.isArray(item?.options) && item.options[answerValue]) {
        answerValue = item.options[answerValue];
      }
      if (Array.isArray(answerValue)) answerValue = answerValue.map((x) => String(x)).join(', ');
      const answer = typeof answerValue === 'string' ? answerValue.trim() : '';

      if (!question && !answer) continue;

      const options = Array.isArray(item?.options)
        ? item.options.map((x) => String(x))
        : Array.isArray(item?.opts)
          ? item.opts.map((x) => String(x))
          : undefined;

      result.push({
        question: question.trim(),
        answer,
        ...(typeof item?.type === 'string' ? { type: item.type } : {}),
        ...(options ? { options } : {}),
        selected: item?.selected ?? null,
        ...(typeof item?.answerSource === 'string' ? { answerSource: item.answerSource } : {}),
        ...(typeof item?.status === 'string' ? { status: item.status } : {}),
      });
    }
    return result;
  }

  async function loadLocalQna() {
    const jobDir = app?.rawData?.source?.jobDir;
    if (!jobDir) return;
    try {
      const raw = await invoke('read_file_async', { filename: jobDir + '/qna.json' });
      const parsed = parseLocalQna(JSON.parse(/** @type {string} */ (raw)));
      localQna = parsed.length > 0 ? parsed : [];
    } catch {
      localQna = [];
    }
  }

  /**
   * @param {string | Date | undefined} d
   * @returns {string}
   */
  function formatDate(d) {
    if (!d) return '—';
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /** @param {string} text */
  function stripMarkdown(text) {
    return text
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/gs, '$1')
      .replace(/__(.+?)__/gs, '$1')
      .replace(/\*(.+?)\*/gs, '$1')
      .replace(/(?<!\w)_(.+?)_(?!\w)/gs, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/^>\s+/gm, '')
      .replace(/^[-*_]{3,}\s*$/gm, '')
      .replace(/^[ \t]*[-*+]\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Determine resume source. Uses stored field if available, otherwise infers from
   * whether tailoredResume is inline text (AI-enhanced) or a file path / absent (original).
   * @param {any} application
   * @returns {'ai-enhanced' | 'original' | null}
   */
  function getResumeSource(application) {
    if (!application) return null;
    if (application.resumeSource) return application.resumeSource;
    const r = application.tailoredResume;
    if (!r) return 'original';
    // File paths won't contain newlines; inline AI text almost always will
    return r.includes('\n') ? 'ai-enhanced' : 'original';
  }

  /**
   * Get PDF path for the saved AI-enhanced resume.
   * Prefers the stored field, falls back to jobDir + resume.pdf.
   * @param {any} app
   * @returns {string | null}
   */
  function getResumePdfPath(app) {
    if (app?.application?.resumePdfPath) return app.application.resumePdfPath;
    const jobDir = app?.rawData?.source?.jobDir ?? app?.source?.jobDir;
    if (jobDir) return jobDir + '/resume.pdf';
    return null;
  }

  /** Returns just `jobId/resume.pdf` for display. */
  function shortPdfPath(fullPath) {
    if (!fullPath) return '';
    const parts = fullPath.replace(/\\/g, '/').split('/');
    const idx = parts.length >= 2 ? parts.length - 2 : 0;
    return parts.slice(idx).join('/');
  }

  /** @param {string} path */
  async function openPdf(path) {
    try {
      await invoke('open_file_path', { path });
    } catch (e) {
      alert('Could not open PDF: ' + e);
    }
  }
</script>

<svelte:head>
  <title>{app ? `${app.title} – ${app.company}` : 'Job Application'} – Job Analytics</title>
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
      <button type="button" class="btn btn-ghost btn-sm" on:click={loadDetail}>Retry</button>
    </div>
  {:else if app}
    <!-- Header: title + company (always visible) -->
    <div class="card bg-base-200 mb-4">
      <div class="card-body py-4">
        <h1 class="card-title text-xl">{app.title}</h1>
        <p class="text-lg text-base-content/80">{app.company}</p>
        <div class="flex flex-wrap gap-2 text-sm text-base-content/70">
          {#if app.location}<span>{app.location}</span>{/if}
          {#if app.jobType}<span>• {app.jobType}</span>{/if}
          {#if app.salary}<span>• {app.salary}</span>{/if}
        </div>
        {#if app.url}
          <a href={app.url} target="_blank" rel="noopener noreferrer" class="link link-primary text-sm">Open job posting</a>
        {/if}
        <p class="text-xs text-base-content/50">Recorded: {formatDate(app.lastUpdatedAt)}</p>
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
          <!-- Salary, location, type, work mode -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {#if app.salary}
              <div class="card bg-base-200">
                <div class="card-body p-4">
                  <h3 class="font-semibold text-sm opacity-80">Salary</h3>
                  <p class="text-base">{app.salary}</p>
                </div>
              </div>
            {/if}
            {#if app.location}
              <div class="card bg-base-200">
                <div class="card-body p-4">
                  <h3 class="font-semibold text-sm opacity-80">Location</h3>
                  <p class="text-base">{app.location}</p>
                </div>
              </div>
            {/if}
            {#if app.jobType}
              <div class="card bg-base-200">
                <div class="card-body p-4">
                  <h3 class="font-semibold text-sm opacity-80">Job type</h3>
                  <p class="text-base">{app.jobType}</p>
                </div>
              </div>
            {/if}
            {#if app.workMode}
              <div class="card bg-base-200">
                <div class="card-body p-4">
                  <h3 class="font-semibold text-sm opacity-80">Work mode</h3>
                  <p class="text-base">{app.workMode}</p>
                </div>
              </div>
            {/if}
          </div>

          <!-- Posted / Closing dates -->
          {#if app.postedDate || app.closingDate}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80 mb-2">Dates</h3>
                <div class="flex flex-wrap gap-4">
                  {#if app.postedDate}
                    <span><strong>Posted:</strong> {formatDate(app.postedDate)}</span>
                  {/if}
                  {#if app.closingDate}
                    <span><strong>Closes:</strong> {formatDate(app.closingDate)}</span>
                  {/if}
                </div>
              </div>
            </div>
          {/if}

          <!-- HR contact -->
          {#if app.hrContact && (app.hrContact.name || app.hrContact.email || app.hrContact.phone)}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80 mb-2">HR / Contact</h3>
                <ul class="space-y-1 text-sm">
                  {#if app.hrContact.name}<li><strong>Name:</strong> {app.hrContact.name}</li>{/if}
                  {#if app.hrContact.email}<li><strong>Email:</strong> <a href="mailto:{app.hrContact.email}" class="link link-primary">{app.hrContact.email}</a></li>{/if}
                  {#if app.hrContact.phone}<li><strong>Phone:</strong> {app.hrContact.phone}</li>{/if}
                </ul>
              </div>
            </div>
          {/if}

          <!-- Required skills -->
          {#if app.requiredSkills && app.requiredSkills.length > 0}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80 mb-2">Required skills</h3>
                <div class="flex flex-wrap gap-2">
                  {#each app.requiredSkills as skill}
                    <span class="badge badge-primary badge-outline">{skill}</span>
                  {/each}
                </div>
              </div>
            </div>
          {/if}

          <!-- Required experience -->
          {#if app.requiredExperience}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80 mb-2">Required experience</h3>
                <div class="prose prose-sm max-w-none whitespace-pre-wrap">{app.requiredExperience}</div>
              </div>
            </div>
          {/if}

          <!-- Job description -->
          {#if app.description}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80 mb-2">Job description</h3>
                <div class="prose prose-sm max-w-none whitespace-pre-wrap">{app.description}</div>
              </div>
            </div>
          {/if}

          <!-- Extra job details (posted, category, application_volume, etc.) -->
          {#if app.jobDetails && Object.keys(app.jobDetails).length > 0}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80 mb-2">Other details</h3>
                <dl class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  {#each Object.entries(app.jobDetails) as [key, value]}
                    {#if value != null && value !== ''}
                      <dt class="font-medium opacity-80">{key}</dt>
                      <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                    {/if}
                  {/each}
                </dl>
              </div>
            </div>
          {/if}

          <!-- Token usage -->
          {#if app.application?.apiCalls && app.application.apiCalls.length > 0}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80 mb-2">Token usage</h3>
                <div class="overflow-x-auto">
                  <table class="table table-xs">
                    <thead>
                      <tr>
                        <th>Task</th>
                        <th>Input</th>
                        <th>Output</th>
                        <th>Total</th>
                        {#if app.application.apiCalls.some((/** @type {{ cost?: number }} */ c) => c.cost != null)}
                          <th>Cost</th>
                        {/if}
                      </tr>
                    </thead>
                    <tbody>
                      {#each app.application.apiCalls as call}
                        <tr>
                          <td>
                            <code class="text-xs">{call.endpoint}</code>
                            {#if call.aiProvider}
                              <span class="badge badge-sm opacity-80 ml-1">{call.aiProvider}</span>
                            {/if}
                          </td>
                          <td>{call.inputTokens != null ? call.inputTokens.toLocaleString() : '—'}</td>
                          <td>{call.outputTokens != null ? call.outputTokens.toLocaleString() : '—'}</td>
                          <td>{call.tokensUsed != null ? call.tokensUsed.toLocaleString() : '—'}</td>
                          {#if app.application.apiCalls.some((/** @type {{ cost?: number }} */ c) => c.cost != null)}
                            <td>{call.cost != null ? `$${call.cost.toFixed(4)}` : '—'}</td>
                          {/if}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          {/if}

          <!-- Source -->
          {#if app.rawData?.source}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="font-semibold text-sm opacity-80 mb-2">Source</h3>
                <p class="text-xs font-mono text-base-content/60">{JSON.stringify(app.rawData.source)}</p>
              </div>
            </div>
          {/if}
        </div>

      {:else if activeTab === 'Resume'}
        <div class="card bg-base-200">
          <div class="card-body">
            <div class="flex items-center gap-3 mb-3">
              <h2 class="card-title text-base">Resume</h2>
              {#if getResumeSource(app.application) === 'ai-enhanced'}
                <span class="badge badge-accent badge-sm">AI Enhanced</span>
              {:else}
                <span class="badge badge-ghost badge-sm">Original CV</span>
              {/if}
            </div>
            {#if getResumeSource(app.application) === 'ai-enhanced'}
              {@const pdfPath = getResumePdfPath(app)}
              {#if pdfPath}
                <div class="mb-3">
                  <button class="btn btn-sm btn-outline gap-2" on:click={() => openPdf(pdfPath)}>
                    📄 {shortPdfPath(pdfPath)}
                  </button>
                </div>
              {/if}
            {/if}
            {#if app.application?.tailoredResume}
              <div class="prose prose-sm max-w-none whitespace-pre-wrap">{stripMarkdown(app.application.tailoredResume)}</div>
            {:else}
              <p class="text-base-content/70">No resume data for this application.</p>
            {/if}
          </div>
        </div>

      {:else if activeTab === 'Cover letter'}
        <div class="card bg-base-200">
          <div class="card-body">
            {#if app.application?.coverLetter}
              <h2 class="card-title text-base">Cover letter</h2>
              <div class="prose prose-sm max-w-none whitespace-pre-wrap">{app.application.coverLetter}</div>
            {:else}
              <p class="text-base-content/70">No cover letter for this application.</p>
            {/if}
          </div>
        </div>

      {:else if activeTab === 'Q&A'}
        <div class="card bg-base-200">
          <div class="card-body">
            {#if displayQa.length > 0}
              <div class="flex items-center gap-2 mb-1">
                <h2 class="card-title text-base">Questions & answers</h2>
                {#if isLocalQnaSource}
                  <span class="badge badge-ghost badge-sm">Local file</span>
                {/if}
              </div>
              <ul class="space-y-4">
                {#each displayQa as qa}
                  {@const resolvedAnswer = (typeof qa.answer === 'number' && Array.isArray(qa.options) && qa.options[qa.answer] != null)
                    ? qa.options[qa.answer]
                    : qa.answer}
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
                      {#if resolvedAnswer}
                        {resolvedAnswer}
                      {:else}
                        —
                      {/if}
                    </p>
                    {#if qa.answerSource}
                      <p class="text-xs text-base-content/50">Source: {qa.answerSource}</p>
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
  {:else}
    <p class="text-base-content/70">No data to display.</p>
  {/if}
</div>
