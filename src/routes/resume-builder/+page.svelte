<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { invoke } from '@tauri-apps/api/core';
  import { env } from '$env/dynamic/public';
  import { authService } from '$lib/authService.js';
  import { TEMPLATES } from '$lib/resume/templates';
  import { createResumeFromConfig, resumesStore, draftResume, loadResumes, autoSave } from '$lib/resume/store';
  import { parseResumeText } from '$lib/resume/parser';
  import TemplatePreview from '$lib/resume/components/TemplatePreview.svelte';
  import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

  const CORPUS_RAG_API = env.PUBLIC_API_BASE || import.meta.env.VITE_API_BASE || 'http://localhost:3000';

  // ── Config state ─────────────────────────────────────────────────────────────
  let configFormData: Record<string, any> = {};
  let configParsedResume: any = null;

  // ── Enhancement state ─────────────────────────────────────────────────────────
  let user: any = null;
  let jwtToken = '';
  let enhJobs: any[] = [];
  let enhSelectedJob: any = null;
  let enhJobDescription = '';
  let enhancedText: string | null = null;
  let enhOriginalResume = '';
  let isEnhancing = false;
  let enhFitScore = 0;
  let enhEnhancedScore = 0;
  let enhComparisonView: 'unified' | 'sidebyside' = 'unified';
  let enhLoading = false;
  let enhResumeLoading = false;
  let enhResumeName = '';
  let enhSaveSuccess = false;
  let enhSavedTitle = '';

  $: resumeCount = $resumesStore.length;

  // Build preview data from user config — ONLY personal info fields.
  // Experience, education, skills, etc. are intentionally omitted so the
  // TemplatePreview component falls back to its built-in sample placeholders.
  function buildPreviewData(f: Record<string, any>) {
    const name = f?.fullName;
    if (!name) return null; // No config personal info — show pure sample data
    return {
      name,
      email: f?.email || '',
      phone: f?.phone || '',
      linkedin: f?.linkedinUrl || '',
    };
  }

  $: previewUserData = buildPreviewData(configFormData);

  // Convert parsed resume object → plain text for the enhancement API
  function parsedResumeToText(pr: any, f: any = {}): string {
    if (!pr) return '';
    const lines: string[] = [];
    const pi = pr.personalInfo || {};

    const name = f.fullName || pi.fullName || '';
    if (name) lines.push(name);
    const title = pi.title || '';
    if (title) lines.push(title);
    const contact = [f.email || pi.email, f.phone || pi.phone, f.linkedinUrl || pi.linkedin]
      .filter(Boolean).join(' | ');
    if (contact) lines.push(contact);
    if (f.address || pi.address) lines.push(f.address || pi.address);
    lines.push('');

    if (pr.summary) {
      lines.push('SUMMARY');
      lines.push(pr.summary);
      lines.push('');
    }

    if (pr.experience?.length) {
      lines.push('EXPERIENCE');
      for (const e of pr.experience) {
        lines.push(`${e.jobTitle || ''} | ${e.company || ''} | ${e.startDate || ''} – ${e.endDate || 'Present'}`);
        if (e.location) lines.push(e.location);
        for (const a of (e.achievements || [])) lines.push(`• ${a}`);
        lines.push('');
      }
    }

    if (pr.education?.length) {
      lines.push('EDUCATION');
      for (const e of pr.education) {
        lines.push(`${e.degree || ''} | ${e.institution || ''} | ${e.graduationDate || ''}`);
      }
      lines.push('');
    }

    if (pr.skills?.length) {
      lines.push('SKILLS');
      lines.push(pr.skills.map((s: any) => s.name).join(', '));
      lines.push('');
    }

    if (pr.certifications?.length) {
      lines.push('CERTIFICATIONS');
      for (const c of pr.certifications) lines.push(`${c.name} – ${c.issuer} (${c.date})`);
      lines.push('');
    }

    if (pr.projects?.length) {
      lines.push('PROJECTS');
      for (const p of pr.projects) {
        lines.push(p.title || '');
        for (const d of (p.description || [])) lines.push(`• ${d}`);
        lines.push('');
      }
    }

    return lines.join('\n').trim();
  }

  onMount(() => {
    loadResumes();

    // Load user config — this is the primary source for both template previews AND
    // enhancement resume text. Works without auth or managed-files system.
    const loadConfig = (raw: string) => {
      const cfg = JSON.parse(raw);
      configFormData = cfg.formData || {};
      configParsedResume = cfg.original_resume?.parsed || null;

      // Immediately populate enhancement resume text from parsed config data.
      // This is always available once the user has configured their profile.
      if (configParsedResume) {
        const text = parsedResumeToText(configParsedResume, configFormData);
        if (text.trim()) {
          enhOriginalResume = text;
          enhResumeName = configFormData.resumeFileName || 'Resume (from configuration)';
        }
      }
    };

    invoke<string>('get_app_config_path')
      .then(p => invoke<string>('read_file_async', { filename: p }))
      .then(loadConfig)
      .catch(() => { /* no config available */ });

    // Subscribe to auth store to load jobs list and attempt to upgrade the resume
    // text from the actual uploaded file (better quality than parsed config data).
    let enhAuthInitialized = false;
    const unsubAuth = authService.subscribe((state: any) => {
      if (!state.loading && !enhAuthInitialized) {
        enhAuthInitialized = true;
        if (state.isLoggedIn) {
          user = state.user;
          loadEnhJobs();
          getJwtToken();
          // Best-effort: upgrade resume text from managed file (better than config text).
          // If this fails, the config-derived text is already set above.
          loadEnhOriginalResume(state.user?.email || '');
        }
      }
    });

    return unsubAuth;
  });

  // ── Template selection ───────────────────────────────────────────────────────

  async function handleTemplateSelect(templateId: string) {
    const rewriteResume = Boolean(configFormData?.rewriteResume);
    const title = `My Resume ${resumeCount + 1}`;

    let newResume: any;

    if (rewriteResume) {
      // "Rewrite resume for each job" is on — start from the base resume so the
      // user's full content is available for tailoring.
      const baseResume = $resumesStore.find((r: any) => r.isBase);
      if (baseResume) {
        // Deep-clone the base resume and apply the newly selected template.
        newResume = {
          ...JSON.parse(JSON.stringify(baseResume)),
          id: crypto.randomUUID(),
          templateId,
          title,
          isBase: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      } else {
        // No base resume yet — create a fresh one with only config personal info.
        newResume = createResumeFromConfig(templateId, title, configFormData);
      }
    } else {
      // "Rewrite resume for each job" is off — create a fresh resume pre-filled
      // with only the personal info from the user's saved configuration.
      newResume = createResumeFromConfig(templateId, title, configFormData);
    }

    // Mark as base if no base resume exists yet
    if (!$resumesStore.some((r: any) => r.isBase)) {
      newResume.isBase = true;
    }
    // Store as draft — only added to resumesStore when user clicks Save in the editor
    draftResume.set(newResume);
    goto('/resume-builder/edit/new');
  }

  function goToMyResumes() {
    goto('/resume-builder/my-resumes');
  }

  // ── Enhancement helpers ──────────────────────────────────────────────────────

  async function getJwtToken() {
    try {
      const token = await (authService as any).getAccessToken();
      if (token) { jwtToken = token; return; }
      const session = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
      if (!session) return;
      const res = await fetch(`${CORPUS_RAG_API}/api/auth/session-to-jwt`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session}`, 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.accessToken) jwtToken = data.accessToken;
      }
    } catch { /* silent */ }
  }

  async function loadEnhJobs() {
    enhLoading = true;
    try {
      const res = await fetch('/api/jobs');
      const data = await res.json();
      if (data.success) {
        enhJobs = (data.data?.jobs || data.jobs || [])
          .filter((j: any) => j.hasJobDetails)
          .map((j: any) => ({
            filename: j.filename,
            company: j.company || 'Unknown',
            title: j.title || 'No title',
            location: j.location || '',
            jobId: j.jobId || j.job_id || '',
          }));
      }
    } catch { /* silent */ } finally {
      enhLoading = false;
    }
  }

  async function selectEnhJob(job: any) {
    enhSelectedJob = job;
    enhJobDescription = '';
    enhancedText = null;
    enhFitScore = 0;
    enhEnhancedScore = 0;
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.filename)}`);
      const data = await res.json();
      if (data.success) {
        const content = data.data?.content || data.content || data.data;
        enhJobDescription = content?.description || content?.details || JSON.stringify(content, null, 2);
      }
    } catch { /* silent */ }
  }

  // Attempts to upgrade enhOriginalResume with actual file text from managed storage.
  // If anything fails, the config-derived text already set in onMount is preserved.
  async function loadEnhOriginalResume(userId: string) {
    if (!userId) return;
    try {
      let preferred = '';
      try {
        const configPath = await invoke<string>('get_app_config_path');
        const cfg = await invoke<string>('read_file_async', { filename: configPath });
        preferred = JSON.parse(cfg)?.formData?.resumeFileName?.trim() || '';
      } catch { /* ok */ }

      const rows = await invoke<any[]>('get_managed_files', { query: { userId, feature: 'resume' } });
      const resumes = (Array.isArray(rows) ? rows : []).filter((r: any) => {
        const name = String(r?.filename || '').toLowerCase();
        return name.endsWith('.pdf') || name.endsWith('.docx') || name.endsWith('.doc');
      });
      if (!resumes.length) return; // config-derived text remains

      const selected = (preferred ? resumes.find((r: any) => r.filename === preferred) : null)
        || resumes.find((r: any) => r.filename?.toLowerCase().includes('resume'))
        || resumes[0];

      const text = await invoke<string>('preview_managed_file', {
        query: { userId, fileId: selected.id, maxChars: 1_000_000 }
      });

      // Only upgrade if we got real extracted text (not a binary placeholder)
      if (text && !text.startsWith('[Binary file:')) {
        enhOriginalResume = text;
        enhResumeName = selected.filename;
      }
    } catch {
      // Managed files unavailable — config-derived text is already set, nothing to do
    }
  }

  async function handleEnhance() {
    if (!enhJobDescription.trim() || !enhOriginalResume.trim()) return;
    isEnhancing = true;
    enhancedText = null;
    enhFitScore = 0;
    enhEnhancedScore = 0;
    try {
      if (!jwtToken) await getJwtToken();
      const res = await fetch('/api/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwtToken}` },
        body: JSON.stringify({
          userId: user.email,
          jobDescription: enhJobDescription,
          enhancementFocus: 'general',
          resumeText: enhOriginalResume
        })
      });
      const data = await res.json();
      if (data.success) {
        enhancedText = data.enhancedResume;
        enhFitScore = data.originalFitScore || 0;
        enhEnhancedScore = data.enhancedFitScore || 0;
        enhSaveSuccess = false;
      } else {
        alert('Enhancement failed: ' + data.error);
      }
    } catch (e: any) {
      alert('Enhancement failed: ' + e.message);
    } finally {
      isEnhancing = false;
    }
  }

  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  async function handleSaveEnhanced() {
    if (!enhancedText) return;
    try {
      // Parse the enhanced text into structured data
      const parsed = parseResumeText(enhancedText);

      // Use the first template or the first resume's templateId
      const templateId = $resumesStore[0]?.templateId || TEMPLATES[0]?.id;
      const company = enhSelectedJob?.company || 'Company';
      const date = new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      const title = `Enhanced — ${company} (${date})`;

      const newResume = createResumeFromConfig(templateId, title, {}, parsed);
      const stored = resumesStore.add(newResume);
      autoSave();

      // Also save .docx to managed files if user is logged in
      try {
        const lines = enhancedText.split('\n').filter(l => l.trim());
        const paragraphs = lines.map(line => {
          const isH = line.length < 50 && (line === line.toUpperCase() ||
            /^(SUMMARY|EXPERIENCE|EDUCATION|SKILLS|PROJECTS|CERTIFICATIONS)/i.test(line));
          return isH
            ? new Paragraph({ text: line, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } })
            : new Paragraph({ children: [new TextRun(line)], spacing: { after: 120 } });
        });
        const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
        const blob = await Packer.toBlob(doc);
        const b64 = arrayBufferToBase64(await blob.arrayBuffer());
        const safeName = (enhSelectedJob?.company || 'company').replace(/[^a-zA-Z0-9._-]/g, '_');
        await invoke('register_managed_file_base64', {
          input: {
            userId: user.email,
            feature: 'enhancement',
            filename: `enhanced-resume-${safeName}-${Date.now()}.docx`,
            contentBase64: b64,
            jobId: enhSelectedJob?.jobId || enhSelectedJob?.filename,
            sourceRoute: '/resume-builder',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            tags: ['generated', 'resume-enhancement', 'docx']
          }
        });
      } catch { /* file save is best-effort */ }

      enhSavedTitle = title;
      enhSaveSuccess = true;
    } catch (e: any) {
      alert('Failed to save: ' + e.message);
    }
  }
