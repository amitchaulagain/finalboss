import type { WorkflowContext } from '../../core/workflow_engine';
import { getClientEmailFromContext, getJobArtifactDir } from '../../core/client_paths';
import { readCanonicalResumeText } from '../../../lib/canonical-resume';
import { By, until } from 'selenium-webdriver';

const printLog = (message: string) => {
  console.log(message);
};

async function resolveResumeText(ctx: WorkflowContext): Promise<string> {
  const clientEmail =
    getClientEmailFromContext(ctx) ||
    (ctx as any)?.config?.formData?.email ||
    '';

  if (!clientEmail) {
    throw new Error('Missing client email. Canonical resume lookup requires user email in config.');
  }
  const preferredResumeFileName = String(((ctx as any)?.config?.formData?.resumeFileName || '')).trim();
  const resume = readCanonicalResumeText(clientEmail, preferredResumeFileName);
  printLog(`📄 Using canonical resume: ${resume.filename}`);
  return resume.content;
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
    phone: String(formData.phone || '').trim(),
    linkedin_url: String(formData.linkedinUrl || '').trim()
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
Highlight relevant experience and skills that match the job requirements.
Keep it concise (300-400 words) and personalized to ${jobData.company || 'the company'}.
Focus on demonstrating value and enthusiasm for the role.`
  };

  const jobDir = getJobArtifactDir(ctx, 'seek', jobId);

  fs.writeFileSync(
    path.join(jobDir, 'cover_letter_request.json'),
    JSON.stringify(requestBody, null, 2)
  );

  // Fetch cover letter prompt from corpus-rag
  const { apiRequest } = await import('../../core/api_client');
  try {
    const promptRes = await apiRequest('/api/prompts/cover-letter', 'GET');
    if (promptRes?.content) {
      requestBody.prompt = promptRes.content;
    }
  } catch (e) {
    printLog(`⚠️ Could not fetch cover-letter prompt, using embedded fallback`);
  }

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
    printLog(`📄 Length: ${data.cover_letter.length} chars`);
    return data.cover_letter;
  } else {
    printLog(`❌ API response missing cover_letter field. Response: ${JSON.stringify(data)}`);
    throw new Error('No cover_letter field returned from API');
  }
}

// Handle Cover Letter (part of Choose Documents step) - Improved from Python version
export async function* handleCoverLetter(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog("Handling cover letter...");

    // Step 1: Find and native-click the cover letter radio button.
    // JS executeScript clicks bypass React's synthetic event system and won't
    // reveal the textarea — native Selenium click fires real browser events.
    printLog("🔍 Looking for cover letter radio button...");
    try {
      const coverLetterRadio = await ctx.driver.wait(
        until.elementLocated(By.css('input[data-testid="coverLetter-method-change"]')),
        5000,
        'Cover letter radio button not found within 5 s'
      );
      await ctx.driver.executeScript('arguments[0].scrollIntoView({block:"center"});', coverLetterRadio);
      await coverLetterRadio.click();
      printLog("✅ Cover letter radio clicked");
    } catch {
      printLog("ℹ️ Cover letter radio not found — cover letter not required for this job");
      yield "cover_letter_not_required";
      return;
    }

    // Step 2: Wait for the textarea to appear after the React state update
    await ctx.driver.sleep(1000);

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

      // Inject the text via JS (instantaneous) then fire React-compatible events.
      // sendKeys types character-by-character and takes 60+ seconds for a full cover
      // letter, which exceeds the step timeout and prevents the resume step from running.
      printLog("🔍 Step 4: Injecting cover letter text via JS...");
      await ctx.driver.executeScript(`
        const el = arguments[0];
        const text = arguments[1];
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeInputValueSetter.call(el, text);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      `, textarea, coverLetterText);
      printLog("✅ Step 4: Cover letter text injected successfully");

      // Brief pause so React processes the synthetic events
      printLog("🔍 Step 5: Waiting for form processing...");
      await ctx.driver.sleep(1500);
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