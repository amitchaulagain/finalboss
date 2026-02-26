import type { WorkflowContext } from '../../core/workflow_engine';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { By, until } from 'selenium-webdriver';
import { Document, Paragraph, TextRun, Packer } from 'docx';
// @ts-ignore - pdfkit types are not installed in this project.
import PDFDocument from 'pdfkit';
import { getJobArtifactDir } from '../../core/client_paths';
import { resolveCanonicalResumePath, resolveBaseResumeJson } from '../../../lib/canonical-resume';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const printLog = (message: string) => {
  console.log(message);
};

function extractTextFromResumeJson(data: Record<string, unknown>): string {
  const lines: string[] = [];
  const pi = (data.personalInfo as Record<string, string>) || {};

  if (pi.fullName) lines.push(pi.fullName);
  if (pi.title) lines.push(pi.title);
  const contact = [pi.email, pi.phone, pi.address, pi.linkedin, pi.github, pi.website].filter(Boolean);
  if (contact.length) lines.push(contact.join(' | '));

  if (data.summary) {
    lines.push('', 'SUMMARY', String(data.summary));
  }

  const experience = (data.experience as any[]) || [];
  if (experience.length) {
    lines.push('', 'EXPERIENCE');
    for (const exp of experience) {
      lines.push(`${exp.jobTitle} at ${exp.company}${exp.location ? ', ' + exp.location : ''}`);
      const end = exp.endDate || 'Present';
      if (exp.startDate) lines.push(`${exp.startDate} – ${end}`);
      if (Array.isArray(exp.achievements)) {
        for (const a of exp.achievements) lines.push(`• ${a}`);
      }
      if (Array.isArray(exp.technologies) && exp.technologies.length) {
        lines.push(`Technologies: ${exp.technologies.join(', ')}`);
      }
    }
  }

  const education = (data.education as any[]) || [];
  if (education.length) {
    lines.push('', 'EDUCATION');
    for (const edu of education) {
      lines.push(`${edu.degree} – ${edu.institution}${edu.location ? ', ' + edu.location : ''}`);
      if (edu.graduationDate) lines.push(edu.graduationDate);
      if (edu.gpa) lines.push(`GPA: ${edu.gpa}`);
    }
  }

  const skills = (data.skills as any[]) || [];
  if (skills.length) {
    lines.push('', 'SKILLS');
    // Group by category
    const byCategory: Record<string, string[]> = {};
    for (const s of skills) {
      const cat = s.category || 'Other';
      (byCategory[cat] = byCategory[cat] || []).push(s.name);
    }
    for (const [cat, names] of Object.entries(byCategory)) {
      lines.push(`${cat}: ${names.join(', ')}`);
    }
  }

  const certs = (data.certifications as any[]) || [];
  if (certs.length) {
    lines.push('', 'CERTIFICATIONS');
    for (const c of certs) {
      lines.push(`${c.name} – ${c.issuer}${c.date ? ' (' + c.date + ')' : ''}`);
    }
  }

  const projects = (data.projects as any[]) || [];
  if (projects.length) {
    lines.push('', 'PROJECTS');
    for (const p of projects) {
      lines.push(p.title + (p.role ? ` – ${p.role}` : ''));
      if (Array.isArray(p.description)) {
        for (const d of p.description) lines.push(`• ${d}`);
      }
      if (Array.isArray(p.technologies) && p.technologies.length) {
        lines.push(`Technologies: ${p.technologies.join(', ')}`);
      }
    }
  }

  const languages = (data.languages as any[]) || [];
  if (languages.length) {
    lines.push('', 'LANGUAGES');
    lines.push(languages.map((l: any) => `${l.name} (${l.proficiency})`).join(', '));
  }

  return lines.join('\n').trim();
}

