import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import fs from 'fs';
import path from 'path';

const API_BASE = env.API_BASE || process.env.API_BASE || 'http://localhost:3000';
const ALLOWED_RESUME_EXTENSIONS = ['.doc', '.docx', '.pdf'];

/** @param {string} text */
function stripMarkdown(text) {
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
/**
 * @typedef {Object} ManagedResumeEntry
 * @property {string=} feature
 * @property {string=} filename
 * @property {string=} relativePath
 * @property {string=} relative_path
 * @property {string|number=} updatedAt
 * @property {string|number=} updated_at
 */

/** @param {string} name */
function isSupportedResumeFile(name) {
  const lower = String(name || '').toLowerCase();
  return ALLOWED_RESUME_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * @param {string} userId
 * @returns {string}
 */
function sanitizeSegment(userId) {
  const raw = String(userId || '');
  let out = '';
  for (const ch of raw) {
    out += /^[a-zA-Z0-9._-]$/.test(ch) ? ch : '_';
  }
  const trimmed = out.replace(/^_+|_+$/g, '');
  return trimmed || 'unknown';
}

function getAppDataRoot() {
  const home = process.env.HOME || '';
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'FinalBoss');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'FinalBoss');
  }
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'finalboss');
}

/** @param {string} userId */
function getManagedIndexPath(userId) {
  return path.join(getAppDataRoot(), 'users', sanitizeSegment(userId), 'index', 'files-index.json');
}

/** @param {string} userId */
function getManagedUserRoot(userId) {
  return path.join(getAppDataRoot(), 'users', sanitizeSegment(userId));
}

/** @param {string} userId */
function loadManagedIndex(userId) {
  const indexPath = getManagedIndexPath(userId);
  if (!fs.existsSync(indexPath)) return { entries: [] };
  const raw = fs.readFileSync(indexPath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    entries: Array.isArray(parsed?.entries) ? parsed.entries : []
  };
}

/** @param {string} userId @param {{ relativePath?: string, relative_path?: string }} entry */
function resolveManagedEntryPath(userId, entry) {
  const userRoot = getManagedUserRoot(userId);
  const rel = String(entry?.relativePath || entry?.relative_path || '');
  if (!rel || path.isAbsolute(rel)) {
    throw new Error('Managed resume path is invalid.');
  }
  const normalizedRel = rel.split('/').join(path.sep);
  const parts = normalizedRel.split(path.sep);
  if (parts[0] !== 'storage' || parts.includes('..')) {
    throw new Error('Managed resume path is unsafe.');
  }
  const full = path.join(userRoot, normalizedRel);
  if (!full.startsWith(userRoot)) {
    throw new Error('Managed resume path escaped user root.');
  }
  return full;
}

/** @param {string} filename */
function guessMimeType(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.doc')) return 'application/msword';
  return 'application/octet-stream';
}

/** @param {string} userId */
function listManagedResumeEntries(userId) {
  const index = loadManagedIndex(userId);
  /** @type {ManagedResumeEntry[]} */
  const entries = index.entries
    .filter((/** @type {ManagedResumeEntry} */ entry) => entry?.feature === 'resume' && isSupportedResumeFile(String(entry?.filename || '')))
    .sort((/** @type {ManagedResumeEntry} */ a, /** @type {ManagedResumeEntry} */ b) => Number(b?.updatedAt || b?.updated_at || 0) - Number(a?.updatedAt || a?.updated_at || 0));

  if (entries.length === 0) {
    throw new Error(`No managed .doc/.docx/.pdf resume files found for userId ${userId}`);
  }

  return entries;
}

