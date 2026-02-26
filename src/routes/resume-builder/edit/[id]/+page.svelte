<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
import { resumesStore, activeResume, draftResume, createExperience, createEducation, createSkill, createCertification, createProject, createLanguage, autoSave, loadResumes } from '$lib/resume/store';
import { downloadDocx, downloadPdf, saveBaseResumeJsonToDisk } from '$lib/resume/generator';
import { getTemplateById } from '$lib/resume/templates';
import type { ResumeData } from '$lib/resume/types';
import { getEffectiveFont, getEffectiveFontSize, getLetterSpacing, getLineSpacing } from '$lib/resume/utils/font-helpers';
import { invoke } from '@tauri-apps/api/core';

  let resume: ResumeData | null = null;
  let userEmail = '';
  let saving = false;
  let downloading = false;
  let downloadingPdf = false;
  let editingField: string | null = null;
  let isNewDraft = false;

  $: resumeId = ($page.params as any).id || '';
  $: template = resume ? getTemplateById(resume.templateId) : null;
  // Reset contact field init flag when navigating to a different resume
  $: { resumeId; contactFieldsInitialized = false; }

  // Layout info derived from template config
  $: layoutType = template?.style.layoutType || 'single-column';
  $: isTwoColumnLayout = layoutType === 'two-column-split' || layoutType === 'two-column-sidebar';
  $: sidebarSections = template?.style.sidebarSections || [];
  $: mainSections = template?.style.mainSections || [];
  $: contactInSidebar = template?.style.contactPlacement === 'sidebar';
  $: leftColWidth = template?.style.leftColumnWidth ?? 30;
  $: rightColWidth = template?.style.rightColumnWidth ?? 70;

  // Which section IDs this template actually uses
  $: visibleSectionIds = new Set((template?.sections || []).map((s: any) => s.id));

  // Sections that appear full-width before the two-column block
  // (visible but not in sidebar or main, e.g. a full-width summary before columns)
  $: preTableSectionIds = isTwoColumnLayout
    ? new Set(
        (template?.sections || [])
          .map((s: any) => s.id)
          .filter((id: string) => id !== 'personalInfo' && !sidebarSections.includes(id) && !mainSections.includes(id))
      )
    : new Set<string>();

  $: if (resumeId && resumeId !== 'new' && !resume) {
    const loadedResume = resumesStore.getById(resumeId);
    if (loadedResume) {
      resume = loadedResume;
      activeResume.set(loadedResume);
    } else if (resumeId) {
      goto('/resume-builder');
    }
  }

  onMount(async () => {
    try {
      const configPath = await invoke<string>('get_app_config_path');
      const raw = await invoke<string>('read_file_async', { filename: configPath });
      const config = JSON.parse(raw);
      userEmail = String(config?.formData?.email || config?.email || '').trim();
    } catch {
      // email remains empty; saveBaseResumeJsonToDisk will be skipped
    }

    if (resumeId === 'new') {
      const draft = get(draftResume);
      if (draft) {
        resume = draft;
        activeResume.set(draft);
        isNewDraft = true;
      } else {
        goto('/resume-builder');
      }
      return;
    }

    if (get(resumesStore).length === 0) {
      await loadResumes();
    }

    if (resumeId && !resume) {
      const loadedResume = resumesStore.getById(resumeId);
      if (loadedResume) {
        resume = loadedResume;
        activeResume.set(loadedResume);
      } else {
        goto('/resume-builder');
      }
    }
  });

  let saveTimeout: any = null;
  $: if (resume && !isNewDraft) {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (resume && !isNewDraft) {
        resumesStore.updateById(resumeId, resume);
        autoSave();
      }
    }, 1000);
  }

  async function trySaveBaseResumeToDisk(r: ResumeData) {
    if (!userEmail) return;
    try {
      await saveBaseResumeJsonToDisk(r, userEmail);
    } catch (err) {
      console.warn('Failed to save base resume JSON to disk:', err);
    }
  }

  async function handleSave() {
    if (!resume) return;
    saving = true;
    try {
      if (isNewDraft) {
        const stored = resumesStore.add(resume);
        draftResume.set(null);
        isNewDraft = false;
        autoSave();
        if (stored.isBase) await trySaveBaseResumeToDisk(stored);
        await new Promise(resolve => setTimeout(resolve, 300));
        goto(`/resume-builder/edit/${stored.id}`, { replaceState: true });
      } else {
        resumesStore.updateById(resumeId, resume);
        autoSave();
        if (resume.isBase) await trySaveBaseResumeToDisk(resume);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } finally {
      saving = false;
    }
  }

  async function handleDownloadPdf() {
    if (!resume) return;
    downloadingPdf = true;
    try {
      const savedPath = await downloadPdf(resume, resume.title);
      alert(`✅ PDF saved to:\n${savedPath}`);
    } catch (error) {
      console.error('PDF download error:', error);
      alert(`Failed to save PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      downloadingPdf = false;
    }
  }

  async function handleDownload() {
    if (!resume) return;
    downloading = true;
    try {
      const savedPath = await downloadDocx(resume, resume.title);
      alert(`✅ DOCX saved to:\n${savedPath}`);
    } catch (error) {
      console.error('Download error:', error);
      alert(`Failed to save DOCX: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      downloading = false;
    }
  }

  function startEditing(field: string) { editingField = field; }
  function stopEditing() { editingField = null; }

  function addExperience() {
    if (!resume) return;
    resume.experience = [...resume.experience, createExperience()];
  }
  function removeExperience(index: number) {
    if (!resume) return;
    resume.experience = resume.experience.filter((_: any, i: number) => i !== index);
  }
  function addEducation() {
    if (!resume) return;
    resume.education = [...resume.education, createEducation()];
  }
  function removeEducation(index: number) {
    if (!resume) return;
    resume.education = resume.education.filter((_: any, i: number) => i !== index);
  }
  function addSkill() {
    if (!resume) return;
    resume.skills = [...resume.skills, createSkill()];
  }
  function removeSkill(index: number) {
    if (!resume) return;
    resume.skills = resume.skills.filter((_: any, i: number) => i !== index);
  }
  function addAchievement(expIndex: number) {
    if (!resume) return;
    resume.experience[expIndex].achievements = [...resume.experience[expIndex].achievements, ''];
  }
  function removeAchievement(expIndex: number, achIndex: number) {
    if (!resume) return;
    resume.experience[expIndex].achievements = resume.experience[expIndex].achievements.filter((_: any, i: number) => i !== achIndex);
  }
  function addCertification() {
    if (!resume) return;
    if (!resume.certifications) resume.certifications = [];
    resume.certifications = [...resume.certifications, createCertification()];
  }
  function removeCertification(index: number) {
    if (!resume) return;
    resume.certifications = resume.certifications?.filter((_: any, i: number) => i !== index) || [];
  }
  function addProject() {
    if (!resume) return;
    if (!resume.projects) resume.projects = [];
    resume.projects = [...resume.projects, createProject()];
  }
  function removeProject(index: number) {
    if (!resume) return;
    resume.projects = resume.projects?.filter((_: any, i: number) => i !== index) || [];
  }
  function addProjectDescription(projIndex: number) {
    if (!resume || !resume.projects) return;
    resume.projects[projIndex].description = [...resume.projects[projIndex].description, ''];
  }
  function removeProjectDescription(projIndex: number, descIndex: number) {
    if (!resume || !resume.projects) return;
    resume.projects[projIndex].description = resume.projects[projIndex].description.filter((_: any, i: number) => i !== descIndex);
  }

  function naClass(val: string | undefined | null): string {
    return (!val || val.trim() === 'N/A') ? 'na-value' : '';
  }

  // ── Contact field management ──────────────────────────────────────────────
  // Track which optional contact fields are currently shown in the contact row.
  // Initialised once when the resume first loads.
  let shownContactFields = new Set<string>();
  let contactFieldsInitialized = false;

  $: if (resume && !contactFieldsInitialized) {
    contactFieldsInitialized = true;
    const shown = new Set<string>();
    shown.add('phone');
    shown.add('email');
    if (resume.personalInfo.linkedin) shown.add('linkedin');
    if (resume.personalInfo.github)   shown.add('github');
    if (resume.personalInfo.website)  shown.add('website');
    if (resume.personalInfo.address)  shown.add('address');
    shownContactFields = shown;
  }

  $: anyBeforePhone    = shownContactFields.has('address');
  $: anyBeforeEmail    = anyBeforePhone    || shownContactFields.has('phone');
  $: anyBeforeLinkedin = anyBeforeEmail    || shownContactFields.has('email');
  $: anyBeforeGithub   = anyBeforeLinkedin || shownContactFields.has('linkedin');
  $: anyBeforeWebsite  = anyBeforeGithub   || shownContactFields.has('github');

  function addContactField(field: string) {
    shownContactFields = new Set([...shownContactFields, field]);
  }

  function removeContactField(field: string) {
    if (!resume) return;
    (resume.personalInfo as any)[field] = '';
    resume = resume; // trigger reactivity
    const next = new Set(shownContactFields);
    next.delete(field);
    shownContactFields = next;
  }

  function addContactExtra() {
    if (!resume) return;
    if (!resume.personalInfo.contactExtras) resume.personalInfo.contactExtras = [];
    resume.personalInfo.contactExtras = [
      ...resume.personalInfo.contactExtras,
      { id: crypto.randomUUID(), label: '', value: '' }
    ];
    resume = resume;
  }

  function removeContactExtra(id: string) {
    if (!resume) return;
    resume.personalInfo.contactExtras = (resume.personalInfo.contactExtras || []).filter(e => e.id !== id);
    resume = resume;
  }

  function addLanguage() {
    if (!resume) return;
    if (!resume.languages) resume.languages = [];
    resume.languages = [...resume.languages, createLanguage()];
  }
  function removeLanguage(index: number) {
    if (!resume) return;
    resume.languages = resume.languages?.filter((_: any, i: number) => i !== index) || [];
  }

  // ── Section title / visibility helpers ───────────────────────────────────
  function getSectionTitle(id: string, defaultTitle: string): string {
    return resume?.sectionTitles?.[id] ?? defaultTitle;
  }

  function setSectionTitle(id: string, value: string) {
    if (!resume) return;
    if (!resume.sectionTitles) resume.sectionTitles = {};
    resume.sectionTitles[id] = value;
    resume = resume;
  }

  function isHidden(id: string): boolean {
    return (resume?.hiddenSections || []).includes(id);
  }

  function hideSection(id: string) {
    if (!resume) return;
    resume.hiddenSections = [...(resume.hiddenSections || []).filter(s => s !== id), id];
    resume = resume;
  }

  function restoreSection(id: string) {
    if (!resume) return;
    resume.hiddenSections = (resume.hiddenSections || []).filter(s => s !== id);
    resume = resume;
  }

  // Section heading style helpers
  function sectionHeaderStyle(t: typeof template) {
    if (!t) return '';
    const parts = [`color: ${t.style.primaryColor}`];
    if (t.style.dividerStyle === 'line') {
      parts.push(`border-bottom: 1px solid ${t.style.dividerColor}`);
      parts.push('padding-bottom: 4px');
    }
    return parts.join('; ');
  }
</script>

<div class="w-full min-h-screen px-4 lg:px-8 py-6 edit-page">
  {#if resume}
  <!-- Header bar -->
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h1 class="text-3xl font-bold text-primary">Edit Resume</h1>
      <p class="text-sm text-base-content/70 mt-1">Template: {template?.name || 'Unknown'} | Click any field to edit</p>
    </div>
    <div class="flex gap-2 items-center">
      <button class="btn btn-ghost" on:click={() => { draftResume.set(null); goto('/resume-builder'); }}>
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>
      <button class="btn btn-success" disabled={saving} on:click={handleSave}>
        {#if saving}
          <span class="loading loading-spinner loading-sm"></span>
          Saving...
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          Save
        {/if}
      </button>
      <button class="btn" disabled={downloadingPdf} on:click={handleDownloadPdf}>
        {#if downloadingPdf}
          <span class="loading loading-spinner loading-sm"></span>
          Generating...
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download .pdf
        {/if}
      </button>
      <button class="btn" disabled={downloading} on:click={handleDownload}>
        {#if downloading}
          <span class="loading loading-spinner loading-sm"></span>
          Downloading...
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download .docx
        {/if}
      </button>
    </div>
  </div>

  <!-- WYSIWYG Editor Card -->
  <div class="card bg-white shadow-2xl">
    <div class="card-body p-6 lg:p-10"
         style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'body') : 'Arial, sans-serif'}
         style:line-height={resume ? getLineSpacing(resume) : 1.0}
         style:letter-spacing={resume ? getLetterSpacing(resume) : 'normal'}>

      <!-- ===== HEADER: Name / Title / Contact ===== -->
      <div class="mb-4 pb-4"
           style:text-align={template?.style.headerAlignment || 'center'}
           style:border-bottom={template?.style.headerStyle === 'underline'
             ? `2px solid ${template.style.primaryColor}`
             : template?.style.headerStyle === 'background'
             ? `2px solid ${template.style.secondaryColor}`
             : template
             ? `2px solid ${template.style.dividerColor}`
             : '2px solid #e5e7eb'}>

        <!-- Name -->
        <div class="mb-1 cursor-text hover:bg-gray-50 p-2 rounded transition-colors {naClass(resume?.personalInfo?.fullName)}"
             on:click={() => startEditing('fullName')}>
          {#if editingField === 'fullName'}
            <input
              type="text"
              class="text-3xl font-bold border-none outline-none bg-transparent w-full"
              style:color={template?.style.primaryColor || '#000000'}
              style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'header') : 'Arial, sans-serif'}
              style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'name') : 16}pt"
              style:font-weight={template?.style.headerFontWeight || 'bold'}
              style:text-align={template?.style.headerAlignment || 'center'}
              style:text-transform={template?.style.nameUppercase ? 'uppercase' : 'none'}
              bind:value={resume.personalInfo.fullName}
              autofocus
              on:blur={() => stopEditing()}
            />
          {:else}
            <h1 class="text-3xl font-bold"
                style:color={template?.style.primaryColor || '#000000'}
                style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'header') : 'Arial, sans-serif'}
                style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'name') : 16}pt"
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                style:text-align={template?.style.headerAlignment || 'center'}
                style:text-transform={template?.style.nameUppercase ? 'uppercase' : 'none'}>
              {resume.personalInfo.fullName || 'Your Full Name'}
            </h1>
          {/if}
        </div>

        <!-- Job Title -->
        <div class="mb-2 cursor-text hover:bg-gray-50 p-2 rounded transition-colors {naClass(resume?.personalInfo?.title)}"
             on:click={() => startEditing('title')}>
          {#if editingField === 'title'}
            <input
              type="text"
              class="text-xl italic border-none outline-none bg-transparent w-full"
              style:color={template?.style.textColor || '#000000'}
              style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'body') : 'Arial, sans-serif'}
              style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'body') : 11}pt"
              style:text-align={template?.style.headerAlignment || 'center'}
              bind:value={resume.personalInfo.title}
              autofocus
              on:blur={() => stopEditing()}
            />
          {:else}
            <h2 class="text-xl italic"
                style:color={template?.style.textColor || '#000000'}
                style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'body') : 'Arial, sans-serif'}
                style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'body') : 11}pt"
                style:text-align={template?.style.headerAlignment || 'center'}>
              {resume.personalInfo.title || 'Your Job Title'}
            </h2>
          {/if}
        </div>

        <!-- Contact info — only shown in header when template places contact there -->
        {#if !contactInSidebar}
        <div class="contact-row"
             style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'contact') : 'Arial, sans-serif'}
             style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'contact') : 10}pt"
             style:color={template?.style.textColor || '#000000'}
             style:justify-content={template?.style.headerAlignment === 'center' ? 'center' : template?.style.headerAlignment === 'right' ? 'flex-end' : 'flex-start'}>

          <!-- Address — optional, shown first -->
          {#if shownContactFields.has('address')}
            <span class="contact-optional-field">
              <span class="contact-label">address:</span>
              <input
                type="text"
                class="contact-input"
                size={Math.max(4, (resume.personalInfo.address || 'City, Country').length)}
                style:color={template?.style.textColor || '#000000'}
                bind:value={resume.personalInfo.address}
                placeholder="City, Country"
              />
              <button class="contact-remove" on:click={() => removeContactField('address')} title="Remove Address">×</button>
            </span>
          {/if}

          <!-- Phone -->
          {#if shownContactFields.has('phone')}
            {#if anyBeforePhone}<span class="contact-sep" style:color={template?.style.dividerColor || '#9ca3af'}>|</span>{/if}
            <span class="contact-optional-field">
              <span class="contact-label">phone:</span>
              <input
                type="tel"
                class="contact-input {naClass(resume.personalInfo.phone)}"
                size={Math.max(4, (resume.personalInfo.phone || 'Phone number').length)}
                style:color={template?.style.textColor || '#000000'}
                bind:value={resume.personalInfo.phone}
                placeholder="Phone number"
              />
              <button class="contact-remove" on:click={() => removeContactField('phone')} title="Remove Phone">×</button>
            </span>
          {/if}

          <!-- Email -->
          {#if shownContactFields.has('email')}
            {#if anyBeforeEmail}<span class="contact-sep" style:color={template?.style.dividerColor || '#9ca3af'}>|</span>{/if}
            <span class="contact-optional-field">
              <span class="contact-label">email:</span>
              <input
                type="email"
                class="contact-input {naClass(resume.personalInfo.email)}"
                size={Math.max(4, (resume.personalInfo.email || 'email@example.com').length)}
                style:color={template?.style.textColor || '#000000'}
                bind:value={resume.personalInfo.email}
                placeholder="email@example.com"
              />
              <button class="contact-remove" on:click={() => removeContactField('email')} title="Remove Email">×</button>
            </span>
          {/if}

          <!-- LinkedIn — optional -->
          {#if shownContactFields.has('linkedin')}
            {#if anyBeforeLinkedin}<span class="contact-sep" style:color={template?.style.dividerColor || '#9ca3af'}>|</span>{/if}
            <span class="contact-optional-field">
              <span class="contact-label">linkedin:</span>
              <input
                type="text"
                class="contact-input contact-input-url"
                size={Math.max(4, (resume.personalInfo.linkedin || 'linkedin.com/in/username').length)}
                style:color={template?.style.textColor || '#000000'}
                bind:value={resume.personalInfo.linkedin}
                placeholder="linkedin.com/in/username"
              />
              <button class="contact-remove" on:click={() => removeContactField('linkedin')} title="Remove LinkedIn">×</button>
            </span>
          {/if}

          <!-- GitHub — optional -->
          {#if shownContactFields.has('github')}
            {#if anyBeforeGithub}<span class="contact-sep" style:color={template?.style.dividerColor || '#9ca3af'}>|</span>{/if}
            <span class="contact-optional-field">
              <span class="contact-label">github:</span>
              <input
                type="text"
                class="contact-input contact-input-url"
                size={Math.max(4, (resume.personalInfo.github || 'github.com/username').length)}
                style:color={template?.style.textColor || '#000000'}
                bind:value={resume.personalInfo.github}
                placeholder="github.com/username"
              />
              <button class="contact-remove" on:click={() => removeContactField('github')} title="Remove GitHub">×</button>
            </span>
          {/if}

          <!-- Website — optional -->
          {#if shownContactFields.has('website')}
            {#if anyBeforeWebsite}<span class="contact-sep" style:color={template?.style.dividerColor || '#9ca3af'}>|</span>{/if}
            <span class="contact-optional-field">
              <span class="contact-label">website:</span>
              <input
                type="url"
                class="contact-input contact-input-url"
                size={Math.max(4, (resume.personalInfo.website || 'yourwebsite.com').length)}
                style:color={template?.style.textColor || '#000000'}
                bind:value={resume.personalInfo.website}
                placeholder="yourwebsite.com"
              />
              <button class="contact-remove" on:click={() => removeContactField('website')} title="Remove Website">×</button>
            </span>
          {/if}

          <!-- Custom extra fields (label: value) -->
          {#each (resume.personalInfo.contactExtras || []) as extra (extra.id)}
            <span class="contact-sep" style:color={template?.style.dividerColor || '#9ca3af'}>|</span>
            <span class="contact-optional-field">
              <input
                type="text"
                class="contact-input contact-extra-label"
                size={Math.max(4, (extra.label || 'label').length)}
                style:color={template?.style.textColor || '#000000'}
                bind:value={extra.label}
                placeholder="label"
              /><span class="contact-extra-colon">:</span>
              <input
                type="text"
                class="contact-input"
                size={Math.max(4, (extra.value || 'value').length)}
                style:color={template?.style.textColor || '#000000'}
                bind:value={extra.value}
                placeholder="value"
              />
              <button class="contact-remove" on:click={() => removeContactExtra(extra.id)} title="Remove field">×</button>
            </span>
          {/each}

          <!-- "+" button — adds a new label: value segment -->
            <button class="btn btn-xs btn-primary font-bold ml-auto" on:click={addContactExtra} title="Add contact field">+ Add</button>
        </div>
        {/if}<!-- end {#if !contactInSidebar} -->
      </div>

      <!-- ===== PRE-TABLE SECTIONS (full-width sections before the two-column area) ===== -->
      {#if preTableSectionIds.has('summary') && !isHidden('summary')}
        <div class="mb-6">
          <div class="flex items-center justify-between mb-3">
            <input
              class="section-title-input"
              style={sectionHeaderStyle(template)}
              style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'header') : 'Arial, sans-serif'}
              style:font-weight={template?.style.headerFontWeight || 'bold'}
              value={getSectionTitle('summary', 'Summary')}
              on:input={(e) => setSectionTitle('summary', e.currentTarget.value)}
              placeholder="Summary"
            />
            <div class="flex items-center gap-1">
              <button class="btn btn-xs btn-ghost" on:click={() => startEditing('summary')}>
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button class="section-remove-btn" on:click={() => hideSection('summary')}>Remove</button>
            </div>
          </div>
          <div class="text-sm leading-relaxed cursor-text hover:bg-gray-50 p-3 rounded transition-colors text-black {naClass(resume?.summary)}"
               style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'body') : 'Arial, sans-serif'}
               style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'body') : 11}pt"
               on:click={() => startEditing('summary')}>
            {#if editingField === 'summary'}
              <textarea
                class="w-full border-none outline-none bg-transparent resize-none min-h-[80px] text-black"
                style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'body') : 'Arial, sans-serif'}
                style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'body') : 11}pt"
                bind:value={resume.summary}
                autofocus
                on:blur={() => stopEditing()}
                placeholder="Brief professional summary..."
              ></textarea>
            {:else}
              <p class="text-sm text-black">{resume.summary || 'Brief professional summary (Click to edit)'}</p>
            {/if}
          </div>
        </div>
      {/if}

      <!-- ===== COLUMNS WRAPPER ===== -->
      <div
        class={isTwoColumnLayout ? 'edit-two-column' : ''}
        style:grid-template-columns={isTwoColumnLayout ? `${leftColWidth}fr ${rightColWidth}fr` : undefined}>

        <!-- ===== MAIN COLUMN (right for two-col; only column for single-col) ===== -->
        <div class={isTwoColumnLayout ? 'edit-main' : ''}>

          <!-- Summary (single-col only OR explicitly in mainSections for two-col) -->
          {#if ((!isTwoColumnLayout && visibleSectionIds.has('summary')) || (isTwoColumnLayout && mainSections.includes('summary'))) && !isHidden('summary')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'header') : 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('summary', 'Summary')}
                on:input={(e) => setSectionTitle('summary', e.currentTarget.value)}
                placeholder="Summary"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-ghost" on:click={() => startEditing('summary')}>
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button class="section-remove-btn" on:click={() => hideSection('summary')}>Remove</button>
              </div>
            </div>
            <div class="text-sm leading-relaxed cursor-text hover:bg-gray-50 p-3 rounded transition-colors text-black {naClass(resume?.summary)}"
                 style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'body') : 'Arial, sans-serif'}
                 style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'body') : 11}pt"
                 on:click={() => startEditing('summary')}>
              {#if editingField === 'summary'}
                <textarea
                  class="w-full border-none outline-none bg-transparent resize-none min-h-[80px] text-black"
                  style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'body') : 'Arial, sans-serif'}
                  style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'body') : 11}pt"
                  bind:value={resume.summary}
                  autofocus
                  on:blur={() => stopEditing()}
                  placeholder="Experienced professional with expertise in..."
                ></textarea>
              {:else}
                <p class="text-sm text-black">{resume.summary || 'Experienced professional with expertise in... (Click to edit)'}</p>
              {/if}
            </div>
          </div>
          {/if}

          <!-- Experience -->
          {#if ((!isTwoColumnLayout && visibleSectionIds.has('experience')) || (isTwoColumnLayout && mainSections.includes('experience'))) && !isHidden('experience')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('experience', 'Experience')}
                on:input={(e) => setSectionTitle('experience', e.currentTarget.value)}
                placeholder="Experience"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addExperience}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('experience')} >Remove</button>
              </div>
            </div>
            {#if resume.experience.length === 0}
              <div class="border border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50 transition-colors" on:click={addExperience}>
                <p class="text-sm text-black">Click to add your first work experience</p>
              </div>
            {:else}
              {#each resume.experience as exp, expIndex}
                <div class="mb-4 pb-4 border-b border-gray-200 last:border-0">
                  <div class="flex items-start justify-between">
                    <div class="flex-1">
                      <input type="text" class="text-base font-bold border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-1 rounded w-full text-black {naClass(exp.jobTitle)}" bind:value={exp.jobTitle} placeholder="Job Title" />
                      <input type="text" class="text-sm border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-1 rounded w-full text-black {naClass(exp.company)}" bind:value={exp.company} placeholder="Company Name" />
                      <div class="flex items-center gap-2 text-xs mt-1">
                        <input type="text" class="cursor-text hover:bg-gray-50 p-1 rounded border-none outline-none bg-transparent max-w-[100px] text-black" bind:value={exp.startDate} placeholder="Start Date" />
                        <span>-</span>
                        <input type="text" class="cursor-text hover:bg-gray-50 p-1 rounded border-none outline-none bg-transparent max-w-[100px] text-black" bind:value={exp.endDate} placeholder="End Date" />
                      </div>
                    </div>
                    <button class="btn btn-xs btn-error btn-square font-bold" on:click={() => removeExperience(expIndex)}>×</button>
                  </div>
                  <div class="mt-2">
                    {#each exp.achievements as achievement, achIndex}
                      <div class="flex items-start gap-2 mb-1">
                        <span class="text-black">•</span>
                        <textarea class="flex-1 text-sm border-none outline-none bg-transparent resize-none cursor-text hover:bg-gray-50 p-1 rounded text-black" bind:value={exp.achievements[achIndex]} placeholder="Describe your achievement..."></textarea>
                        <button class="btn btn-xs btn-error btn-square font-bold" on:click={() => removeAchievement(expIndex, achIndex)}>×</button>
                      </div>
                    {/each}
                    <button class="btn btn-xs btn-outline mt-2 font-bold" on:click={() => addAchievement(expIndex)}>+ Add Achievement</button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
          {/if}

          <!-- Education in MAIN column -->
          {#if ((!isTwoColumnLayout && visibleSectionIds.has('education')) || (isTwoColumnLayout && mainSections.includes('education'))) && !isHidden('education')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('education', 'Education')}
                on:input={(e) => setSectionTitle('education', e.currentTarget.value)}
                placeholder="Education"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addEducation}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('education')} >Remove</button>
              </div>
            </div>
            {#if resume.education.length === 0}
              <div class="border border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50 transition-colors" on:click={addEducation}>
                <p class="text-sm text-black">Click to add your education</p>
              </div>
            {:else}
              {#each resume.education as edu, eduIndex}
                <div class="mb-4 pb-4 border-b border-gray-200 last:border-0">
                  <div class="flex items-start justify-between">
                    <div class="flex-1">
                      <input type="text" class="text-base font-bold border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-1 rounded w-full text-black" bind:value={edu.degree} placeholder="Degree" />
                      <input type="text" class="text-sm border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-1 rounded w-full text-black" bind:value={edu.institution} placeholder="Institution" />
                      <div class="flex items-center gap-2 text-xs mt-1">
                        <input type="text" class="border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-1 rounded max-w-[100px] text-black" bind:value={edu.graduationDate} placeholder="Year" />
                        {#if edu.gpa}
                          <span>|</span>
                          <input type="text" class="border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-1 rounded max-w-[80px] text-black" bind:value={edu.gpa} placeholder="GPA" />
                        {/if}
                      </div>
                    </div>
                    <button class="btn btn-xs btn-error btn-square font-bold" on:click={() => removeEducation(eduIndex)}>×</button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
          {/if}

          <!-- Skills (single-column only) -->
          {#if !isTwoColumnLayout && visibleSectionIds.has('skills') && !isHidden('skills')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('skills', 'Skills')}
                on:input={(e) => setSectionTitle('skills', e.currentTarget.value)}
                placeholder="Skills"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addSkill}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('skills')} >Remove</button>
              </div>
            </div>
            {#if resume.skills.length === 0}
              <div class="border border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50 transition-colors" on:click={addSkill}>
                <p class="text-sm text-black">Click to add your skills</p>
              </div>
            {:else}
              <div class="space-y-2">
                {#each resume.skills as skill, skillIndex}
                  <div class="flex items-center gap-2">
                    <input type="text" class="flex-1 text-sm border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-2 rounded text-black" bind:value={skill.name} placeholder="Skill name" />
                    <input type="text" class="max-w-[150px] text-xs border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-2 rounded text-black" bind:value={skill.category} placeholder="Category" />
                    <button class="btn btn-xs btn-error font-bold" on:click={() => removeSkill(skillIndex)}>×</button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
          {/if}

          <!-- Projects (single-col or in mainSections) -->
          {#if ((!isTwoColumnLayout && visibleSectionIds.has('projects')) || (isTwoColumnLayout && mainSections.includes('projects'))) && !isHidden('projects')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('projects', 'Projects')}
                on:input={(e) => setSectionTitle('projects', e.currentTarget.value)}
                placeholder="Projects"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addProject}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('projects')} >Remove</button>
              </div>
            </div>
            {#each resume.projects as project, projIndex}
              <div class="mb-4 pb-4 border-b border-gray-200 last:border-0">
                <div class="flex items-start justify-between">
                  <div class="flex-1">
                    <input type="text" class="text-base font-bold border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-1 rounded w-full text-black" bind:value={project.title} placeholder="Project Title" />
                  </div>
                  <button class="btn btn-xs btn-error btn-square font-bold" on:click={() => removeProject(projIndex)}>×</button>
                </div>
                <div class="mt-2">
                  {#each project.description as desc, descIndex}
                    <div class="flex items-start gap-2 mb-1">
                      <span class="text-black">•</span>
                      <textarea class="flex-1 text-sm border-none outline-none bg-transparent resize-none cursor-text hover:bg-gray-50 p-1 rounded text-black" bind:value={project.description[descIndex]} placeholder="Project detail..."></textarea>
                      <button class="btn btn-xs btn-error btn-square font-bold" on:click={() => removeProjectDescription(projIndex, descIndex)}>×</button>
                    </div>
                  {/each}
                  <button class="btn btn-xs btn-outline mt-2 font-bold" on:click={() => addProjectDescription(projIndex)}>+ Add Description</button>
                </div>
              </div>
            {/each}
          </div>
          {/if}

          <!-- Certifications (single-col only) -->
          {#if !isTwoColumnLayout && visibleSectionIds.has('certifications') && !isHidden('certifications')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('certifications', 'Certifications')}
                on:input={(e) => setSectionTitle('certifications', e.currentTarget.value)}
                placeholder="Certifications"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addCertification}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('certifications')} >Remove</button>
              </div>
            </div>
            {#if !resume.certifications || resume.certifications.length === 0}
              <div class="border border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50 transition-colors" on:click={addCertification}>
                <p class="text-sm text-black">Click to add certifications</p>
              </div>
            {:else}
              {#each resume.certifications as cert, certIndex}
                <div class="mb-2 flex items-center gap-2">
                  <span class="text-black">•</span>
                  <input type="text" class="flex-1 text-sm border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-2 rounded text-black" bind:value={cert.name} placeholder="Certification name" />
                  <span class="text-xs text-gray-500">|</span>
                  <input type="text" class="max-w-[150px] text-xs border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-2 rounded text-black" bind:value={cert.issuer} placeholder="Issuer" />
                  <span class="text-xs text-gray-500">|</span>
                  <input type="text" class="max-w-[80px] text-xs border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-2 rounded text-black" bind:value={cert.date} placeholder="Date" />
                  <button class="btn btn-xs btn-error font-bold" on:click={() => removeCertification(certIndex)}>×</button>
                </div>
              {/each}
            {/if}
          </div>
          {/if}

          <!-- Languages (single-col only) -->
          {#if !isTwoColumnLayout && visibleSectionIds.has('languages') && !isHidden('languages')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('languages', 'Languages')}
                on:input={(e) => setSectionTitle('languages', e.currentTarget.value)}
                placeholder="Languages"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addLanguage}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('languages')} >Remove</button>
              </div>
            </div>
            {#if !resume.languages || resume.languages.length === 0}
              <div class="border border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50 transition-colors" on:click={addLanguage}>
                <p class="text-sm text-black">Click to add languages</p>
              </div>
            {:else}
              <div class="space-y-2">
                {#each resume.languages as language, langIndex}
                  <div class="flex items-center gap-2">
                    <input type="text" class="flex-1 text-sm border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-2 rounded text-black" bind:value={language.name} placeholder="Language" />
                    <select class="select select-sm max-w-[150px]" bind:value={language.proficiency}>
                      <option value="Native">Native</option>
                      <option value="Fluent">Fluent</option>
                      <option value="Advanced">Advanced</option>
                      <option value="Intermediate">Intermediate</option>
                      <option value="Basic">Basic</option>
                    </select>
                    <button class="btn btn-xs btn-error font-bold" on:click={() => removeLanguage(langIndex)}>×</button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
          {/if}

        </div><!-- end MAIN column -->

        <!-- ===== SIDEBAR COLUMN (two-column layouts only — DOM-first so it stacks on top on narrow screens) ===== -->
        {#if isTwoColumnLayout}
        <div class="edit-sidebar">

          <!-- Contact in SIDEBAR (creative-multicolumn) -->
          {#if contactInSidebar && !isHidden('contact')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <span class="section-title-input" style={sectionHeaderStyle(template)}
                    style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                    style:font-weight={template?.style.headerFontWeight || 'bold'}>
                Contact
              </span>
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addContactExtra}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('contact')}>Remove</button>
              </div>
            </div>
            <div class="space-y-3"
                 style:font-family={resume && template ? getEffectiveFont(resume, template.style, 'contact') : 'Arial, sans-serif'}
                 style:font-size="{resume && template ? getEffectiveFontSize(resume, template.style, 'contact') : 10}pt"
                 style:color={template?.style.textColor || '#000000'}>

              <!-- Phone -->
              {#if shownContactFields.has('phone')}
              <div class="sidebar-contact-item">
                <div class="flex items-center justify-between">
                  <span class="sidebar-item-label">Phone</span>
                  <button class="contact-remove" on:click={() => removeContactField('phone')} title="Remove">×</button>
                </div>
                <input type="tel" class="contact-input w-full text-black"
                  style:color={template?.style.textColor || '#000000'}
                  bind:value={resume.personalInfo.phone}
                  placeholder="Phone number" />
              </div>
              {/if}

              <!-- Email -->
              {#if shownContactFields.has('email')}
              <div class="sidebar-contact-item">
                <div class="flex items-center justify-between">
                  <span class="sidebar-item-label">Email</span>
                  <button class="contact-remove" on:click={() => removeContactField('email')} title="Remove">×</button>
                </div>
                <input type="email" class="contact-input w-full text-black"
                  style:color={template?.style.textColor || '#000000'}
                  bind:value={resume.personalInfo.email}
                  placeholder="email@example.com" />
              </div>
              {/if}

              <!-- Address — optional -->
              {#if shownContactFields.has('address')}
              <div class="sidebar-contact-item">
                <div class="flex items-center justify-between">
                  <span class="sidebar-item-label">Address</span>
                  <button class="contact-remove" on:click={() => removeContactField('address')} title="Remove">×</button>
                </div>
                <input type="text" class="contact-input w-full text-black"
                  style:color={template?.style.textColor || '#000000'}
                  bind:value={resume.personalInfo.address}
                  placeholder="City, Country" />
              </div>
              {/if}

              <!-- LinkedIn — optional -->
              {#if shownContactFields.has('linkedin')}
              <div class="sidebar-contact-item">
                <div class="flex items-center justify-between">
                  <span class="sidebar-item-label">LinkedIn</span>
                  <button class="contact-remove" on:click={() => removeContactField('linkedin')} title="Remove">×</button>
                </div>
                <input type="text" class="contact-input w-full text-black"
                  style:color={template?.style.textColor || '#000000'}
                  bind:value={resume.personalInfo.linkedin}
                  placeholder="linkedin.com/in/username" />
              </div>
              {/if}

              <!-- GitHub — optional -->
              {#if shownContactFields.has('github')}
              <div class="sidebar-contact-item">
                <div class="flex items-center justify-between">
                  <span class="sidebar-item-label">GitHub</span>
                  <button class="contact-remove" on:click={() => removeContactField('github')} title="Remove">×</button>
                </div>
                <input type="text" class="contact-input w-full text-black"
                  style:color={template?.style.textColor || '#000000'}
                  bind:value={resume.personalInfo.github}
                  placeholder="github.com/username" />
              </div>
              {/if}

              <!-- Website — optional -->
              {#if shownContactFields.has('website')}
              <div class="sidebar-contact-item">
                <div class="flex items-center justify-between">
                  <span class="sidebar-item-label">Website</span>
                  <button class="contact-remove" on:click={() => removeContactField('website')} title="Remove">×</button>
                </div>
                <input type="url" class="contact-input w-full text-black"
                  style:color={template?.style.textColor || '#000000'}
                  bind:value={resume.personalInfo.website}
                  placeholder="yourwebsite.com" />
              </div>
              {/if}

              <!-- Custom extras -->
              {#each (resume.personalInfo.contactExtras || []) as extra (extra.id)}
              <div class="sidebar-contact-item">
                <div class="flex items-center justify-between">
                  <input type="text" class="sidebar-item-label-input text-black"
                    style:color={template?.style.textColor || '#000000'}
                    bind:value={extra.label} placeholder="Label" />
                  <button class="contact-remove" on:click={() => removeContactExtra(extra.id)} title="Remove">×</button>
                </div>
                <input type="text" class="contact-input w-full text-black"
                  style:color={template?.style.textColor || '#000000'}
                  bind:value={extra.value} placeholder="Value" />
              </div>
              {/each}

              <!-- Add optional fields -->
              <div class="flex flex-wrap items-center gap-2 mt-1">
                {#if !shownContactFields.has('phone')}<button class="contact-add-btn" on:click={() => addContactField('phone')}>+ Phone</button>{/if}
                {#if !shownContactFields.has('email')}<button class="contact-add-btn" on:click={() => addContactField('email')}>+ Email</button>{/if}
                {#if !shownContactFields.has('address')}<button class="contact-add-btn" on:click={() => addContactField('address')}>+ Address</button>{/if}
                {#if !shownContactFields.has('linkedin')}<button class="contact-add-btn" on:click={() => addContactField('linkedin')}>+ LinkedIn</button>{/if}
              </div>
            </div>
          </div>
          {/if}

          <!-- Skills in SIDEBAR -->
          {#if sidebarSections.includes('skills') && visibleSectionIds.has('skills') && !isHidden('skills')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('skills', 'Skills')}
                on:input={(e) => setSectionTitle('skills', e.currentTarget.value)}
                placeholder="Skills"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addSkill}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('skills')} >Remove</button>
              </div>
            </div>
            {#if resume.skills.length === 0}
              <div class="border border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50 transition-colors" on:click={addSkill}>
                <p class="text-sm text-black">Click to add your skills</p>
              </div>
            {:else}
              <div class="space-y-3">
                {#each resume.skills as skill, skillIndex}
                  <div class="sidebar-contact-item">
                    <div class="flex items-center justify-between">
                      <input type="text" class="sidebar-item-label-input text-black" bind:value={skill.category} placeholder="Category" />
                      <button class="btn btn-xs btn-error font-bold" on:click={() => removeSkill(skillIndex)}>×</button>
                    </div>
                    <input type="text" class="contact-input w-full text-black" bind:value={skill.name} placeholder="Skill name" />
                  </div>
                {/each}
              </div>
            {/if}
          </div>
          {/if}

          <!-- Certifications in SIDEBAR -->
          {#if sidebarSections.includes('certifications') && visibleSectionIds.has('certifications') && !isHidden('certifications')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('certifications', 'Certifications')}
                on:input={(e) => setSectionTitle('certifications', e.currentTarget.value)}
                placeholder="Certifications"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addCertification}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('certifications')} >Remove</button>
              </div>
            </div>
            {#if !resume.certifications || resume.certifications.length === 0}
              <div class="border border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50 transition-colors" on:click={addCertification}>
                <p class="text-sm text-black">Click to add certifications</p>
              </div>
            {:else}
              {#each resume.certifications as cert, certIndex}
                <div class="mb-2 flex items-center gap-2">
                  <span class="text-black">•</span>
                  <input type="text" class="flex-1 text-sm border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-2 rounded text-black" bind:value={cert.name} placeholder="Certification name" />
                  <button class="btn btn-xs btn-error font-bold" on:click={() => removeCertification(certIndex)}>×</button>
                </div>
              {/each}
            {/if}
          </div>
          {/if}

          <!-- Languages in SIDEBAR -->
          {#if sidebarSections.includes('languages') && visibleSectionIds.has('languages') && !isHidden('languages')}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <input
                class="section-title-input"
                style={sectionHeaderStyle(template)}
                style:font-family={template?.style.headerFont || 'Arial, sans-serif'}
                style:font-weight={template?.style.headerFontWeight || 'bold'}
                value={getSectionTitle('languages', 'Languages')}
                on:input={(e) => setSectionTitle('languages', e.currentTarget.value)}
                placeholder="Languages"
              />
              <div class="flex items-center gap-1">
                <button class="btn btn-xs btn-primary font-bold" on:click={addLanguage}>+ Add</button>
                <button class="section-remove-btn" on:click={() => hideSection('languages')} >Remove</button>
              </div>
            </div>
            {#if !resume.languages || resume.languages.length === 0}
              <div class="border border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50 transition-colors" on:click={addLanguage}>
                <p class="text-sm text-black">Click to add languages</p>
              </div>
            {:else}
              <div class="space-y-2">
                {#each resume.languages as language, langIndex}
                  <div class="flex items-center gap-2">
                    <input type="text" class="flex-1 text-sm border-none outline-none bg-transparent cursor-text hover:bg-gray-50 p-2 rounded text-black" bind:value={language.name} placeholder="Language" />
                    <select class="select select-sm max-w-[130px]" bind:value={language.proficiency}>
                      <option value="Native">Native</option>
                      <option value="Fluent">Fluent</option>
                      <option value="Advanced">Advanced</option>
                      <option value="Intermediate">Intermediate</option>
                      <option value="Basic">Basic</option>
                    </select>
                    <button class="btn btn-xs btn-error font-bold" on:click={() => removeLanguage(langIndex)}>×</button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
          {/if}

        </div><!-- end SIDEBAR column -->
        {/if}

      </div><!-- end columns wrapper -->

      <!-- Restore hidden sections -->
      {#if resume.hiddenSections && resume.hiddenSections.length > 0}
        <div class="restore-bar mt-6">
          <span class="restore-label">Hidden:</span>
          {#each resume.hiddenSections as sectionId}
            <button class="restore-chip" on:click={() => restoreSection(sectionId)}>
              {getSectionTitle(sectionId, sectionId)} ↩
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  {:else}
    <div class="text-center py-20">
      <span class="loading loading-spinner loading-lg"></span>
      <p class="mt-4">Loading resume...</p>
    </div>
  {/if}
</div>

<style>
  /* ── Section title input — looks like the h3 heading ───────────────────── */
  .section-title-input {
    background: transparent;
    border: none;
    outline: none;
    border-bottom: 1px solid transparent;
    padding: 1px 2px;
    font-size: 1.125rem; /* text-lg */
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.05em; /* tracking-wide */
    transition: border-color 0.15s;
    min-width: 80px;
    width: auto;
  }
  .section-title-input:hover,
  .section-title-input:focus {
    border-bottom-color: #9ca3af;
  }

  /* Red "Remove" button next to section title — same size as btn-xs */
  .section-remove-btn {
    opacity: 0;
    background: #dc2626;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 600;
    height: 1.5rem;
    padding: 0 8px;
    transition: opacity 0.15s, background 0.15s;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
  }
  :global(.flex:hover .section-remove-btn) {
    opacity: 1;
  }
  .section-remove-btn:hover {
    background: #b91c1c;
  }

  /* Restore bar for hidden sections */
  .restore-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: #fef9c3;
    border: 1px dashed #fbbf24;
    border-radius: 6px;
  }
  .restore-label {
    font-size: 0.75rem;
    color: #92400e;
    font-weight: 500;
  }
  .restore-chip {
    background: white;
    border: 1px solid #fbbf24;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.75rem;
    color: #92400e;
    cursor: pointer;
    transition: background 0.1s;
  }
  .restore-chip:hover {
    background: #fef3c7;
  }

  :global(.na-value), :global(.na-value *) {
    color: #9ca3af !important;
    font-style: italic;
  }

  /* ── Contact row ─────────────────────────────────────────────────────────── */
  .contact-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 4px;
    padding: 4px 8px;
    border-radius: 4px;
  }

  /* Individual contact inputs look like plain text until focused */
  .contact-input {
    border: none;
    outline: none;
    background: transparent;
    border-bottom: 1px solid transparent;
    padding: 1px 2px;
    min-width: 0;
    transition: border-color 0.15s;
  }
  .contact-input:hover,
  .contact-input:focus {
    border-bottom-color: #9ca3af;
  }

  .contact-sep {
    user-select: none;
    padding: 0 2px;
    opacity: 0.6;
  }

  /* Wrapper for an optional field + its remove button */
  .contact-optional-field {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .contact-remove {
    opacity: 0.25;
    background: none;
    border: none;
    cursor: pointer;
    color: #ef4444;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    transition: opacity 0.15s;
  }
  .contact-optional-field:hover .contact-remove {
    opacity: 1;
  }

  /* Sidebar contact items — stacked: label on top, value below */
  .sidebar-contact-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
  }
  .sidebar-item-label {
    font-weight: 700;
    font-size: 0.78em;
    letter-spacing: 0.3px;
    line-height: 1.2;
  }
  .sidebar-contact-item .contact-input {
    max-width: none !important;
    width: 100% !important;
    padding: 1px 2px;
  }
  /* Editable label input for custom extras — styled like the bold label */
  .sidebar-item-label-input {
    font-weight: 700;
    font-size: 0.78em;
    letter-spacing: 0.3px;
    border: none;
    outline: none;
    background: transparent;
    padding: 0;
    min-width: 0;
    flex: 1;
    cursor: text;
  }
  .sidebar-item-label-input:hover {
    background: #f9fafb;
    border-radius: 2px;
  }

  /* Label chip before each contact field */
  .contact-label {
    font-size: 1em;
    opacity: 0.55;
    user-select: none;
    margin-right: 1px;
    white-space: nowrap;
  }

  /* "+" button wrapper */
  .contact-add-wrapper {
    display: inline-flex;
    align-items: center;
    margin-left: 6px;
  }

  .contact-add-btn {
    background: none;
    border: 1px dashed #9ca3af;
    border-radius: 50%;
    color: #6b7280;
    font-size: 1rem;
    line-height: 1;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
    padding: 0;
  }
  .contact-add-btn:hover {
    border-color: #6b7280;
    color: #374151;
  }


  /* ── All buttons: light blue bg, no bottom shadow ─────────────────────── */
  .edit-page :global(.btn) {
    background-color: #bfdbfe !important;
    border-color: #93c5fd !important;
    color: #1e3a8a !important;
    box-shadow: none !important;
    padding: 0.4rem 1rem !important;
  }

  /* Save button — green */
  .edit-page :global(.btn.btn-success) {
    background-color: #16a34a !important;
    border-color: #15803d !important;
    color: #ffffff !important;
  }

  /* Remove / delete buttons — red */
  .edit-page :global(.btn.btn-error) {
    background-color: #dc2626 !important;
    border-color: #b91c1c !important;
    color: #ffffff !important;
  }

  .edit-page :global(.btn:disabled),
  .edit-page :global(.btn[disabled]) {
    background-color: #dbeafe !important;
    border-color: #bfdbfe !important;
    color: #93c5fd !important;
  }

  @media print {
    .btn, button { display: none !important; }
  }

  /* Two-column edit layout — column widths set via inline style */
  .edit-two-column {
    display: grid;
    gap: 24px;
    align-items: flex-start;
  }

  /* Sidebar occupies the left column (column 1), main occupies right (column 2) */
  .edit-sidebar {
    grid-column: 1;
    grid-row: 1;
    border-right: 1px solid #e5e7eb;
    padding-right: 16px;
  }

  .edit-main {
    grid-column: 2;
    grid-row: 1;
  }

  @media (max-width: 1024px) {
    .edit-two-column {
      grid-template-columns: 1fr !important;
    }
    .edit-sidebar,
    .edit-main {
      grid-column: 1;
      grid-row: auto;
    }
    /* Sidebar stacks on top of main on narrow screens, with bottom border instead of right */
    .edit-sidebar {
      order: -1;
      border-right: none;
      padding-right: 0;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 16px;
    }
  }

</style>
