import type { WorkflowContext } from '../../core/workflow_engine';
import { getClientEmailFromContext, getJobArtifactDir } from '../../core/client_paths';
import { resolveCanonicalResumePath } from '../../../lib/canonical-resume';

const printLog = (message: string) => {
  console.log(message);
};

/**
 * Replaces the name that appears on the line(s) immediately after a closing
 * salutation (e.g. "Yours sincerely,", "Kind regards,") with `correctName`.
 * This is a safety net for when the AI copies the old name from the resume text
 * instead of using the name supplied in the prompt.
 */
function fixSignOffName(text: string, correctName: string): string {
  if (!correctName) return text;

  const closingPhrases = [
    'yours sincerely', 'yours faithfully', 'sincerely yours', 'sincerely',
    'kind regards', 'warm regards', 'best regards', 'regards',
    'with regards', 'many thanks', 'thank you', 'yours truly',
  ];

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].trim().toLowerCase().replace(/,\s*$/, '');
    if (closingPhrases.includes(lower)) {
      // Replace all non-empty name lines that immediately follow the salutation
      let j = i + 1;
      // Skip any blank line between salutation and name
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && lines[j].trim() !== '') {
        const oldName = lines[j].trim();
        if (oldName !== correctName) {
          printLog(`📝 Sign-off name corrected: "${oldName}" → "${correctName}"`);
          lines[j] = lines[j].replace(oldName, correctName);
        }
      }
      break;
    }
  }
  return lines.join('\n');
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')           // headings
    .replace(/\*\*(.+?)\*\*/gs, '$1')      // bold **
    .replace(/__(.+?)__/gs, '$1')           // bold __
    .replace(/\*(.+?)\*/gs, '$1')           // italic *
    .replace(/(?<!\w)_(.+?)_(?!\w)/gs, '$1') // italic _
    .replace(/`(.+?)`/g, '$1')             // inline code
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')    // links
    .replace(/^>\s+/gm, '')                // blockquotes
    .replace(/^[-*_]{3,}\s*$/gm, '')       // horizontal rules
    .replace(/^[ \t]*[-*+]\s+/gm, '')      // bullet list markers
    .replace(/\n{3,}/g, '\n\n')            // collapse excess blank lines
    .trim();
}

async function resolveResumeText(ctx: WorkflowContext): Promise<string> {
  const clientEmail =
    getClientEmailFromContext(ctx) ||
    (ctx as any)?.config?.formData?.email ||
    '';

  if (!clientEmail) {
    throw new Error('Missing client email. Canonical resume lookup requires user email in config.');
  }
  const preferredResumeFileName = String(((ctx as any)?.config?.formData?.resumeFileName || '')).trim();

  const { filename, filePath } = resolveCanonicalResumePath(clientEmail, preferredResumeFileName);
  printLog(`📄 Extracting text from canonical resume: ${filename}`);

  const fs = await import('fs');
  const path = await import('path');
  const { getBearerHeader } = await import('../../core/api_client.js');
  const baseUrl = process.env.API_BASE || 'http://localhost:3000';
  const binary = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword'
  };
  const formData = new FormData();
  formData.append('userId', clientEmail);
  formData.append('file', new Blob([binary], { type: mimeMap[ext] || 'application/octet-stream' }), filename);

  const response = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { Authorization: await getBearerHeader() },
    body: formData
  });
  if (!response.ok) throw new Error(`Failed to extract resume text via /api/upload: HTTP ${response.status}`);
  const data = await response.json();
  const content = typeof data?.content === 'string' ? data.content.trim() : '';
  if (!content) throw new Error(`Resume text extraction returned empty content for ${filename}`);
  printLog(`📄 Extracted ${content.length} chars from ${filename}`);
  return content;
}

async function readFreshUserConfig(): Promise<Record<string, any>> {
  const { readUserConfig } = await import('../../core/user-config.js');
  return readUserConfig();
}