/** @param {string} userId @param {string} authHeader @param {string} [preferredResumeFileName] */
async function loadResumeFromManagedStorage(userId, authHeader, preferredResumeFileName = '') {
  if (!userId) {
    throw new Error('Missing userId. Cannot resolve managed resume.');
  }

  const entries = listManagedResumeEntries(userId);
  const preferred = preferredResumeFileName
    ? entries.find((/** @type {ManagedResumeEntry} */ entry) => String(entry?.filename || '') === preferredResumeFileName)
    : undefined;
  const resumeNamed = entries.find((/** @type {ManagedResumeEntry} */ entry) => String(entry?.filename || '').toLowerCase().includes('resume'));
  /** @type {ManagedResumeEntry[]} */
  const orderedCandidates = [];
  const seen = new Set();
  for (const candidate of [preferred, resumeNamed, ...entries]) {
    if (!candidate) continue;
    const key = String(candidate.filename || candidate.relativePath || candidate.relative_path || '');
    if (seen.has(key)) continue;
    seen.add(key);
    orderedCandidates.push(candidate);
  }
  /** @type {string[]} */
  const failures = [];

  for (const selected of orderedCandidates) {
    const selectedName = String(selected?.filename || '').trim();
    if (!selectedName) continue;

    try {
      const fullPath = resolveManagedEntryPath(userId, selected);
      if (!fs.existsSync(fullPath)) {
        failures.push(`${selectedName}: managed file missing on disk`);
        continue;
      }

      const binary = fs.readFileSync(fullPath);
      const mimeType = guessMimeType(selectedName);
      const formData = new FormData();
      formData.append('userId', userId);
      formData.append('file', new Blob([binary], { type: mimeType }), selectedName);

      const fileRes = await fetch(
        `${API_BASE}/api/upload`,
        {
          method: 'POST',
          headers: {
            Authorization: authHeader
          },
          body: formData
        }
      );
      if (!fileRes.ok) {
        const fileErr = await fileRes.json().catch(() => ({}));
        failures.push(`${selectedName}: ${fileErr?.error || `extract failed (${fileRes.status})`}`);
        continue;
      }
      const fileData = await fileRes.json();
      const content = typeof fileData?.content === 'string' ? fileData.content.trim() : '';
      if (!content) {
        failures.push(`${selectedName}: extracted content is empty`);
        continue;
      }
      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${selectedName}: ${message}`);
    }
  }

  throw new Error(
    `Unable to extract any managed resume for userId ${userId}. ` +
      `Tried ${orderedCandidates.length} file(s). ` +
      `Failures: ${failures.join(' | ')}`
  );
}

/** @param {string} userId */
async function loadContactProfile(userId) {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const configPath = path.join(process.cwd(), 'src/bots/user-bots-config.json');
    if (!fs.existsSync(configPath)) return null;

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const formData = parsed?.formData || {};
    const contactProfile = {
      full_name: String(formData.fullName || '').trim(),
      email: String(formData.email || userId || '').trim(),
      phone: String(formData.phone || '').trim(),
      resume_file_name: String(formData.resumeFileName || '').trim()
    };

    if (!contactProfile.full_name && !contactProfile.email && !contactProfile.phone) {
      return null;
    }
    return contactProfile;
  } catch {
    return null;
  }
}

export async function POST({ request }) {
  try {
    const body = await request.json();

    // Extract data from request
    const { jobDescription, userId, jobId } = body;

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

    // Strict mode: only use FinalBoss managed resume associated with this user.
    const contactProfile = await loadContactProfile(userId);
    const resumeText = await loadResumeFromManagedStorage(
      userId,
      authHeader,
      contactProfile?.resume_file_name || ''
    );

    // Generate a job_id if not provided (required by corpus-rag API)
    const generatedJobId = jobId || `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Prepare request for corpus-rag API
    const requestBody = {
      job_id: generatedJobId,  // Required field
      job_details: jobDescription,
      resume_text: resumeText,
      useAi: "deepseek-chat",
      platform: "manual",
      job_title: "",
      company: "",
      strictQuality: true,
      qualityThreshold: 92,
      strictQualityRetries: 1,
      contact_profile: contactProfile,
      prompt: `Write a compelling, professional cover letter for this job posting.

STRICT RULES — these override everything else:
- NEVER invent, fabricate, or modify any factual information
- Only reference experiences, skills, and achievements that are explicitly stated in the provided resume
- Do NOT fabricate projects, companies, dates, or accomplishments
- Do NOT include a LinkedIn URL or any other URL anywhere in the letter

Highlight relevant experience and skills that match the job requirements.
Keep it concise (300-400 words) and personalized.
Focus on demonstrating value and enthusiasm for the role.`
    };

    console.log('🔄 Calling corpus-rag API for cover letter generation...');

    // Call corpus-rag API with authentication
    const response = await fetch(`${API_BASE}/api/cover_letter`, {
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
        error: data.error || 'Failed to generate cover letter'
      }, { status: response.status });
    }

    if (data.cover_letter) {
      console.log('✅ Cover letter generated successfully');
      return json({
        success: true,
        coverLetter: stripMarkdown(data.cover_letter),
        metadata: {
          provider: 'deepseek-chat',
          timestamp: new Date().toISOString(),
          qualityScore: data.qualityScore,
          qualityControl: data.qualityControl,
          contactProfileUsed: data.contactProfileUsed,
          warning: data.warning
        }
      });
    } else {
      return json({
        success: false,
        error: 'No cover letter returned from API'
      }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ Cover letter generation error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return json({
      success: false,
      error: message || 'Internal server error'
    }, { status: 500 });
  }
}
