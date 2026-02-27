<script>
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';

	const TABS = ['Q&A', 'Cover Letter', 'Resume'];

	/** @type {Array<{jobId: string, title: string, company: string, platform: string, basePath: string}>} */
	let jobs = [];
	let selectedJobIdx = '';
	/** @type {{jobId: string, title: string, company: string, platform: string, basePath: string} | null} */
	let selectedJob = null;
	/** @type {any} */
	let jobDetails = null;
	/** @type {any[]} */
	let savedQuestions = [];

	let activeTab = 'Q&A';
	let jobsError = '';

	/** @type {string | null} */
	let coverLetterResult = null;
	/** @type {string | null} */
	let resumeResult = null;
	/** @type {any[] | null} */
	let qnaResult = null;
	/** @type {{total: number, success: number, failed: number} | null} */
	let qnaSummary = null;

	let loading = { coverLetter: false, resume: false, qna: false };
	let error = { coverLetter: '', resume: '', qna: '' };

	onMount(async () => {
		await loadJobs();
	});

	async function loadJobs() {
		jobsError = '';
		try {
			const res = await fetch('/api-test/jobs');
			if (res.ok) {
				jobs = await res.json();
				if (jobs.length > 0) {
					selectedJobIdx = '0';
					await selectJob(0);
				}
			} else {
				jobsError = `Failed to load jobs (HTTP ${res.status})`;
			}
		} catch (e) {
			jobsError = `Failed to load jobs: ${e.message}`;
		}
	}

	/** @param {number} idx */
	async function selectJob(idx) {
		if (idx < 0 || idx >= jobs.length) return;
		selectedJob = jobs[idx];
		jobDetails = null;
		savedQuestions = [];
		coverLetterResult = null;
		resumeResult = null;
		qnaResult = null;
		qnaSummary = null;
		error = { coverLetter: '', resume: '', qna: '' };
		loading = { coverLetter: false, resume: false, qna: false };

		try {
			const raw = await invoke('read_file_async', { filename: `${selectedJob.basePath}/job_details.json` });
			jobDetails = JSON.parse(/** @type {string} */ (raw));
		} catch {
			// job_details.json not readable — job still usable with basic info
		}

		try {
			const qnaRaw = await invoke('read_file_async', { filename: `${selectedJob.basePath}/qna.json` });
			const qnaData = JSON.parse(/** @type {string} */ (qnaRaw));
			savedQuestions = Array.isArray(qnaData?.questions) ? qnaData.questions : [];
		} catch {
			savedQuestions = [];
		}

		// Always land on Q&A and auto-generate for the new job
		activeTab = 'Q&A';
		generateForTab('Q&A');
	}

	async function handleJobChange(e) {
		const idx = parseInt(e.target.value, 10);
		selectedJobIdx = String(idx);
		await selectJob(idx);
	}

	/** Switch tab and auto-generate if no result yet for that tab. */
	function switchTab(tab) {
		activeTab = tab;
		generateForTab(tab);
	}

	/** Trigger generation for a tab only if there's no result and it's not already loading. */
	function generateForTab(tab) {
		if (tab === 'Q&A' && !qnaResult && !loading.qna) generateQna();
		else if (tab === 'Cover Letter' && !coverLetterResult && !loading.coverLetter) generateCoverLetter();
		else if (tab === 'Resume' && !resumeResult && !loading.resume) generateResume();
	}

	async function generateCoverLetter() {
		if (!selectedJob) return;
		loading.coverLetter = true;
		error.coverLetter = '';
		coverLetterResult = null;

		try {
			const res = await fetch('/api-test/proxy/cover-letter', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					job_id: selectedJob.jobId,
					job_details: jobDetails?.details || jobDetails?.description || `${selectedJob.title} at ${selectedJob.company}`,
					job_title: selectedJob.title,
					company: selectedJob.company
				})
			});
			const data = await res.json();
			if (!res.ok || data.error) {
				error.coverLetter = data.error || `HTTP ${res.status}`;
			} else {
				coverLetterResult = data.cover_letter;
			}
		} catch (e) {
			error.coverLetter = e.message;
		} finally {
			loading.coverLetter = false;
		}
	}

	async function generateResume() {
		if (!selectedJob) return;
		loading.resume = true;
		error.resume = '';
		resumeResult = null;

		try {
			const res = await fetch('/api-test/proxy/resume', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					job_id: selectedJob.jobId,
					job_details: jobDetails?.details || jobDetails?.description || `${selectedJob.title} at ${selectedJob.company}`,
					job_title: selectedJob.title,
					company: selectedJob.company
				})
			});
			const data = await res.json();
			if (!res.ok || data.error) {
				error.resume = data.error || `HTTP ${res.status}`;
			} else {
				resumeResult = data.resume;
			}
		} catch (e) {
			error.resume = e.message;
		} finally {
			loading.resume = false;
		}
	}

	async function generateQna() {
		if (!selectedJob || savedQuestions.length === 0) return;
		loading.qna = true;
		error.qna = '';
		qnaResult = null;
		qnaSummary = null;

		try {
			const res = await fetch('/api-test/proxy/qna', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					job_id: selectedJob.jobId,
					job_details: jobDetails?.details || jobDetails?.description || `${selectedJob.title} at ${selectedJob.company}`,
					job_title: selectedJob.title,
					company: selectedJob.company,
					questions: savedQuestions
				})
			});
			const data = await res.json();
			if (!res.ok || data.error) {
				error.qna = data.error || `HTTP ${res.status}`;
			} else {
				qnaResult = data.questions;
				qnaSummary = data.summary;
			}
		} catch (e) {
			error.qna = e.message;
		} finally {
			loading.qna = false;
		}
	}

	$: fillPct = qnaSummary?.total > 0 ? Math.round((qnaSummary.success / qnaSummary.total) * 100) : null;
