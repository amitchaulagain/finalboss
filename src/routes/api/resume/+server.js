import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

const API_BASE = env.API_BASE || process.env.API_BASE || 'http://localhost:3000';
const ALLOWED_RESUME_EXTENSIONS = ['.doc', '.docx', '.pdf'];

/** @param {string} name */
function isSupportedResumeFile(name) {
  const lower = String(name || '').toLowerCase();
  return ALLOWED_RESUME_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** @param {string} userId @param {string} authHeader @param {string} [preferredResumeFileName] */
async function loadResumeFromUploads(userId, authHeader, preferredResumeFileName = '') {
  if (!userId) {
    throw new Error('Missing userId. Cannot resolve uploaded resume.');
  }
  const listRes = await fetch(`${API_BASE}/api/upload?userId=${encodeURIComponent(userId)}`, {
    method: 'GET',
    headers: {
      Authorization: authHeader
    }
  });
  if (!listRes.ok) {
    throw new Error(`Failed to list uploaded resumes (${listRes.status})`);
  }
  const listData = await listRes.json();
  const files = Array.isArray(listData?.files) ? /** @type {Array<{name?: string}>} */ (listData.files) : [];
  const names = files
    .map((f) => f?.name)
    .filter((name) => typeof name === 'string' && isSupportedResumeFile(name))
    .map((name) => String(name));
  if (names.length === 0) {
    throw new Error(`No uploaded .doc/.docx/.pdf resume files found for userId ${userId}`);
  }

  const selectedName =
    (preferredResumeFileName && names.includes(preferredResumeFileName) ? preferredResumeFileName : '') ||
    names.find((name) => String(name).toLowerCase().includes('resume')) ||
    names[0];

  const fileRes = await fetch(
    `${API_BASE}/api/upload?userId=${encodeURIComponent(userId)}&filename=${encodeURIComponent(selectedName)}`,
    {
      method: 'GET',
      headers: {
        Authorization: authHeader
      }
    }
  );
  if (!fileRes.ok) {
    const fileErr = await fileRes.json().catch(() => ({}));
    throw new Error(fileErr?.error || `Failed to load uploaded resume file (${fileRes.status})`);
  }
  const fileData = await fileRes.json();
  const content = typeof fileData?.content === 'string' ? fileData.content.trim() : '';
  if (!content) {
    throw new Error(`Uploaded resume file is empty for userId ${userId}`);
  }
  return content;
}

export async function POST({ request }) {
  try {
    const body = await request.json();

    // Extract data from request
    const { jobDescription, userId, enhancementFocus = 'general', resumeText: providedResumeText } = body;

    // Get auth token from request header
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return json({
        success: false,
        error: 'Authentication required'
      }, { status: 401 });
    }

    if (!jobDescription) {
      return json({
        success: false,
        error: 'Job description is required'
      }, { status: 400 });
    }

    // Use provided resume text or read from uploaded supported document
    let resumeText = providedResumeText;
    
    if (!resumeText) {
      const preferredResumeFileName = String(body.resumeFileName || '').trim();
      resumeText = await loadResumeFromUploads(userId, authHeader, preferredResumeFileName);
    }

    // Generate a job_id if not provided (required by corpus-rag API)
    const jobId = body.jobId || `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Prepare request for corpus-rag API
    const requestBody = {
      job_id: jobId,
      job_details: jobDescription,
      resume_text: resumeText,
      useAi: "deepseek-chat",
      platform: "manual",
      job_title: "",
      company: "",
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

Task:
1. Calculate ORIGINAL FIT SCORE (0-100%) based on current resume match
2. Enhance the resume with focus on: ${enhancementFocus}
3. Calculate ENHANCED FIT SCORE (0-100%) after improvements
4. Output the complete enhanced resume text

Format your response:
- Original Fit Score: XX%
- Enhanced Fit Score: XX%
- [Complete enhanced resume text below]`
    };

    console.log('🔄 Calling corpus-rag API for resume enhancement...');

    // Call corpus-rag API with authentication
    const response = await fetch(`${API_BASE}/api/resume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,  // Forward auth token
        'X-Resume-Source': 'finalboss-managed'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Corpus-rag API error:', data);
      return json({
        success: false,
        error: data.error || 'Failed to enhance resume'
      }, { status: response.status });
    }

    if (data.resume) {
      console.log('✅ Resume enhanced successfully');

      // Parse fit scores from the response
      const enhancedResumeText = data.resume;
      // Accept both plain and markdown-bold labels, e.g.
      // "Original Fit Score: 85%" or "**Original Fit Score:** 85%"
      const originalFitMatch = enhancedResumeText.match(/\*{0,2}\s*Original Fit Score\s*:?\s*\*{0,2}\s*(\d+)%/i);
      const enhancedFitMatch = enhancedResumeText.match(/\*{0,2}\s*Enhanced Fit Score\s*:?\s*\*{0,2}\s*(\d+)%/i);

      return json({
        success: true,
        enhancedResume: enhancedResumeText,
        originalFitScore: originalFitMatch ? parseInt(originalFitMatch[1]) : null,
        enhancedFitScore: enhancedFitMatch ? parseInt(enhancedFitMatch[1]) : null,
        metadata: {
          provider: 'deepseek-chat',
          focus: enhancementFocus,
          timestamp: new Date().toISOString()
        }
      });
    } else {
      return json({
        success: false,
        error: 'No resume returned from API'
      }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ Resume enhancement error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return json({
      success: false,
      error: message || 'Internal server error'
    }, { status: 500 });
  }
}
