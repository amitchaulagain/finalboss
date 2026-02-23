import type { WorkflowContext } from '../../core/workflow_engine';
import { getClientEmailFromContext, getJobArtifactDir } from '../../core/client_paths';
import { resolveCanonicalResumePath } from '../../../lib/canonical-resume';

const printLog = (message: string) => {
  console.log(message);
};

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
  const formData = ((ctx as any)?.config?.formData || {}) as Record<string, string>;
  const contactProfile = {
    full_name: String(formData.fullName || '').trim(),
    email: String(formData.email || getClientEmailFromContext(ctx) || '').trim(),
    phone: String(formData.phone || '').trim()
  };

  const requestBody = {
    job_id: `seek_${jobId}`,
    job_details: jobData.details || `${jobData.title} at ${jobData.company}`,
    resume_text: resumeText,
    useAi: "deepseek-chat",
    strictQuality: true,
    qualityThreshold: 92,
    strictQualityRetries: 1,
    contact_profile: contactProfile,

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
    printLog("✅ AI cover letter generated");
    const coverLetter = stripMarkdown(data.cover_letter);
    printLog(`📄 Length: ${coverLetter.length} chars`);
    return coverLetter;
  } else {
    printLog(`❌ API response missing cover_letter field. Response: ${JSON.stringify(data)}`);
    throw new Error('No cover_letter field returned from API');
  }
}

// Handle Cover Letter (part of Choose Documents step) - Improved from Python version
export async function* handleCoverLetter(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog("Handling cover letter...");

    // Step 1: Click cover letter radio button (improved from Python version)
    const radioClicked = await ctx.driver.executeScript(`
      const coverLetterRadio = document.querySelector('input[data-testid="coverLetter-method-change"]');
      if (coverLetterRadio && !coverLetterRadio.checked) {
        // Use improved click strategy from Python
        coverLetterRadio.click();
        coverLetterRadio.checked = true;

        // Dispatch change event
        const changeEvent = new Event('change', { bubbles: true });
        coverLetterRadio.dispatchEvent(changeEvent);

        // Dispatch click event
        const clickEvent = new Event('click', { bubbles: true });
        coverLetterRadio.dispatchEvent(clickEvent);

        console.log('Cover letter radio clicked successfully');
        return true;
      }
      return false;
    `);

    if (!radioClicked) {
      printLog("Cover letter radio not found or already selected");
      yield "cover_letter_not_required";
      return;
    }

    printLog("Cover letter radio clicked successfully");

    // Step 2: Wait for textarea to appear (outside executeScript like Python)
    await ctx.driver.sleep(1000);

    // Step 3: Use Selenium's sendKeys for human-like typing instead of executeScript
    await ctx.driver.sleep(500); // Let radio button change settle

    let textareaResult;

    try {
      printLog("🔍 Step 1: Finding textarea element...");
      const textarea = await ctx.driver.findElement({ css: 'textarea[data-testid="coverLetterTextInput"]' });
      printLog("✅ Step 1: Textarea found successfully");

      // Clear any existing content
      printLog("🔍 Step 2: Clearing existing content...");
      await textarea.clear();
      printLog("✅ Step 2: Content cleared successfully");

      // Generate AI-powered cover letter based on job description
      printLog("🔍 Step 3: Generating AI cover letter - this MUST succeed, no fallbacks!");
      const coverLetterText = await generateAICoverLetter(ctx);
      printLog("✅ Step 3: AI cover letter generated successfully");

      if (!coverLetterText || coverLetterText.trim().length < 50) {
        throw new Error(`Generated cover letter is too short: ${coverLetterText?.length || 0} chars`);
      }

      // Use sendKeys to simulate human typing - this triggers proper events
      printLog("🔍 Step 4: Typing AI-generated cover letter text using sendKeys...");
      await textarea.sendKeys(coverLetterText);
      printLog("✅ Step 4: Text typed successfully");

      // Give it a moment to process
      printLog("🔍 Step 5: Waiting for form processing...");
      await ctx.driver.sleep(1000);
      printLog("✅ Step 5: Processing wait complete");

      // Verify the content was set
      printLog("🔍 Step 6: Verifying content was set and checking validation...");
      textareaResult = await ctx.driver.executeScript(`
        const textarea = document.querySelector('textarea[data-testid="coverLetterTextInput"]');
        if (textarea) {
          const finalValue = textarea.value;
          const valueLength = finalValue.length;

          // Check for validation errors
          const errorElements = document.querySelectorAll('[role="alert"], .error, .invalid, [aria-invalid="true"]');
          const hasErrors = errorElements.length > 0;
          const errorMessages = Array.from(errorElements).map(el => el.textContent.trim()).filter(txt => txt);

          // Check textarea validation state
          const textareaInvalid = textarea.getAttribute('aria-invalid') === 'true';
          const textareaRequired = textarea.hasAttribute('required') && finalValue.length === 0;

          // Debug validation logic
          const successCondition = valueLength > 0 && !textareaInvalid && !textareaRequired;
          console.log('SendKeys result - Length:', valueLength, 'Errors:', hasErrors, 'TextareaInvalid:', textareaInvalid, 'Required:', textareaRequired);
          console.log('Success calculation: valueLength > 0:', valueLength > 0, '!textareaInvalid:', !textareaInvalid, '!textareaRequired:', !textareaRequired);
          console.log('Final success result:', successCondition);

          return {
            success: successCondition,
            length: valueLength,
            hasErrors: hasErrors || textareaInvalid || textareaRequired,
            errorMessages: errorMessages,
            actualValue: finalValue.substring(0, 50) + '...',
            textareaInvalid: textareaInvalid,
            textareaRequired: textareaRequired
          };
        }
        return { success: false, error: 'textarea_not_found' };
      `);

    } catch (seleniumError) {
      printLog(`❌ Selenium sendKeys failed: ${seleniumError}`);
      throw new Error(`Both AI generation and form filling failed: ${seleniumError}`);
    }

    printLog("🔍 Step 7: Evaluating final result...");
    printLog(`🔍 Step 7 DEBUG: textareaResult.success = ${textareaResult.success}`);
    printLog(`🔍 Step 7 DEBUG: Full textareaResult = ${JSON.stringify(textareaResult, null, 2)}`);

    if (textareaResult.success) {
      printLog(`✅ Step 7: SUCCESS! Cover letter filled - Length: ${textareaResult.length}, Value: ${textareaResult.actualValue}`);
      if (textareaResult.hasErrors) {
        printLog(`⚠️ VALIDATION WARNINGS: ${textareaResult.errorMessages.join(', ')}`);
      }
      printLog("🎉 YIELDING: cover_letter_filled");
      yield "cover_letter_filled";
    } else {
      printLog(`❌ Step 7: FAILURE! Cover letter filling failed: ${textareaResult.error || 'Unknown error'}`);
      if (textareaResult.errorMessages && textareaResult.errorMessages.length > 0) {
        printLog(`🔥 Error messages: ${textareaResult.errorMessages.join(', ')}`);
      }
      if (textareaResult.textareaInvalid) {
        printLog(`🔥 Textarea marked as invalid (aria-invalid="true")`);
      }
      if (textareaResult.textareaRequired) {
        printLog(`🔥 Textarea is required but empty`);
      }
      printLog(`📋 Length: ${textareaResult.length}, Invalid: ${textareaResult.textareaInvalid}, Required: ${textareaResult.textareaRequired}`);
      printLog("💥 YIELDING: cover_letter_error");
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