function stripMarkdown(text: string): string {
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

async function createResumeFile(ctx: WorkflowContext, resumeText: string, jobId: string): Promise<{ pdfPath: string; docxPath: string }> {
  const jobDir = getJobArtifactDir(ctx, 'seek', jobId);
  const docxPath = path.join(jobDir, 'resume.docx');
  const pdfPath = path.join(jobDir, 'resume.pdf');

  const paragraphs = resumeText.split('\n').map(line =>
    new Paragraph({
      children: [new TextRun(line)]
    })
  );

  const doc = new Document({
    sections: [{
      properties: {},
      children: paragraphs
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buffer);
  printLog(`💾 Created: resume.docx`);

  const pdfDoc = new PDFDocument();
  const stream = fs.createWriteStream(pdfPath);
  pdfDoc.pipe(stream);
  pdfDoc.fontSize(12).text(resumeText, { align: 'left' });
  pdfDoc.end();

  await new Promise<void>((resolve) => stream.on('finish', () => resolve()));
  printLog(`💾 Created: resume.pdf`);

  return { pdfPath, docxPath };
}

/**
 * Returns true when the file input's accept attribute explicitly requires
 * a Word format and does not allow PDF.
 */
function inputPrefersDocx(acceptAttr: string): boolean {
  if (!acceptAttr) return false;
  const lower = acceptAttr.toLowerCase();
  const hasPdf = lower.includes('.pdf') || lower.includes('application/pdf');
  const hasDocx =
    lower.includes('.docx') ||
    lower.includes('.doc') ||
    lower.includes('wordprocessingml') ||
    lower.includes('msword');
  return hasDocx && !hasPdf;
}

async function resolveResumeText(ctx: WorkflowContext, preferBase = false): Promise<string> {
  const userEmail = String((ctx as any)?.config?.formData?.email || '').trim();
  if (!userEmail) {
    throw new Error('Missing user email. Canonical resume lookup requires email in config.');
  }
  const preferredResumeFileName = String(((ctx as any)?.config?.formData?.resumeFileName || '')).trim();

  // When preferBase is set, try the Resume Builder JSON first
  if (preferBase) {
    const baseData = resolveBaseResumeJson(userEmail);
    if (baseData) {
      printLog(`📄 Using Resume Builder base resume JSON`);
      const text = extractTextFromResumeJson(baseData);
      if (text) {
        printLog(`📄 Extracted ${text.length} chars from base resume JSON`);
        return text;
      }
      printLog(`⚠️ Base resume JSON produced no text; falling back to canonical uploaded resume`);
    } else {
      printLog(`⚠️ No base-resume JSON found on disk; falling back to canonical uploaded resume`);
    }
  }

  // Resolve the actual file path (PDF/DOCX — binary, cannot be read as UTF-8 directly)
  const { filename, filePath } = resolveCanonicalResumePath(userEmail, preferredResumeFileName);
  printLog(`📄 Extracting text from canonical resume: ${filename}`);

  // POST the binary file to /api/upload to get properly extracted plain text
  const { getBearerHeader } = await import('../../core/api_client.js');
  const config = { baseUrl: process.env.API_BASE || 'http://localhost:3000' };
  const binary = (await import('fs')).readFileSync(filePath);
  const ext = (await import('path')).extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword'
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const formData = new FormData();
  formData.append('userId', userEmail);
  formData.append('file', new Blob([binary], { type: mimeType }), filename);

  const authHeader = await getBearerHeader();
  const response = await fetch(`${config.baseUrl}/api/upload`, {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Failed to extract resume text via /api/upload: HTTP ${response.status}`);
  }
  const data = await response.json();
  const content = typeof data?.content === 'string' ? data.content.trim() : '';
  if (!content) {
    throw new Error(`Resume text extraction returned empty content for ${filename}`);
  }
  printLog(`📄 Extracted ${content.length} chars from ${filename}`);
  return content;
}

async function generateAIResume(ctx: WorkflowContext): Promise<string> {
  let jobData: any = {};
  if (ctx.currentJobFile) {
    jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf8'));
  }

  if (!jobData.title || !jobData.company) {
    throw new Error("No job data available - cannot generate resume");
  }

  const jobId = jobData.jobId || 'unknown';
  printLog(`📝 Tailoring resume for: ${jobData.title} at ${jobData.company}`);

  const resumeText = await resolveResumeText(ctx, true);

  const requestBody = {
    job_id: `seek_${jobId}`,
    job_details: jobData.details || `${jobData.title} at ${jobData.company}`,
    resume_text: resumeText,
    useAi: "deepseek-chat",

    // Required tracking fields per API docs
    platform: "seek",
    platform_job_id: jobId,
    job_title: jobData.title || '',
    company: jobData.company || '',

    // Embed the actual resume text directly in the prompt so the AI cannot ignore it
    prompt: `You are a resume enhancement specialist.

--- CANDIDATE'S ACTUAL RESUME (this is the ONLY source of truth) ---
${resumeText}
--- END OF RESUME ---

ABSOLUTE RULES — violation of any of these is not acceptable:
1. Copy the candidate's full name, address, phone, email, and all contact details EXACTLY as they appear above. Do not alter, replace, or omit any of them.
2. Copy every job title, employer name, employment date, education institution, degree, and graduation date EXACTLY as they appear above. Do not change or invent any of these.
3. Do NOT invent, add, or infer any experience, skill, achievement, project, or qualification that is not in the resume above.
4. Your ONLY permitted actions are: reorder sections, rephrase existing descriptions using stronger action verbs, and weave in relevant keywords from the job description.

Tailor this resume for the Seek job posting. Optimize for ATS by including relevant keywords from the job description. Highlight experience and skills that directly match the job requirements.`
  };

  const jobDir = getJobArtifactDir(ctx, 'seek', jobId);

  fs.writeFileSync(
    path.join(jobDir, 'resume_request.json'),
    JSON.stringify(requestBody, null, 2)
  );

  printLog("📡 Calling POST /api/resume to generate AI-tailored resume...");
  const { apiRequest } = await import('../../core/api_client');
  const data = await apiRequest('/api/resume', 'POST', requestBody);

  fs.writeFileSync(
    path.join(jobDir, 'resume_response.json'),
    JSON.stringify(data, null, 2)
  );

  if (data.resume) {
    const resume = stripMarkdown(data.resume);
    printLog(`✅ AI resume received from API (${resume.length} chars)`);
    return resume;
  } else {
    throw new Error(`No resume field in API response. success=${data.success}, error=${data.error}`);
  }
}

/**
 * Shared upload logic: make the file input interactable, send the file path,
 * verify acceptance, and wait for the upload to complete.
 */
async function uploadResumeFile(
  driver: WorkflowContext['driver'],
  fileInput: Awaited<ReturnType<WorkflowContext['driver']['findElement']>>,
  uploadPath: string
): Promise<void> {
  // Make CSS-hidden file input interactable (Seek hides it with display:none)
  await driver.executeScript(`
    const el = arguments[0];
    el.style.display = 'block';
    el.style.visibility = 'visible';
    el.style.opacity = '1';
    el.removeAttribute('hidden');
  `, fileInput);

  await fileInput.sendKeys(uploadPath);

  // Verify the file was actually accepted by the input element
  const filesLength = await driver.executeScript<number>(
    'return arguments[0].files ? arguments[0].files.length : -1;',
    fileInput
  );
  if (!filesLength || filesLength < 1) {
    throw new Error('File was not accepted by the input element after sendKeys');
  }
  printLog(`✅ File accepted by input (files.length=${filesLength})`);

  // Wait for the upload loading indicator to clear, falling back to a fixed sleep
  try {
    await driver.wait(async () => {
      const loading = await driver.executeScript<boolean>(`
        const spinner = document.querySelector('[data-testid="file-upload-loading"], [data-testid="loading-indicator"], .loading-spinner');
        return !spinner;
      `);
      return loading;
    }, 15000, 'Upload spinner did not clear within 15 s');
    printLog('✅ Upload loading indicator cleared');
  } catch {
    printLog('⚠️ Could not detect upload completion, waiting 5 s...');
    await driver.sleep(5000);
  }
}

// Handle Resume Upload/Selection (Choose Documents step)
export async function* handleResumeSelection(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const rewriteResume = Boolean((ctx as any)?.config?.formData?.rewriteResume);
    printLog(`\n--- Step: Upload Resume (rewriteResume=${rewriteResume}) ---`);

    // pdfPath is the default upload; docxPath is the fallback if the input demands Word format
    let pdfPath: string;
    let docxPath: string | null = null;

    if (rewriteResume) {
      printLog("🤖 Generating AI-tailored resume via POST /api/resume ...");
      const resumeText = await generateAIResume(ctx);

      let jobData: any = {};
      if (ctx.currentJobFile) {
        jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf8'));
      }
      const files = await createResumeFile(ctx, resumeText, jobData.jobId || 'unknown');
      pdfPath = files.pdfPath;
      docxPath = files.docxPath;

      // Guard: verify the generated PDF exists and is non-empty
      if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
        throw new Error(`Resume file is missing or empty: ${pdfPath}`);
      }
      printLog(`📄 Resume file ready: ${pdfPath} (${fs.statSync(pdfPath).size} bytes)`);
    } else {
      printLog("📄 Using original uploaded resume file (no AI rewrite)...");
      const userEmail = String((ctx as any)?.config?.formData?.email || '').trim();
      const preferredResumeFileName = String(((ctx as any)?.config?.formData?.resumeFileName || '')).trim();
      const { filename, filePath } = resolveCanonicalResumePath(userEmail, preferredResumeFileName);
      printLog(`📄 Using canonical resume: ${filename} at ${filePath}`);

      // Guard: verify the canonical file exists and is non-empty
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        throw new Error(`Resume file is missing or empty: ${filePath}`);
      }
      printLog(`📄 Resume file ready: ${filePath} (${fs.statSync(filePath).size} bytes)`);

      // Use the canonical file as-is; if it's a docx, also expose it as the docx fallback
      const ext = path.extname(filename).toLowerCase();
      if (ext === '.pdf') {
        pdfPath = filePath;
      } else {
        // docx/doc — treat it as both paths so format selection below still works
        pdfPath = filePath;
        docxPath = filePath;
      }
    }

    // Step 3: Locate and click "Upload a resumé" radio button using native Selenium click.
    // JS executeScript clicks do not reliably fire React synthetic events, so the file input
    // would never render. Native WebDriver click sends a real browser event that React handles.
    printLog("🔍 Looking for upload resume option...");

    let fileInput: Awaited<ReturnType<WorkflowContext['driver']['findElement']>> | null = null;

    try {
      // Wait up to 5 s for the radio button to be present
      const uploadRadio = await ctx.driver.wait(
        until.elementLocated(By.css('input[data-testid="resume-method-upload"][value="upload"]')),
        5000,
        'Upload radio not found within 5 s'
      );
      printLog('✅ Upload radio button found — clicking natively...');

      // Scroll into view and native-click so React's synthetic event system fires
      await ctx.driver.executeScript('arguments[0].scrollIntoView({block:"center"});', uploadRadio);
      await uploadRadio.click();
      printLog('✅ Upload resume option selected');

      // Wait up to 10 s for the file input to appear after the React state update
      fileInput = await ctx.driver.wait(
        until.elementLocated(By.css('input[data-testid="file-input"][type="file"]')),
        10000,
        'File input did not appear within 10 s after clicking upload radio'
      );
      printLog('✅ File input located');
    } catch (radioErr) {
      printLog(`⚠️ Upload radio click/wait failed: ${radioErr}`);
      printLog('⚠️ Checking if file input is already visible without a radio click...');
      try {
        // Seek may show the file input directly when no existing resume is on file
        fileInput = await ctx.driver.wait(
          until.elementLocated(By.css('input[data-testid="file-input"][type="file"]')),
          5000
        );
        printLog('📄 File input found directly (no radio needed)');
      } catch {
        printLog('❌ No file input found at all — falling back to dropdown');
      }
    }

    if (fileInput) {
      printLog("📤 Uploading resume file...");
      try {
        // Choose PDF by default; switch to DOCX only if the input explicitly excludes PDF
        const acceptAttr = (await fileInput.getAttribute('accept')) || '';
        const useDocx = inputPrefersDocx(acceptAttr) && docxPath !== null;
        const uploadPath = useDocx ? docxPath! : pdfPath;
        printLog(`📄 Uploading as ${useDocx ? 'DOCX' : 'PDF'} (accept="${acceptAttr}")`);

        await uploadResumeFile(ctx.driver, fileInput, uploadPath);
        printLog("✅ Resume uploaded successfully — proceeding to fill cover letter");

        yield "resume_selected";
        return;
      } catch (uploadError) {
        printLog(`⚠️ File upload failed: ${uploadError}`);
        printLog("⚠️ Falling back to existing resume dropdown selection...");
      }
    }

    // Fallback: try to select an existing resume from the dropdown
    printLog("📋 Checking for existing resume options...");
    const resumeSelected = await ctx.driver.executeScript(`
      const select = document.querySelector('select[data-testid="select-input"]');
      if (select && select.options && select.options.length > 1) {
        for (let i = 1; i < select.options.length; i++) {
          if (select.options[i].value && select.options[i].value !== '') {
            select.value = select.options[i].value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            console.log('Selected resume:', select.options[i].text);
            return true;
          }
        }
      }
      return false;
    `);

    if (resumeSelected) {
      await ctx.driver.sleep(1000);
      printLog("✅ Selected existing resume from dropdown");
      yield "resume_selected";
      return;
    }

    printLog("ℹ️ No upload option or existing resume found - will skip resume");
    yield "resume_not_required";

  } catch (error) {
    printLog(`💥 Resume handling error: ${error}`);
    if (error instanceof Error) {
      printLog(`💥 Error stack: ${error.stack}`);
    }
    yield "resume_selection_error";
  }
}