async function generateAICoverLetter(ctx: WorkflowContext): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');

  let jobData: any = {};
  if (ctx.currentJobFile) {
    jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf8'));
  }

  if (!jobData.title || !jobData.company) {
    throw new Error("No job data available - cannot generate cover letter");
  }

  const jobId = jobData.jobId || 'unknown';
  printLog("Generating AI cover letter...");
  printLog(`📝 Job: ${jobData.title} at ${jobData.company}`);

  const resumeText = await resolveResumeText(ctx);

  // Always read fresh config from disk so changes made after bot start are picked up
  const freshConfig = await readFreshUserConfig();
  const formData = (freshConfig?.formData || (ctx as any)?.config?.formData || {}) as Record<string, string>;
  const contactProfile = {
    full_name: String(formData.fullName || '').trim(),
    email: String(formData.email || getClientEmailFromContext(ctx) || '').trim(),
    phone: String(formData.phone || '').trim()
  };
  printLog(`👤 Contact profile: ${contactProfile.full_name} <${contactProfile.email}> ${contactProfile.phone}`);

  const requestBody = {
    job_id: `seek_${jobId}`,
    job_details: jobData.details || `${jobData.title} at ${jobData.company}`,
    resume_text: resumeText,
    useAi: "deepseek-chat",
    strictQuality: true,
    qualityThreshold: 92,
    strictQualityRetries: 1,
    contact_profile: contactProfile,

    // Disable RAG so the backend never returns a stale cached answer and never
    // retrieves old resume chunks that were auto-ingested from previous runs.
    // The full resume_text is already supplied above, so RAG adds no value here.
    useRag: false,

    // Required tracking fields per API docs
    platform: "seek",
    platform_job_id: jobId,
    job_title: jobData.title || '',
    company: jobData.company || '',

    // Custom prompt for better AI results
    prompt: `Write a compelling, professional cover letter for this Seek job posting.

STRICT RULES — these override everything else:
- NEVER invent, fabricate, or modify any factual information
- Only reference experiences, skills, and achievements that are explicitly stated in the provided resume
- Do NOT fabricate projects, companies, dates, or accomplishments
- Do NOT include a LinkedIn URL or any other URL anywhere in the letter
- The sender's full name is "${contactProfile.full_name}". Use this EXACT name — and only this name — in the closing signature. Do not use any other name from the resume.

Highlight relevant experience and skills that match the job requirements.
Keep it concise (300-400 words) and personalized to ${jobData.company || 'the company'}.
Focus on demonstrating value and enthusiasm for the role.`
  };

  const jobDir = getJobArtifactDir(ctx, 'seek', jobId);

  fs.writeFileSync(
    path.join(jobDir, 'cover_letter_request.json'),
    JSON.stringify(requestBody, null, 2)
  );

  // Use apiRequest helper for authenticated calls
  const { apiRequest } = await import('../../core/api_client');

  let data;
  try {
    data = await apiRequest('/api/cover_letter', 'POST', requestBody);
  } catch (apiError: any) {
    printLog(`❌ API request failed: ${apiError.message}`);
    throw new Error(`Cover letter API call failed: ${apiError.message}`);
  }

  fs.writeFileSync(
    path.join(jobDir, 'cover_letter_response.json'),
    JSON.stringify(data, null, 2)
  );

  // Check for error response
  if (data.success === false) {
    throw new Error(`API returned error: ${data.error || 'Unknown error'}`);
  }

  if (data.cover_letter) {
    const coverLetter = fixSignOffName(stripMarkdown(data.cover_letter), contactProfile.full_name);
    printLog(`✅ AI cover letter received from API (${coverLetter.length} chars)`);
    return coverLetter;
  } else {
    printLog(`❌ API response missing cover_letter field. Response: ${JSON.stringify(data)}`);
    throw new Error('No cover_letter field returned from API');
  }
}