</script>

<div class="p-6 max-w-4xl mx-auto">
	<div class="mb-6">
		<h1 class="text-2xl font-bold">Lab</h1>
		<p class="text-base-content/60 text-sm mt-1">Test AI generation quality using saved jobs — without running a live bot session.</p>
	</div>

	<!-- Job selection -->
	<div class="card bg-base-100 shadow mb-6">
		<div class="card-body py-4">
			{#if jobsError}
				<div class="alert alert-error text-sm py-2">
					<span>{jobsError}</span>
					<button type="button" class="btn btn-ghost btn-xs" on:click={loadJobs}>Retry</button>
				</div>
			{:else if jobs.length === 0}
				<p class="text-base-content/50 text-sm">No saved jobs found. Run a bot session first to populate jobs.</p>
			{:else}
				<div class="flex flex-wrap items-end gap-3">
					<div class="flex-1 min-w-48">
						<label class="label py-1" for="job-select">
							<span class="label-text text-sm font-medium">Select job</span>
						</label>
						<select
							id="job-select"
							class="select select-bordered w-full"
							bind:value={selectedJobIdx}
							on:change={handleJobChange}
						>
							{#each jobs as job, idx}
								<option value={String(idx)}>{job.company} — {job.title} ({job.platform})</option>
							{/each}
						</select>
					</div>
				</div>

				{#if selectedJob}
					<div class="mt-3 flex flex-wrap gap-2 items-center text-sm text-base-content/70">
						<span class="badge badge-outline badge-sm">{selectedJob.platform}</span>
						<span class="font-medium">{selectedJob.company}</span>
						<span>·</span>
						<span>{selectedJob.title}</span>
						{#if jobDetails?.location}<span>· {jobDetails.location}</span>{/if}
						{#if jobDetails?.work_type}<span>· {jobDetails.work_type}</span>{/if}
						{#if savedQuestions.length > 0}
							<span class="badge badge-info badge-sm ml-1">{savedQuestions.length} Q&A questions</span>
						{/if}
					</div>
				{/if}
			{/if}
		</div>
	</div>

	{#if selectedJob}
		<!-- Tabs -->
		<div class="flex flex-wrap gap-2 mb-6">
			{#each TABS as tab}
				<button
					type="button"
					class="btn btn-sm font-bold px-6 py-2 {activeTab === tab ? 'btn-primary' : 'border border-base-300'}"
					style={activeTab !== tab ? 'background-color: #bfdbfe; color: #1e3a5f;' : ''}
					on:click={() => switchTab(tab)}
				>
					{tab}
					{#if (tab === 'Q&A' && loading.qna) || (tab === 'Cover Letter' && loading.coverLetter) || (tab === 'Resume' && loading.resume)}
						<span class="loading loading-spinner loading-xs ml-1"></span>
					{/if}
				</button>
			{/each}
		</div>

		<!-- Tab content -->
		<div class="min-h-[200px]">

			{#if activeTab === 'Cover Letter'}
				<div class="card bg-base-100 shadow">
					<div class="card-body">
						<h2 class="card-title text-base mb-4">Cover Letter</h2>

						{#if loading.coverLetter}
							<div class="flex items-center gap-3 py-8 justify-center text-base-content/50">
								<span class="loading loading-spinner loading-md"></span>
								<span class="text-sm">Generating cover letter…</span>
							</div>
						{:else if error.coverLetter}
							<div class="alert alert-error text-sm py-2">
								<span>{error.coverLetter}</span>
							</div>
						{:else if coverLetterResult}
							<div class="prose prose-sm max-w-none whitespace-pre-wrap">{coverLetterResult}</div>
						{/if}
					</div>
				</div>

			{:else if activeTab === 'Resume'}
				<div class="card bg-base-100 shadow">
					<div class="card-body">
						<div class="flex items-center gap-3 mb-4">
							<h2 class="card-title text-base">Resume</h2>
							{#if resumeResult}
								<span class="badge badge-accent badge-sm">AI Enhanced</span>
							{/if}
						</div>

						{#if loading.resume}
							<div class="flex items-center gap-3 py-8 justify-center text-base-content/50">
								<span class="loading loading-spinner loading-md"></span>
								<span class="text-sm">Generating resume…</span>
							</div>
						{:else if error.resume}
							<div class="alert alert-error text-sm py-2">
								<span>{error.resume}</span>
							</div>
						{:else if resumeResult}
							<div class="prose prose-sm max-w-none whitespace-pre-wrap">{resumeResult}</div>
						{/if}
					</div>
				</div>

			{:else if activeTab === 'Q&A'}
				<div class="card bg-base-100 shadow">
					<div class="card-body">
						<div class="flex items-center gap-3 mb-4">
							<h2 class="card-title text-base">Q&A Answers</h2>
							{#if qnaSummary}
								<span class="badge {fillPct === 100 ? 'badge-success' : fillPct >= 50 ? 'badge-warning' : 'badge-error'}">
									{qnaSummary.success}/{qnaSummary.total} filled
								</span>
							{/if}
						</div>

						{#if savedQuestions.length === 0}
							<div class="alert alert-warning text-sm py-2">
								<span>No saved Q&A questions for this job. The job needs a previous bot run with Q&A data to use this feature.</span>
							</div>
						{:else if loading.qna}
							<div class="flex items-center gap-3 py-8 justify-center text-base-content/50">
								<span class="loading loading-spinner loading-md"></span>
								<span class="text-sm">Generating answers…</span>
							</div>
						{:else if error.qna}
							<div class="alert alert-error text-sm py-2">
								<span>{error.qna}</span>
							</div>
						{:else if qnaResult && qnaResult.length > 0}
							<ul class="space-y-4">
								{#each qnaResult as qa}
									<li class="border-l-2 border-base-300 pl-4">
										<p class="font-medium text-sm mb-1">{qa.question}</p>
										{#if qa.status}
											{@const badgeClass = qa.status === 'success' ? 'badge-success' : qa.status === 'failed' ? 'badge-error' : 'badge-warning'}
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
											{#if qa.answer}{qa.answer}{:else}—{/if}
										</p>
										{#if qa.answerSource}
											<p class="text-xs text-base-content/50">Source: {qa.answerSource}</p>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
