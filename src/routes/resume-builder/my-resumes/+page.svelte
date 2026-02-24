<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resumesStore, loadResumes, setBase, autoSave } from '$lib/resume/store';
  import { downloadDocx } from '$lib/resume/generator';
  import type { ResumeData } from '$lib/resume/types';
  
  // Load saved resumes on mount
  onMount(() => {
    loadResumes();
  });
  
  let downloadingId: string | null = null;
  
  async function handleDownload(resume: ResumeData) {
    downloadingId = resume.id;
    try {
      await downloadDocx(resume, resume.title);
    } catch (error) {
      console.error('Download error:', error);
      alert('Failed to download resume. Please try again.');
    } finally {
      downloadingId = null;
    }
  }
  
  function handleEdit(resumeId: string) {
    goto(`/resume-builder/edit/${resumeId}`);
  }
  
  function handleDuplicate(resumeId: string) {
    const duplicated = resumesStore.duplicate(resumeId);
    if (duplicated) {
      goto(`/resume-builder/edit/${duplicated.id}`);
    }
  }
  
  async function handleDelete(resumeId: string) {
    if (confirm('Are you sure you want to delete this resume? This action cannot be undone.')) {
      resumesStore.delete(resumeId);
      autoSave();
    }
  }

  function handleSetBase(id: string) {
    resumesStore.setBase(id);
    autoSave();
  }
</script>

<div class="container mx-auto p-8">
  <!-- Header -->
  <div class="mb-8 flex items-center justify-between">
    <div>
      <h1 class="text-4xl font-bold text-primary">My Resumes</h1>
      <p class="text-lg text-base-content/70 mt-2">Manage your saved resumes</p>
    </div>
    <button class="btn btn-primary" on:click={() => goto('/resume-builder')}>
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
      Create New Resume
    </button>
  </div>

  <!-- Resumes List -->
  {#if $resumesStore.length === 0}
    <div class="text-center py-20">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-24 w-24 mx-auto text-base-content/30 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <h2 class="text-2xl font-bold mb-2">No Resumes Yet</h2>
      <p class="text-base-content/70 mb-6">Create your first professional resume to get started!</p>
      <button class="btn btn-primary" on:click={() => goto('/resume-builder')}>
        Create Resume
      </button>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each $resumesStore as resume}
        <div class="card bg-base-100 shadow-xl hover:shadow-2xl transition-all duration-300">
          <!-- Card Header -->
          <div class="card-body">
            <div class="flex items-start justify-between mb-4">
              <div class="flex-1">
                <h2 class="card-title text-xl mb-2">{resume.title}</h2>
                {#if resume.isBase}
                  <div class="badge badge-warning font-semibold gap-1 mb-1">★ Base Resume</div>
                {/if}
                <div class="badge badge-outline">{resume.personalInfo.title || 'No title'}</div>
              </div>
              <div class="dropdown dropdown-end">
                <label tabindex="0" class="btn btn-ghost btn-sm btn-circle">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                  </svg>
                </label>
                <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box z-[1] w-52 p-2 shadow-lg border border-base-300">
                  <li>
                    <button on:click={() => handleEdit(resume.id)}>
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      Edit
                    </button>
                  </li>
                  <li>
                    <button on:click={() => handleDuplicate(resume.id)}>
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Duplicate
                    </button>
                  </li>
                  <li>
                    <button on:click={() => handleSetBase(resume.id)} class:text-warning={!resume.isBase}>
                      ★ {resume.isBase ? 'Current Base' : 'Set as Base'}
                    </button>
                  </li>
                  <li>
                    <button class="text-error" on:click={() => handleDelete(resume.id)}>
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Delete
                    </button>
                  </li>
                </ul>
              </div>
            </div>

            <!-- Resume Info -->
            <div class="space-y-2 mb-4">
              <div class="flex items-center gap-2 text-sm text-base-content/70">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                {resume.experience.length} Experience{resume.experience.length !== 1 ? 's' : ''}
              </div>
              
              <div class="flex items-center gap-2 text-sm text-base-content/70">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 14l9-5-9-5-9 5 9 5z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z" />
                </svg>
                {resume.education.length} Education
              </div>
              
              <div class="flex items-center gap-2 text-sm text-base-content/70">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                {resume.skills.length} Skills
              </div>
              
              <div class="flex items-center gap-2 text-sm text-base-content/70">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Updated {new Date(resume.updatedAt).toLocaleDateString()}
              </div>
            </div>

            <!-- Actions -->
            <div class="card-actions">
              <button class="btn btn-primary btn-sm flex-1" on:click={() => handleEdit(resume.id)}>
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit
              </button>
              <button 
                class="btn btn-success btn-sm flex-1"
                disabled={downloadingId === resume.id}
                on:click={() => handleDownload(resume)}
              >
                {#if downloadingId === resume.id}
                  <span class="loading loading-spinner loading-sm"></span>
                {:else}
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                {/if}
                Download
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