</script>

<div class="container mx-auto p-8">
  <!-- Header -->
  <div class="mb-8">
    <h1 class="text-4xl font-bold text-primary mb-4">Resume Builder</h1>
    <p class="text-lg text-base-content/70 mb-4">
      Create professional ATS-friendly resumes in minutes. Choose a template to get started.
    </p>
    <div class="flex gap-4 items-center">
      <button class="btn btn-primary" on:click={goToMyResumes}>
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        My Resumes ({resumeCount})
      </button>
    </div>
  </div>

  <!-- Template Grid -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
    {#each TEMPLATES as template}
      <div class="card bg-base-100 shadow-xl hover:shadow-2xl transition-all duration-300 cursor-pointer"
           on:click={() => handleTemplateSelect(template.id)}
           on:keydown={(e) => e.key === 'Enter' && handleTemplateSelect(template.id)}
           role="button"
           tabindex="0">
        <!-- Template Preview -->
        <figure class="px-6 pt-6 flex items-center justify-center bg-base-200 rounded-t-lg overflow-hidden">
          <div class="w-full" style="height: 400px; overflow: hidden;">
            <TemplatePreview {template} previewData={previewUserData} />
          </div>
        </figure>

        <div class="card-body">
          <div class="flex items-start justify-between mb-2">
            <h2 class="card-title text-xl">{template.name}</h2>
            {#if template.atsCompliant}
              <div class="badge badge-success badge-sm">ATS</div>
            {/if}
          </div>
          <p class="text-sm text-base-content/70 mb-4">{template.description}</p>

          <div class="card-actions justify-end">
            <button class="btn btn-primary btn-sm w-full">
              Use Template
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    {/each}
  </div>

  <!-- Info Section -->
  <div class="mt-16 bg-base-200 rounded-lg p-8">
    <div class="max-w-3xl mx-auto text-center">
      <h2 class="text-3xl font-bold mb-4">Why Choose Our Resume Builder?</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mt-8">
        <div class="flex flex-col items-center">
          <div class="text-4xl mb-3">📄</div>
          <h3 class="font-semibold mb-2">ATS-Friendly</h3>
          <p class="text-sm text-base-content/70">
            All templates are optimized for Applicant Tracking Systems
          </p>
        </div>
        <div class="flex flex-col items-center">
          <div class="text-4xl mb-3">⚡</div>
          <h3 class="font-semibold mb-2">Fast & Easy</h3>
          <p class="text-sm text-base-content/70">
            Create professional resumes in minutes
          </p>
        </div>
        <div class="flex flex-col items-center">
          <div class="text-4xl mb-3">💾</div>
          <h3 class="font-semibold mb-2">Save & Edit</h3>
          <p class="text-sm text-base-content/70">
            Store multiple resumes and update anytime
          </p>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Enhancement Panel ──────────────────────────────────────────────────── -->
  <div class="mt-12">
    <div class="card bg-base-100 shadow-xl">
      <div class="card-body">
        <h2 class="card-title text-2xl mb-2">
          ✨ Resume Enhancement
        </h2>
        <p class="text-base-content/70 mb-6">
          Tailor your existing resume to a specific job using AI, then save the result directly to My Resumes.
        </p>

        {#if !$authService.loading && !$authService.isLoggedIn}
          <div class="alert alert-warning">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>Please <a href="/login" class="link">log in</a> to use resume enhancement.</span>
          </div>
        {:else}
          <!-- Resume status -->
          <div class="mb-4">
            {#if enhOriginalResume}
              <div class="alert alert-success alert-sm py-2">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
                <span class="text-sm">Resume loaded: <strong>{enhResumeName}</strong></span>
              </div>
            {:else}
              <div class="alert alert-warning alert-sm py-2">
                <span class="text-sm">No resume found. Set up your profile on the <a href="/configuration" class="link">Configuration</a> page.</span>
              </div>
            {/if}
          </div>

          <!-- Job selector + Enhance button -->
          <div class="flex flex-wrap gap-3 items-end mb-4">
            <div class="form-control flex-1 min-w-[200px]">
              <label class="label pb-1">
                <span class="label-text font-semibold">Select Job</span>
              </label>
              {#if enhLoading}
                <div class="flex items-center gap-2 text-sm text-base-content/70 h-12">
                  <span class="loading loading-spinner loading-xs"></span>
                  Loading jobs...
                </div>
              {:else if enhJobs.length === 0}
                <p class="text-sm text-base-content/50">No jobs found. Add one from <a href="/resume-enhancement" class="link">Resume Enhancement</a>.</p>
              {:else}
                <select
                  class="select select-bordered w-full"
                  on:change={(e) => {
                    const job = enhJobs.find(j => j.filename === (e.target as HTMLSelectElement).value);
                    if (job) selectEnhJob(job);
                  }}
                >
                  <option value="">-- choose a job --</option>
                  {#each enhJobs as job}
                    <option value={job.filename}>{job.company} — {job.title}</option>
                  {/each}
                </select>
              {/if}
            </div>

            <button
              class="btn btn-primary"
              disabled={isEnhancing || !enhSelectedJob || !enhOriginalResume}
              on:click={handleEnhance}
            >
              {#if isEnhancing}
                <span class="loading loading-spinner loading-sm"></span>
                Enhancing...
              {:else}
                ✨ Enhance Resume
              {/if}
            </button>
          </div>

          <!-- Fit score display -->
          {#if enhFitScore > 0 || enhEnhancedScore > 0}
            <div class="flex gap-4 mb-4">
              <div class="stat bg-base-200 rounded-lg py-3 px-5 flex-1">
                <div class="stat-title text-xs">Original Fit</div>
                <div class="stat-value text-2xl text-primary">{enhFitScore}%</div>
              </div>
              <div class="stat bg-success/20 rounded-lg py-3 px-5 flex-1">
                <div class="stat-title text-xs">Enhanced Fit</div>
                <div class="stat-value text-2xl text-success">{enhEnhancedScore}%</div>
              </div>
              <div class="stat bg-base-200 rounded-lg py-3 px-5 flex-1">
                <div class="stat-title text-xs">Improvement</div>
                <div class="stat-value text-2xl text-accent">+{enhEnhancedScore - enhFitScore}%</div>
              </div>
            </div>
          {/if}

          <!-- Results -->
          {#if enhancedText}
            <div class="border border-base-300 rounded-lg overflow-hidden mb-4">
              <div class="bg-base-200 px-4 py-3 flex items-center justify-between">
                <span class="font-semibold">Enhanced Resume</span>
                <div class="flex gap-2">
                  <button
                    class="btn btn-xs {enhComparisonView === 'unified' ? 'btn-primary' : 'btn-ghost'}"
                    on:click={() => enhComparisonView = 'unified'}
                  >
                    Unified
                  </button>
                  <button
                    class="btn btn-xs {enhComparisonView === 'sidebyside' ? 'btn-primary' : 'btn-ghost'}"
                    on:click={() => enhComparisonView = 'sidebyside'}
                  >
                    Side by Side
                  </button>
                </div>
              </div>

              {#if enhComparisonView === 'unified'}
                <div class="p-4 max-h-96 overflow-y-auto">
                  <pre class="text-sm whitespace-pre-wrap">{enhancedText}</pre>
                </div>
              {:else}
                <div class="grid grid-cols-2 divide-x divide-base-300">
                  <div class="p-4 max-h-96 overflow-y-auto">
                    <p class="text-xs font-semibold mb-2 text-base-content/60">ORIGINAL</p>
                    <pre class="text-sm whitespace-pre-wrap">{enhOriginalResume}</pre>
                  </div>
                  <div class="p-4 max-h-96 overflow-y-auto">
                    <p class="text-xs font-semibold mb-2 text-success">ENHANCED</p>
                    <pre class="text-sm whitespace-pre-wrap">{enhancedText}</pre>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Save to My Resumes -->
            {#if enhSaveSuccess}
              <div class="alert alert-success">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
                <span>Saved as "<strong>{enhSavedTitle}</strong>" in My Resumes.</span>
                <button class="btn btn-sm btn-ghost" on:click={goToMyResumes}>View →</button>
              </div>
            {:else}
              <button class="btn btn-success" on:click={handleSaveEnhanced}>
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
                Save to My Resumes
              </button>
            {/if}
          {/if}
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .card {
    transition: transform 0.2s ease;
  }

  .card:hover {
    transform: translateY(-4px);
  }
</style>