// Handle Cover Letter (part of Choose Documents step) - Improved from Python version
export async function* handleCoverLetter(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog("\n--- Step: Fill Cover Letter ---");
    printLog("🔍 Looking for cover letter radio button to enable text input...");

    // Step 1: Click cover letter radio button (distinguish "not found" from "already checked")
    const radioState: string = await ctx.driver.executeScript(`
      const coverLetterRadio = document.querySelector('input[data-testid="coverLetter-method-change"]');
      if (!coverLetterRadio) return 'not_found';
      if (coverLetterRadio.checked) return 'already_checked';
      coverLetterRadio.click();
      coverLetterRadio.checked = true;
      coverLetterRadio.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('Cover letter radio clicked successfully');
      return 'just_clicked';
    `);

    if (radioState === 'not_found') {
      printLog("⚠️ Cover letter radio button not found — cover letter may not be required for this job");
      yield "cover_letter_not_required";
      return;
    }

    printLog(`✅ Cover letter radio state: ${radioState}`);

    // Step 2: Wait for textarea to appear
    await ctx.driver.sleep(1000);

    // If the radio was already checked, check whether the textarea already has content
    if (radioState === 'already_checked') {
      const existingLength: number = await ctx.driver.executeScript(`
        const ta = document.querySelector('textarea[data-testid="coverLetterTextInput"]');
        return ta ? ta.value.length : -1;
      `);
      if (existingLength === -1) {
        printLog("⚠️ Radio was pre-checked but no textarea found — cover letter not required");
        yield "cover_letter_not_required";
        return;
      }
      if (existingLength > 50) {
        printLog(`✅ Cover letter textarea already has content (${existingLength} chars) — skipping fill`);
        yield "cover_letter_filled";
        return;
      }
      printLog(`⚠️ Cover letter radio was pre-checked but textarea is empty — filling it`);
    }

    // Step 3: Let radio button state settle before interacting with the textarea
    await ctx.driver.sleep(500);

    let textareaResult;

    try {
      printLog("🔍 Step 1: Finding textarea element...");
      const textarea = await ctx.driver.findElement({ css: 'textarea[data-testid="coverLetterTextInput"]' });
      printLog("✅ Step 1: Textarea found successfully");

      // Clear any existing content
      printLog("🔍 Step 2: Clearing existing content...");
      await textarea.clear();
      printLog("✅ Step 2: Content cleared successfully");

      printLog("🤖 Generating AI cover letter via POST /api/cover_letter ...");
      const coverLetterText = await generateAICoverLetter(ctx);
      printLog("✅ AI cover letter received from API");

      if (!coverLetterText || coverLetterText.trim().length < 50) {
        throw new Error(`Generated cover letter is too short: ${coverLetterText?.length || 0} chars`);
      }

      printLog(`📝 Filling cover letter into textarea (${coverLetterText.length} chars)...`);

      // Use React's native value setter so the controlled-component state updates
      // correctly regardless of event batching. This is more reliable than
      // sendKeys() alone for long text in React-managed textareas.
      await ctx.driver.executeScript(`
        const el = arguments[0];
        const text = arguments[1];
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      `, textarea, coverLetterText);
      printLog("✅ Cover letter value set via React native setter");

      await ctx.driver.sleep(1000);

      printLog("🔍 Verifying cover letter content...");
      textareaResult = await ctx.driver.executeScript(`
        const textarea = document.querySelector('textarea[data-testid="coverLetterTextInput"]');
        if (textarea) {
          const finalValue = textarea.value;
          const valueLength = finalValue.length;
          const textareaInvalid = textarea.getAttribute('aria-invalid') === 'true';
          const textareaRequired = textarea.hasAttribute('required') && finalValue.length === 0;
          const errorElements = document.querySelectorAll('[role="alert"], .error, .invalid, [aria-invalid="true"]');
          const errorMessages = Array.from(errorElements).map(el => el.textContent.trim()).filter(txt => txt);
          console.log('Cover letter fill result - Length:', valueLength, 'aria-invalid:', textareaInvalid, 'required+empty:', textareaRequired);
          return {
            success: valueLength > 0,
            length: valueLength,
            hasErrors: textareaInvalid || textareaRequired,
            errorMessages: errorMessages,
            textareaInvalid: textareaInvalid,
            textareaRequired: textareaRequired
          };
        }
        return { success: false, length: 0, error: 'textarea_not_found' };
      `);

    } catch (seleniumError) {
      printLog(`❌ Cover letter fill failed: ${seleniumError}`);
      throw new Error(`Cover letter fill failed: ${seleniumError}`);
    }

    if (textareaResult.success) {
      printLog(`✅ Cover letter filled — ${textareaResult.length} chars in textarea`);
      if (textareaResult.hasErrors) {
        printLog(`⚠️ Validation warnings (non-blocking): ${textareaResult.errorMessages?.join(' | ')}`);
      }
      printLog("➡️ Cover letter complete — handing off to 'Continue' button step");
      yield "cover_letter_filled";
    } else {
      printLog(`❌ Cover letter textarea empty after fill attempt — length: ${textareaResult.length}`);
      yield "cover_letter_error";
    }

  } catch (error) {
    printLog(`💥 COVER LETTER HANDLER CRASH: ${error}`);
    if (error instanceof Error) {
      printLog(`💥 Error stack: ${error.stack}`);
    }
    printLog(`🛑 STAYING PUT FOR MANUAL INSPECTION - Cover letter handler failed`);
    yield "cover_letter_error";
  }
}