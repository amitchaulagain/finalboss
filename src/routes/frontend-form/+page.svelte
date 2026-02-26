<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from "@tauri-apps/api/core"
  import { env } from '$env/dynamic/public';
  import { API_URLS } from '$lib/api-config.js';
  import { getManagedFiles, registerManagedFile, registerManagedBinaryFile, previewManagedFile } from '$lib/file-manager';
  import { parseResumeText, type ParsedResume } from '$lib/resume/parser';

  let formData = {
    fullName: '',
    address: '',
    email: '',
    phone: '',
    linkedinUrl: '',
    keywords: '',
    minSalary: '',
    maxSalary: '',
    jobType: 'any',
    experienceLevel: 'any',
    industry: '',
    listedDate: '',
    remotePreference: 'any',
    rewriteResume: false,
    excludedCompanies: '',
    excludedKeywords: '',
    acceptTerms: false,
    resumeFileName: ''
  };

  // Resume state
  let isSubmitting = false;
  let resumeFile: { name: string } | null = null;
  let resumeUploaded = false;
  let availableResumeFiles: string[] = [];
  let uploadValidationMessage = '';
  let extractedResumeText = '';
  let parsedResumeData: ParsedResume | null = null;

  // Q&A state
  let questionsData: any = null;
  let editingQuestions: Record<string | number, { keywords: string; answers: string }> = {};
  let questionsLoading = true;
  let questionsSaving = false;

  // Config path (resolved from Tauri on mount)
  let appConfigPath = '';

  const CORPUS_RAG_API = env?.PUBLIC_API_BASE || import.meta.env.VITE_API_BASE || 'http://localhost:3000';
  const ALLOWED_RESUME_EXTENSIONS = ['.doc', '.docx', '.pdf'];

  function isSupportedResumeFile(name: string): boolean {
    const lower = String(name || '').toLowerCase();
    return ALLOWED_RESUME_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  onMount(async () => {
    await loadConfig();
    await loadQuestions();
  });

  const industries = [
    { value: '', label: 'Select an industry' },
    { value: '1_accounting', label: 'Accounting' },
    { value: '2_administration', label: 'Administration & Office Support' },
    { value: '3_advertising', label: 'Advertising, Arts & Media' },
    { value: '4_banking', label: 'Banking & Financial Services' },
    { value: '5_call', label: 'Call Centre & Customer Service' },
    { value: '6_ceo', label: 'CEO & General Management' },
    { value: '7_community', label: 'Community Services & Development' },
    { value: '8_construction', label: 'Construction' },
    { value: '9_consulting', label: 'Consulting & Strategy' },
    { value: '10_design', label: 'Design & Architecture' },
    { value: '11_education', label: 'Education & Training' },
    { value: '12_engineering', label: 'Engineering' },
    { value: '13_farming', label: 'Farming, Animals & Conservation' },
    { value: '14_government', label: 'Government & Defence' },
    { value: '15_healthcare', label: 'Healthcare & Medical' },
    { value: '16_hospitality', label: 'Hospitality & Tourism' },
    { value: '17_human', label: 'Human Resources & Recruitment' },
    { value: '18_information', label: 'Information & Communication Technology' },
    { value: '19_insurance', label: 'Insurance & Superannuation' },
    { value: '20_legal', label: 'Legal' },
    { value: '21_manufacturing', label: 'Manufacturing, Transport & Logistics' },
    { value: '22_marketing', label: 'Marketing & Communications' },
    { value: '23_mining', label: 'Mining, Resources & Energy' },
    { value: '24_real', label: 'Real Estate & Property' },
    { value: '25_retail', label: 'Retail & Consumer Products' },
    { value: '26_sales', label: 'Sales' },
    { value: '27_science', label: 'Science & Technology' },
    { value: '28_self_employment', label: 'Self Employment' },
    { value: '29_sport', label: 'Sport & Recreation' },
    { value: '30_trades', label: 'Trades & Services' }
  ];



  async function loadUploadedResumes() {
    const userEmail = (formData.email || '').trim();
    if (!userEmail) {
      availableResumeFiles = [];
      return;
    }
    try {
      const entries = await getManagedFiles({ userId: userEmail, feature: 'resume' });
      const fileNames = entries
        .map((entry) => entry.filename)
        .filter((name): name is string => typeof name === 'string' && isSupportedResumeFile(name));
      availableResumeFiles = fileNames;
    } catch (error) {
      console.error('Failed to list canonical resumes:', error);
      availableResumeFiles = [];
    }
  }

  async function handleResumeSelection() {
    if (formData.resumeFileName) {
      resumeFile = { name: formData.resumeFileName };
      resumeUploaded = true;
      // Load the extracted text from the stored .txt file if not already available
      if (!extractedResumeText) {
        await loadExtractedTextForResume(formData.resumeFileName);
      }
    }
  }

  /**
   * Reads the stored `.txt` companion file for a given resume binary,
   * then parses it into structured data.
   * Falls back to re-extracting from the binary if no .txt companion exists.
   */
  async function loadExtractedTextForResume(resumeFileName: string) {
    const userEmail = (formData.email || '').trim();
    if (!userEmail) return;
    try {
      const entries = await getManagedFiles({ userId: userEmail, feature: 'resume' });

      // First try: find the stored .txt companion
      const textFileName = resumeFileName.replace(/\.(pdf|docx?|doc)$/i, '.txt');
      const textEntry = entries.find((e) => e.filename === textFileName);
      if (textEntry) {
        const text = await previewManagedFile(userEmail, textEntry.id, 200_000);
        if (text && !text.startsWith('[Binary file:')) {
          extractedResumeText = text;
          try {
            parsedResumeData = parseResumeText(text);
            console.log('Parsed resume from stored text file:', parsedResumeData?.personalInfo?.fullName);
          } catch (parseErr) {
            console.error('Resume parsing failed (text loaded but not parsed):', parseErr);
            parsedResumeData = null;
          }
          return;
        }
      }

      // Fallback: re-extract from the binary file via the extract-document API
      const binaryEntry = entries.find((e) => e.filename === resumeFileName);
      if (!binaryEntry) {
        console.warn(`No managed entry found for ${resumeFileName}`);
        return;
      }
      console.log('No .txt companion found — re-extracting from binary:', resumeFileName);
      const fullPath = await invoke<string>('get_managed_file_path', { input: { userId: userEmail, fileId: binaryEntry.id } });
      const binaryContent = await invoke<string>('read_file_async', { filename: fullPath });
      // read_file_async returns raw text; for true binary re-extraction we POST to the API
      // Read binary as base64 via Tauri, then decode to Blob
      if (!binaryContent) {
        console.warn('Binary file was empty or unreadable');
        return;
      }
      // The binary may be unreadable as UTF-8 text via read_file_async; use previewManagedFile as a last resort
      const preview = await previewManagedFile(userEmail, binaryEntry.id, 500);
      if (preview && preview.startsWith('[Binary file:')) {
        // The file is a real binary — re-upload it through extract-document using fetch + blob
        await reExtractBinaryResume(fullPath, resumeFileName, userEmail);
      }
    } catch (err) {
      console.error('Could not load stored resume text:', err);
    }
  }

  /**
   * Re-extracts text from a binary resume on disk by reading it as base64
   * and POSTing to /api/extract-document.
   */
  async function reExtractBinaryResume(filePath: string, fileName: string, userEmail: string) {
    try {
      // Read the file as base64 using Tauri
      const base64 = await invoke<string>('read_file_base64', { filename: filePath });
      if (!base64) return;

      // Decode base64 to Uint8Array
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      const mimeType = fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf'
        : fileName.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/msword';

      const extractFormData = new FormData();
      extractFormData.append('file', new Blob([bytes], { type: mimeType }), fileName);
      const extractRes = await fetch(`${CORPUS_RAG_API}/api/extract-document`, {
        method: 'POST',
        body: extractFormData
      });
      const extractData = await extractRes.json().catch(() => ({}));
      if (!extractRes.ok || extractData?.success !== true) {
        console.warn('Re-extraction failed:', extractData?.error);
        return;
      }
      const text = typeof extractData?.content === 'string' ? extractData.content : '';
      if (!text.trim()) return;

      extractedResumeText = text;
      try {
        parsedResumeData = parseResumeText(text);
        console.log('Re-extracted + parsed resume:', parsedResumeData?.personalInfo?.fullName);
      } catch { parsedResumeData = null; }

      // Save the .txt companion for next time
      const textFileName = fileName.replace(/\.(pdf|docx?|doc)$/i, '.txt');
      try {
        await registerManagedFile({
          userId: userEmail,
          feature: 'resume',
          filename: textFileName,
          content: text,
          sourceRoute: '/frontend-form',
          mimeType: 'text/plain',
          tags: ['extracted-text', 'canonical']
        });
      } catch (saveErr) {
        console.warn('Could not save .txt companion:', saveErr);
      }
    } catch (err) {
      console.error('reExtractBinaryResume failed:', err);
    }
  }

  async function handleResumeUpload(event: Event) {
    const target = event.target as HTMLInputElement | null;
    const file = target?.files?.[0];
    if (file) {
      if (!isSupportedResumeFile(file.name)) {
        alert('Only .doc, .docx, and .pdf resume files are supported.');
        if (target) target.value = '';
        return;
      }
      const userEmail = (formData.email || '').trim();
      if (!userEmail) {
        alert('Please add your Email in Basic Information before uploading resume.');
        if (target) target.value = '';
        return;
      }
      try {
        const fileName = String(file.name || 'resume.docx');
        uploadValidationMessage = 'Uploading and processing resume...';

        // Step 1: Extract text content
        const extractFormData = new FormData();
        extractFormData.append('file', file, fileName);
        const extractRes = await fetch(`${CORPUS_RAG_API}/api/extract-document`, {
          method: 'POST',
          body: extractFormData
        });
        const extractData = await extractRes.json().catch(() => ({}));
        if (!extractRes.ok || extractData?.success !== true) {
          throw new Error(extractData?.error || `Document extraction failed (${extractRes.status})`);
        }
        const extractedContent = typeof extractData?.content === 'string' ? extractData.content : '';
        if (!extractedContent.trim()) throw new Error('Extracted resume text is empty');

        // Store the extracted text and parse it into structured fields
        extractedResumeText = extractedContent;
        try {
          parsedResumeData = parseResumeText(extractedContent);
          console.log('Parsed resume fields:', parsedResumeData?.personalInfo?.fullName);
        } catch (parseErr) {
          console.error('Resume parsing failed (upload will still succeed):', parseErr);
          parsedResumeData = null;
        }

        // Step 2: Read file as base64
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < uint8Array.length; i++) {
          binary += String.fromCharCode(uint8Array[i]);
        }
        const base64Content = btoa(binary);

        // Step 3: Save original binary file
        await registerManagedBinaryFile({
          userId: userEmail,
          feature: 'resume',
          filename: fileName,
          contentBase64: base64Content,
          sourceRoute: '/frontend-form',
          mimeType: file.type || 'application/octet-stream',
          tags: ['source-resume', 'canonical', 'binary-with-text']
        });

        // Step 4: Save extracted text separately
        const textFileName = fileName.replace(/\.(pdf|docx?|doc)$/i, '.txt');
        await registerManagedFile({
          userId: userEmail,
          feature: 'resume',
          filename: textFileName,
          content: extractedContent,
          sourceRoute: '/frontend-form',
          mimeType: 'text/plain',
          tags: ['extracted-text', 'canonical']
        });

        formData.resumeFileName = fileName;
        resumeFile = { name: fileName };
        resumeUploaded = true;

        await loadUploadedResumes();

        uploadValidationMessage = `✓ Resume uploaded successfully: ${fileName}`;
        if (target) target.value = '';
        setTimeout(() => { uploadValidationMessage = ''; }, 5000);
      } catch (error) {
        console.error('Failed to upload resume:', error);
        uploadValidationMessage = `✗ Failed to upload resume: ${error}`;
        alert('Failed to upload resume file: ' + error);
        if (target) target.value = '';
        setTimeout(() => { uploadValidationMessage = ''; }, 5000);
      }
    }
  }

  function resetForm() {
    formData = {
      fullName: '',
      address: '',
      email: '',
      phone: '',
      linkedinUrl: '',
      keywords: '',
      minSalary: '',
      maxSalary: '',
      jobType: 'any',
      experienceLevel: 'any',
      industry: '',
      listedDate: '',
      remotePreference: 'any',
      rewriteResume: false,
      excludedCompanies: '',
      excludedKeywords: '',
      acceptTerms: false,
      resumeFileName: ''
    };
    resumeFile = null;
    resumeUploaded = false;
    extractedResumeText = '';
    parsedResumeData = null;
  }

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();

    // Validate all required fields
    const missing: string[] = [];

    // Basic Information
    if (!formData.fullName.trim())    missing.push('Full Name');
    if (!formData.address.trim())     missing.push('Address');
    if (!formData.phone.trim())       missing.push('Phone');
    if (!formData.email.trim())       missing.push('Email');
    if (!formData.linkedinUrl.trim()) missing.push('LinkedIn URL');
    if (!formData.resumeFileName)     missing.push('Resume File');

    // Job Preferences
    if (!formData.keywords.trim())       missing.push('Keywords');
    if (!formData.remotePreference)      missing.push('Remote Preference');
    if (!String(formData.minSalary).trim()) missing.push('Minimum Salary');
    if (!formData.jobType)               missing.push('Job Type');
    if (!formData.experienceLevel)       missing.push('Experience Level');

    if (missing.length > 0) {
      alert(`Please fill in the following required fields:\n\n• ${missing.join('\n• ')}`);
      return;
    }

    if (!formData.acceptTerms) {
      alert('You must accept the legal disclaimer to continue');
      return;
    }

    const syncResult = await syncSelectedResumeToCorpus();
    if (!syncResult.success) {
      alert(syncResult.message);
      uploadValidationMessage = syncResult.message;
      return;
    }

    const uploadValidation = await validateUploadedResumeForCurrentUser();
    if (!uploadValidation.success) {
      alert(uploadValidation.message);
      uploadValidationMessage = uploadValidation.message;
      return;
    }
    uploadValidationMessage = `${syncResult.message} ${uploadValidation.message}`.trim();

    isSubmitting = true;
    try {
      const saved = await saveConfig();
      if (saved) {
        alert('Configuration saved successfully!');
      } else {
        throw new Error('Failed to save configuration');
      }
    } catch (error) {
      console.error('Error saving configuration:', error);
      alert('Error saving configuration. Please try again.');
    } finally {
      isSubmitting = false;
    }
  }

  async function loadConfig() {
    // Resolve the config path from Tauri
    try {
      appConfigPath = await invoke<string>('get_app_config_path');
    } catch {
      appConfigPath = '';
    }

    let configLoaded = false;

    // Try new user-data path first
    if (appConfigPath) {
      try {
        const configContent = await invoke<string>('read_file_async', { filename: appConfigPath });
        const config = JSON.parse(configContent);
        if (config.formData) {
          formData = { ...formData, ...config.formData };
        }
        // Support both new `rawText` key and old `content` key for migration
        const storedResumeText = config.original_resume?.rawText || config.original_resume?.content || '';
        if (storedResumeText) {
          extractedResumeText = storedResumeText;
        }
        if (config.original_resume?.parsed) {
          parsedResumeData = config.original_resume.parsed as ParsedResume;
        }
        // If we have text but no parsed data, re-parse now
        if (extractedResumeText && !parsedResumeData) {
          try { parsedResumeData = parseResumeText(extractedResumeText); } catch {}
        }
        configLoaded = true;
        console.log('Config loaded from', appConfigPath);
      } catch {}
    }

    if (!configLoaded) {
      console.log('No existing config found, using defaults');
    }

    await loadUploadedResumes();
    if (formData.resumeFileName && availableResumeFiles.includes(formData.resumeFileName)) {
      resumeFile = { name: formData.resumeFileName };
      resumeUploaded = true;
    } else if (availableResumeFiles.length > 0) {
      formData.resumeFileName = availableResumeFiles[0];
      resumeFile = { name: availableResumeFiles[0] };
      resumeUploaded = true;
    }

    // If a resume is selected but we still have no extracted text, load it from the stored .txt companion
    if (formData.resumeFileName && !extractedResumeText) {
      await loadExtractedTextForResume(formData.resumeFileName);
    }
  }

  async function saveConfig() {
    try {
      const config = {
        formData: { ...formData },
        general_questions: questionsData ?? null,
        lastUpdated: new Date().toISOString()
      };

      const targetPath = appConfigPath || await invoke<string>('get_app_config_path');
      await invoke<string>('write_file_async', {
        filename: targetPath,
        content: JSON.stringify(config, null, 2)
      });
      console.log('Config saved to', targetPath);
      return true;
    } catch (error) {
      console.error('Error saving config:', error);
      return false;
    }
  }

  async function validateUploadedResumeForCurrentUser(): Promise<{ success: boolean; message: string }> {
    const userEmail = (formData.email || '').trim();
    if (!userEmail) {
      return { success: false, message: 'Please add your Email in Basic Information before saving configuration.' };
    }
    try {
      const entries = await getManagedFiles({ userId: userEmail, feature: 'resume' });
      const fileNames = entries
        .map((entry) => entry.filename)
        .filter((name): name is string => typeof name === 'string' && isSupportedResumeFile(name));

      if (fileNames.length === 0) {
        return { success: false, message: `No canonical .doc/.docx/.pdf resume found for ${userEmail}. Please upload resume first.` };
      }

      let selectedResumeName = '';
      if (formData.resumeFileName) {
        if (!fileNames.includes(formData.resumeFileName)) {
          return { success: false, message: `Selected resume "${formData.resumeFileName}" was not found in canonical storage for ${userEmail}. Upload/select that same file first.` };
        }
        selectedResumeName = formData.resumeFileName;
      } else {
        selectedResumeName = fileNames.find((name: string) => name.toLowerCase().includes('resume')) || fileNames[0];
      }

      formData.resumeFileName = selectedResumeName;
      resumeFile = { name: selectedResumeName };
      resumeUploaded = true;
      return { success: true, message: `Resume verified: ${selectedResumeName}` };
    } catch (error) {
      return { success: false, message: `Resume upload validation failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async function syncSelectedResumeToCorpus(): Promise<{ success: boolean; message: string }> {
    const userEmail = (formData.email || '').trim();
    if (!userEmail) {
      return { success: false, message: 'Please add your Email in Basic Information before saving configuration.' };
    }

    const selectedResumeName = (formData.resumeFileName || '').trim();
    if (!selectedResumeName) {
      return { success: false, message: 'Please select/upload a resume file before saving configuration.' };
    }

    if (!isSupportedResumeFile(selectedResumeName)) {
      return { success: false, message: 'Only .doc, .docx, and .pdf resumes are supported.' };
    }

    try {
      const entries = await getManagedFiles({ userId: userEmail, feature: 'resume' });
      const fileNames = entries
        .map((entry) => entry.filename)
        .filter((name): name is string => typeof name === 'string' && isSupportedResumeFile(name));

      if (!fileNames.includes(selectedResumeName)) {
        return { success: false, message: `Selected resume "${selectedResumeName}" was not found in canonical storage for ${userEmail}. Please upload it first.` };
      }
      return { success: true, message: `Resume available in canonical storage: ${selectedResumeName}` };
    } catch (error) {
      return { success: false, message: `Resume sync to corpus failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // ── Q&A functions ──────────────────────────────────────────────────────────

  async function loadQuestions() {
    try {
      questionsLoading = true;
      const response = await fetch(API_URLS.GENERIC_QUESTIONS());
      const result = await response.json();
      if (result.success) {
        questionsData = result.data;
        const newEditing: typeof editingQuestions = {};
        questionsData.questions.forEach((q: any) => {
          newEditing[q.id] = {
            keywords: q.match_keywords.join(', '),
            answers: q.answer.join(', ')
          };
        });
        editingQuestions = newEditing;
      } else {
        console.error('Failed to load Q&A:', result.error);
      }
    } catch (err) {
      console.error('Failed to load Q&A:', err);
    } finally {
      questionsLoading = false;
    }
  }

  async function saveQuestion(questionId: number | string) {
    try {
      questionsSaving = true;
      const edited = editingQuestions[questionId];
      const keywords = edited.keywords.split(',').map((k: string) => k.trim()).filter((k: string) => k);
      const answers = edited.answers.split(',').map((a: string) => a.trim()).filter((a: string) => a);
      const response = await fetch(`${API_URLS.GENERIC_QUESTIONS()}/${questionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_keywords: keywords, answer: answers })
      });
      const result = await response.json();
      if (result.success) {
        await loadQuestions();
      } else {
        alert(`Failed to save: ${result.error}`);
      }
    } catch (err: any) {
      alert(`Error saving: ${err.message}`);
    } finally {
      questionsSaving = false;
    }
  }

  async function deleteQuestion(questionId: number | string) {
    if (!confirm('Delete this question?')) return;
    try {
      questionsSaving = true;
      const response = await fetch(`${API_URLS.GENERIC_QUESTIONS()}/${questionId}`, { method: 'DELETE' });
      const result = await response.json();
      if (result.success) {
        await loadQuestions();
      } else {
        alert(`Failed to delete: ${result.error}`);
      }
    } catch (err: any) {
      alert(`Error deleting: ${err.message}`);
    } finally {
      questionsSaving = false;
    }
  }

  async function addNewQuestion() {
    try {
      questionsSaving = true;
      const response = await fetch(API_URLS.GENERIC_QUESTIONS(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_keywords: [''], answer: [''] })
      });
      const result = await response.json();
      if (result.success) {
        await loadQuestions();
      } else {
        alert(`Failed to add: ${result.error}`);
      }
    } catch (err: any) {
      alert(`Error adding: ${err.message}`);
    } finally {
      questionsSaving = false;
    }
  }

  async function toggleAutoAnswer() {
    if (!questionsData) return;
    try {
      questionsSaving = true;
      const newValue = !questionsData.settings.autoAnswer;
      const response = await fetch(API_URLS.GENERIC_QUESTIONS(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'settings', settings: { autoAnswer: newValue } })
      });
      const result = await response.json();
      if (result.success) {
        questionsData.settings.autoAnswer = newValue;
      } else {
        alert(`Failed to update: ${result.error}`);
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      questionsSaving = false;
    }
  }
</script>

<div class="container mx-auto p-6">
  <div class="max-w-4xl mx-auto">
    <div class="mb-8">
      <h1 class="text-4xl font-bold text-primary">⚙️ Configuration</h1>
    </div>

    <form onsubmit={handleSubmit} class="space-y-8">

      <!-- Section 1: Basic Information -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-2xl mb-6">👤 Basic Information</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="form-control">
              <label class="label" for="full-name-input">
                <span class="label-text font-semibold">Full Name</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <input
                id="full-name-input"
                type="text"
                placeholder="Amit Chaulagain"
                bind:value={formData.fullName}
                class="input input-bordered w-full"
                required
              />
            </div>

            <div class="form-control">
              <label class="label" for="address-input">
                <span class="label-text font-semibold">Address</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <input
                id="address-input"
                type="text"
                placeholder="123 Main St, Sydney NSW 2000"
                bind:value={formData.address}
                class="input input-bordered w-full"
                required
              />
            </div>

            <div class="form-control">
              <label class="label" for="phone-input">
                <span class="label-text font-semibold">Phone</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <input
                id="phone-input"
                type="text"
                placeholder="+61 4XX XXX XXX"
                bind:value={formData.phone}
                class="input input-bordered w-full"
                required
              />
            </div>

            <div class="form-control">
              <label class="label" for="email-input">
                <span class="label-text font-semibold">Email</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <input
                id="email-input"
                type="email"
                placeholder="you@example.com"
                bind:value={formData.email}
                class="input input-bordered w-full"
                required
              />
            </div>

            <div class="form-control md:col-span-2">
              <label class="label" for="linkedin-url-input">
                <span class="label-text font-semibold">LinkedIn URL</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <input
                id="linkedin-url-input"
                type="url"
                placeholder="https://www.linkedin.com/in/your-profile"
                bind:value={formData.linkedinUrl}
                class="input input-bordered w-full"
                required
              />
            </div>
          </div>

          <!-- Resume Upload -->
          <div class="divider">Resume</div>
          <div class="form-control">
            <div class="label">
              <span class="label-text font-semibold">Resume File</span>
              <span class="label-text-alt text-error">Required — PDF, DOC, or DOCX</span>
            </div>
            {#if availableResumeFiles.length > 0}
              <div class="mb-4">
                <label for="resume-select" class="label">
                  <span class="label-text">Select from uploaded resumes:</span>
                </label>
                <select
                  id="resume-select"
                  bind:value={formData.resumeFileName}
                  onchange={handleResumeSelection}
                  class="select select-bordered w-full"
                >
                  <option value="" disabled>Choose a resume</option>
                  {#each availableResumeFiles as fileName}
                    <option value={fileName}>{fileName}</option>
                  {/each}
                </select>
                {#if formData.resumeFileName}
                  <div class="mt-2 text-success text-sm">✓ Selected: {formData.resumeFileName}</div>
                {/if}
              </div>
              <div class="text-center opacity-60 mb-2">— OR —</div>
            {/if}
            <input
              type="file"
              accept=".pdf,.doc,.docx"
              id="resume-upload"
              class="file-input file-input-bordered w-full"
              onchange={handleResumeUpload}
            />
            {#if uploadValidationMessage}
              <div class="mt-2 p-2 rounded text-sm {uploadValidationMessage.includes('✓') ? 'bg-success/10 text-success border border-success/30' : uploadValidationMessage.includes('✗') ? 'bg-error/10 text-error border border-error/30' : 'bg-info/10 text-info border border-info/30'}">
                {uploadValidationMessage}
              </div>
            {/if}
          </div>
        </div>
      </div>

      <!-- Section 2: Job Preferences -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-2xl mb-6">🎯 Job Preferences</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="form-control md:col-span-2">
              <label class="label" for="keywords-input">
                <span class="label-text font-semibold">Keywords (comma separated)</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <input
                id="keywords-input"
                type="text"
                placeholder="python, backend, api, django"
                bind:value={formData.keywords}
                class="input input-bordered w-full"
                required
              />
            </div>

            <div class="form-control">
              <label class="label" for="remote-preference-select">
                <span class="label-text font-semibold">Remote Preference</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <select id="remote-preference-select" bind:value={formData.remotePreference} class="select select-bordered w-full">
                <option value="any">Any</option>
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
                <option value="on-site">On-site</option>
              </select>
            </div>

            <div class="form-control">
              <label class="label" for="min-salary-input">
                <span class="label-text font-semibold">Minimum Salary (AUD)</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <input
                id="min-salary-input"
                type="number"
                placeholder="80000"
                min="0"
                bind:value={formData.minSalary}
                class="input input-bordered w-full"
              />
            </div>

            <div class="form-control">
              <label class="label" for="max-salary-input">
                <span class="label-text font-semibold">Maximum Salary (AUD)</span>
              </label>
              <input
                id="max-salary-input"
                type="number"
                placeholder="150000"
                min="0"
                bind:value={formData.maxSalary}
                class="input input-bordered w-full"
              />
            </div>

            <div class="form-control">
              <label class="label" for="job-type-select">
                <span class="label-text font-semibold">Job Type</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <select id="job-type-select" bind:value={formData.jobType} class="select select-bordered w-full">
                <option value="any">Any</option>
                <option value="full-time">Full time</option>
                <option value="part-time">Part time</option>
                <option value="contract">Contract/Temp</option>
                <option value="casual">Casual/Vacation</option>
              </select>
            </div>

            <div class="form-control">
              <label class="label" for="experience-level-select">
                <span class="label-text font-semibold">Experience Level</span>
                <span class="label-text-alt text-error">Required</span>
              </label>
              <select id="experience-level-select" bind:value={formData.experienceLevel} class="select select-bordered w-full">
                <option value="any">Any</option>
                <option value="entry">Entry Level</option>
                <option value="mid">Mid Level</option>
                <option value="senior">Senior</option>
                <option value="lead">Lead</option>
                <option value="executive">Executive</option>
              </select>
            </div>

            <div class="form-control">
              <label class="label" for="industry-select">
                <span class="label-text font-semibold">Industry</span>
              </label>
              <select id="industry-select" bind:value={formData.industry} class="select select-bordered w-full">
                {#each industries as industry}
                  <option value={industry.value} disabled={industry.value === ''}>{industry.label}</option>
                {/each}
              </select>
            </div>

            <div class="form-control">
              <label class="label" for="listed-date-select">
                <span class="label-text font-semibold">Job Listed On</span>
              </label>
              <select id="listed-date-select" bind:value={formData.listedDate} class="select select-bordered w-full">
                <option value="" disabled selected>Select listing date range</option>
                <option value="any">Any time</option>
                <option value="today">Today</option>
                <option value="last_3_days">Last 3 days</option>
                <option value="last_7_days">Last 7 days</option>
                <option value="last_14_days">Last 14 days</option>
                <option value="last_30_days">Last 30 days</option>
              </select>
            </div>

            <div class="form-control">
              <label class="label" for="excluded-companies-input">
                <span class="label-text font-semibold">Excluded Companies (comma separated)</span>
              </label>
              <input
                id="excluded-companies-input"
                type="text"
                placeholder="wipro, infosys, tcs"
                bind:value={formData.excludedCompanies}
                class="input input-bordered w-full"
              />
            </div>

            <div class="form-control">
              <label class="label" for="excluded-keywords-input">
                <span class="label-text font-semibold">Excluded Keywords</span>
              </label>
              <input
                id="excluded-keywords-input"
                type="text"
                placeholder="junior, intern, php"
                bind:value={formData.excludedKeywords}
                class="input input-bordered w-full"
              />
            </div>

            <div class="form-control md:col-span-2">
              <label class="label cursor-pointer justify-start gap-4">
                <input type="checkbox" bind:checked={formData.rewriteResume} class="checkbox checkbox-primary" />
                <span class="label-text font-semibold">Rewrite resume for each job?</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- Section 3: General Q&A -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-2xl mb-2">💬 General Q&A</h2>
          <p class="text-sm opacity-70 mb-4">
            Define keyword-based auto-answers for common application questions. Changes save automatically on blur.
          </p>

          {#if questionsLoading}
            <div class="flex items-center justify-center py-8">
              <span class="loading loading-spinner loading-md text-primary"></span>
            </div>
          {:else if !questionsData}
            <div class="alert alert-warning">
              <span>Could not load Q&A data. Make sure the server is running.</span>
              <button class="btn btn-sm" onclick={loadQuestions}>Retry</button>
            </div>
          {:else}
            <!-- Controls row -->
            <div class="flex flex-col sm:flex-row gap-3 items-center justify-between mb-4">
              <div class="flex items-center gap-3">
                <span class="text-sm font-medium">Smart auto-answer:</span>
                <input
                  type="checkbox"
                  class="toggle toggle-success"
                  checked={questionsData.settings.autoAnswer}
                  onchange={toggleAutoAnswer}
                  disabled={questionsSaving}
                />
                <span class="text-xs {questionsData.settings.autoAnswer ? 'text-success' : 'opacity-50'}">
                  {questionsData.settings.autoAnswer ? 'ON' : 'OFF'}
                </span>
              </div>
              <button
                type="button"
                class="btn btn-primary btn-sm gap-2"
                onclick={addNewQuestion}
                disabled={questionsSaving}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
                Add Question
              </button>
            </div>

            <!-- Questions list -->
            {#if questionsData.questions.length === 0}
              <div class="text-center py-6 opacity-50 text-sm">
                No questions yet. Click "Add Question" to create one.
              </div>
            {:else}
              <div class="space-y-3">
                {#each questionsData.questions as question (question.id)}
                  <div class="card bg-base-200 border border-base-300">
                    <div class="card-body p-4">
                      <div class="flex items-center gap-2 mb-3">
                        <div class="badge badge-neutral">#{question.id}</div>
                        <button
                          type="button"
                          class="btn btn-ghost btn-xs ml-auto"
                          onclick={() => deleteQuestion(question.id)}
                          disabled={questionsSaving}
                          aria-label="Delete question"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      <div class="grid grid-cols-1 gap-3">
                        <div class="form-control">
                          <label class="label py-1" for={`qa-keywords-${question.id}`}>
                            <span class="label-text font-medium">🔍 Match questions containing</span>
                          </label>
                          <input
                            id={`qa-keywords-${question.id}`}
                            type="text"
                            class="input input-bordered input-sm w-full"
                            placeholder="right to work, work authorization, visa status"
                            bind:value={editingQuestions[question.id].keywords}
                            onblur={() => saveQuestion(question.id)}
                          />
                        </div>
                        <div class="form-control">
                          <label class="label py-1" for={`qa-answers-${question.id}`}>
                            <span class="label-text font-medium">✅ Answer with</span>
                          </label>
                          <input
                            id={`qa-answers-${question.id}`}
                            type="text"
                            class="input input-bordered input-sm w-full"
                            placeholder="Australian citizen, Yes, I have work rights"
                            bind:value={editingQuestions[question.id].answers}
                            onblur={() => saveQuestion(question.id)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      </div>

      <!-- Legal Agreement -->
      <div class="form-section legal-section">
        <div class="legal-content">
          <h3 class="legal-title">Legal Disclaimer</h3>
          <div class="legal-text">
            Using this bot may violate Seek's Terms of Service. You assume all responsibility.
          </div>
        </div>
        <div class="legal-agreement">
          <label class="checkbox-label legal-checkbox">
            <span class="checkbox-text">I understand and accept</span>
            <input type="checkbox" bind:checked={formData.acceptTerms} required class="checkbox-input" />
            <span class="checkmark"></span>
          </label>
        </div>
      </div>

      <!-- Submit Buttons -->
      <div class="form-actions" style="display: flex; gap: var(--space-xl); justify-content: center; margin-top: var(--space-2xl); flex-wrap: wrap;">
        <button type="submit" class="btn btn--primary btn--large" disabled={isSubmitting}>
          {#if isSubmitting}
            Saving...
          {:else}
            💾 Save Configuration
          {/if}
        </button>
        <button type="button" class="btn btn--outline btn--large" onclick={resetForm}>
          🔄 Reset Form
        </button>
      </div>
      {#if uploadValidationMessage}
        <div style="margin-top: 12px; text-align: center; font-size: 0.9rem; opacity: 0.9;">
          {uploadValidationMessage}
        </div>
      {/if}
    </form>
  </div>
</div>
