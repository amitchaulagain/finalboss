// @ts-nocheck
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { Document, Paragraph, TextRun, Packer } from 'docx';
import PDFDocument from 'pdfkit';
import { resolveCanonicalResumePath } from '../../../lib/canonical-resume';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const printLog = (message) => {
  console.log(message);
};

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

async function createResumeFile(resumeText, jobId) {
  const jobDir = path.join(__dirname, '../../jobs', jobId);
  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }

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
  pdfDoc.fontSize(12).text(resumeText, {
    align: 'left'
  });
  pdfDoc.end();

  await new Promise((resolve) => stream.on('finish', resolve));
  printLog(`💾 Created: resume.pdf`);

  return docxPath;
}

async function resolveResumeText(ctx) {
  const userEmail = String(ctx?.config?.formData?.email || '').trim();
  if (!userEmail) {
    throw new Error('Missing user email. Canonical resume lookup requires email in config.');
  }
  const preferredResumeFileName = String(ctx?.config?.formData?.resumeFileName || '').trim();

  // Resolve the actual file path (PDF/DOCX — binary, cannot be read as UTF-8 directly)
  const { filename, filePath } = resolveCanonicalResumePath(userEmail, preferredResumeFileName);
  printLog(`📄 Extracting text from canonical resume: ${filename}`);

  // POST the binary file to /api/upload to get properly extracted plain text
  const { getBearerHeader } = await import('../../core/api_client.js');
  const baseUrl = process.env.API_BASE || 'http://localhost:3000';
  const binary = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword'
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const formData = new FormData();
  formData.append('userId', userEmail);
  formData.append('file', new Blob([binary], { type: mimeType }), filename);

  const authHeader = await getBearerHeader();
  const response = await fetch(`${baseUrl}/api/upload`, {
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

async function generateAIResume(ctx) {
  let jobData = {};
  if (ctx.currentJobFile) {
    jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf8'));
  }

  if (!jobData.title || !jobData.company) {
    throw new Error("No job data available - cannot generate resume");
  }

  const jobId = jobData.jobId || 'unknown';
  printLog("Generating AI resume...");
  printLog(`📝 Job: ${jobData.title} at ${jobData.company}`);

  const resumeText = await resolveResumeText(ctx);

  const requestBody = {
    job_id: `indeed_${jobId}`,
    job_details: jobData.details || `${jobData.title} at ${jobData.company}`,
    resume_text: resumeText,
    useAi: "deepseek-chat",

    // Required tracking fields per API docs
    platform: "indeed",
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

Tailor this resume for the Indeed job posting. Optimize for ATS by including relevant keywords from the job description. Highlight experience and skills that directly match the job requirements.`
  };

  const jobDir = path.join(__dirname, '../../jobs', jobId);
  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(jobDir, 'resume_request.json'),
    JSON.stringify(requestBody, null, 2)
  );

  // Use apiRequest helper for authenticated calls
  const { apiRequest } = await import('../../core/api_client.js');
  const data = await apiRequest('/api/resume', 'POST', requestBody);

  fs.writeFileSync(
    path.join(jobDir, 'resume_response.json'),
    JSON.stringify(data, null, 2)
  );

  if (data.resume) {
    printLog("✅ AI resume generated");
    const resume = stripMarkdown(data.resume);
    printLog(`📄 Length: ${resume.length} chars`);
    return resume;
  } else {
    throw new Error('No resume field returned from API');
  }
}

// Handle Resume Upload/Selection (Choose Documents step)
export async function* handleResumeSelection(ctx) {
  try {
    printLog("Handling resume with AI generation and upload...");

    // Step 1: Generate AI resume
    printLog("🤖 Generating AI-tailored resume...");
    const resumeText = await generateAIResume(ctx);

    // Step 2: Create resume file
    let jobData = {};
    if (ctx.currentJobFile) {
      jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf8'));
    }
    const resumeFilePath = await createResumeFile(
      resumeText,
      jobData.jobId || 'unknown'
    );

    // Step 3: Click "Upload a resumé" radio button using Playwright
    printLog("🔍 Looking for upload resume option...");

    const uploadRadioClicked = await ctx.page.evaluate(`
      // Find and click the "Upload a resumé" radio button
      const uploadRadio = document.querySelector('input[data-testid="resume-method-upload"][value="upload"]');
      if (uploadRadio) {
        uploadRadio.click();
        uploadRadio.checked = true;
        uploadRadio.dispatchEvent(new Event('change', { bubbles: true }));
        uploadRadio.dispatchEvent(new Event('click', { bubbles: true }));
        console.log('Upload radio button clicked');
        return true;
      }
      return false;
    `);

    if (uploadRadioClicked) {
      printLog("✅ Upload resume option selected");
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for UI to update

      // Step 4: Upload the file using Playwright's setInputFiles
      printLog("📤 Uploading resume file...");

      try {
        // Find the hidden file input - it should be visible now
        const fileInput = ctx.page.locator('input[data-testid="file-input"][type="file"]').first();
        
        // Use Playwright's setInputFiles method
        await fileInput.setInputFiles(resumeFilePath);
        printLog("✅ Resume file uploaded successfully");

        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for upload to process

        yield "resume_selected";
        return;
      } catch (uploadError) {
        printLog(`⚠️ File upload failed: ${uploadError}`);
        printLog("Falling back to existing resume selection...");
      }
    } else {
      printLog("⚠️ Upload resume radio button not found");
    }

    // Step 4: Fallback - try to select existing resume
    printLog("📋 Checking for existing resume options...");
    const resumeSelected = await ctx.page.evaluate(`
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
      await new Promise(resolve => setTimeout(resolve, 1000));
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
