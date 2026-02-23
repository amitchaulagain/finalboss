/**
 * Job Application Recorder – loosely coupled client for corpus-rag Job Applications API.
 * Builds payload from local job file + job dir and POSTs to backend. No DB dependency.
 */
import * as fs from 'fs';
import * as path from 'path';
import { apiRequest } from './api_client.js';
import { logger } from './logger.js';

/** One API call token record for job-applications payload. */
export interface ApiCallTokenRecord {
  endpoint: string;
  timestamp?: string;
  aiProvider?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  processingTime?: number;
}

/** Contract payload for POST /api/job-applications (matches corpus-rag API). */
export interface JobApplicationPayload {
  platform: 'seek' | 'linkedin' | 'indeed' | 'other';
  platformJobId: string;
  title: string;
  company: string;
  url?: string;
  description?: string;
  location?: string;
  salary?: string;
  jobType?: string;
  workMode?: string;
  postedDate?: string;
  closingDate?: string;
  hrContact?: { name?: string; email?: string; phone?: string };
  requiredSkills?: string[];
  requiredExperience?: string;
  jobDetails?: Record<string, unknown>;
  application: {
    coverLetter?: string;
    tailoredResume?: string;
    resumeSource?: 'ai-enhanced' | 'original';
    resumePdfPath?: string;
    questionAnswers?: Array<{
      question: string;
      answer: string;
      type?: string;
      options?: string[];
      selected?: number | string | string[] | null;
    }>;
    apiCalls?: ApiCallTokenRecord[];
  };
  source?: { jobFile?: string; jobDir?: string; clientFolder?: string };
}

export interface RecordJobApplicationInput {
  /** Path to the job JSON file (e.g. .../jobs/company_jobId.json or .../jobs/linkedinjobs/jobId/job_details.json). */
  jobFilePath: string;
  /** Path to the per-application dir (e.g. .../jobs/jobId) containing cover_letter_response.json, qna.json, resume.* */
  jobDirPath: string;
  /** Platform for the payload; defaults to 'seek' if omitted. */
  platform?: 'seek' | 'linkedin' | 'indeed' | 'other';
}

const printLog = (msg: string) => console.log(msg);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readJsonFile(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getCandidateJobDirs(primaryDir: string, platform: 'seek' | 'linkedin' | 'indeed' | 'other', jobId: string): string[] {
  const dirs = [primaryDir];
  if (platform === 'linkedin') {
    dirs.push(path.join(process.cwd(), 'jobs', 'linkedinjobs', jobId));
  } else if (platform === 'seek') {
    dirs.push(path.join(process.cwd(), 'src', 'bots', 'jobs', jobId));
  }
  return Array.from(new Set(dirs));
}

function readJsonFromDirs(jobDirs: string[], filename: string): any | null {
  for (const dir of jobDirs) {
    const p = path.join(dir, filename);
    const data = readJsonFile(p);
    if (data != null) return data;
  }
  return null;
}

/**
 * Read cover letter text from jobDir/cover_letter_response.json.
 */
function readCoverLetter(jobDirs: string[]): string | undefined {
  const data = readJsonFromDirs(jobDirs, 'cover_letter_response.json');
  if (!data || typeof data !== 'object') return undefined;
  const content = data.cover_letter ?? data.coverLetter;
  return typeof content === 'string' && content.trim() ? content.trim() : undefined;
}

/**
 * Parse markdown-ish Q&A block from qna_response.answers:
 * "**Question 1:** ... **Answer:** ...".
 */
function parseAnswersTextBlock(raw: string): string[] {
  const answers: string[] = [];
  const blockRegex = /\*\*Question\s*\d+\s*:\*\*[\s\S]*?(?:\*\*Answer:\*\*|Answer:)\s*([\s\S]*?)(?=\n\s*\*\*Question\s*\d+\s*:\*\*|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(raw)) !== null) {
    const answer = (match[1] || '').trim();
    if (answer) answers.push(answer);
  }
  if (answers.length > 0) return answers;
  const fallback = raw.trim();
  return fallback ? [fallback] : [];
}

function normalizeQuestionAnswer(item: any): {
  question: string;
  answer: string;
  type?: string;
  options?: string[];
  selected?: number | string | string[] | null;
} | null {
  const question = typeof item?.question === 'string'
    ? item.question
    : typeof item?.q === 'string'
      ? item.q
      : '';

  let answerValue: unknown = item?.answer ?? item?.a ?? item?.textAnswer ?? item?.selectedAnswer;
  if (typeof answerValue === 'number' && Array.isArray(item?.opts) && item.opts[answerValue]) {
    answerValue = item.opts[answerValue];
  }
  if (typeof answerValue === 'number' && Array.isArray(item?.options) && item.options[answerValue]) {
    answerValue = item.options[answerValue];
  }
  if (Array.isArray(answerValue)) {
    answerValue = answerValue.map((x) => String(x)).join(', ');
  }
  const answer = typeof answerValue === 'string' ? answerValue.trim() : '';

  const options = Array.isArray(item?.options)
    ? item.options.map((x: unknown) => String(x))
    : Array.isArray(item?.opts)
      ? item.opts.map((x: unknown) => String(x))
      : undefined;

  const selected = item?.selected ?? null;
  const type = typeof item?.type === 'string' ? item.type : undefined;

  if (!question && !answer) return null;
  return { question: question.trim(), answer, ...(type ? { type } : {}), ...(options ? { options } : {}), selected };
}

/**
 * Read Q&A from qna.json first, fallback to qna_response.json + qna_request.json mapping.
 */
function readQuestionAnswers(jobDirs: string[]): Array<{
  question: string;
  answer: string;
  type?: string;
  options?: string[];
  selected?: number | string | string[] | null;
}> {
  const primary = readJsonFromDirs(jobDirs, 'qna.json');
  const primaryList = (primary?.questions ?? primary?.questionAnswers ?? []) as any[];
  const normalizedPrimary = primaryList
    .map(normalizeQuestionAnswer)
    .filter((x): x is { question: string; answer: string } => Boolean(x));
  if (normalizedPrimary.length > 0) return normalizedPrimary;

  const response = readJsonFromDirs(jobDirs, 'qna_response.json');
  const request = readJsonFromDirs(jobDirs, 'qna_request.json');
  const rawAnswers = response?.answers;
  if (!rawAnswers) return [];

  const answerList = Array.isArray(rawAnswers)
    ? rawAnswers.map((x) => String(x).trim()).filter(Boolean)
    : parseAnswersTextBlock(String(rawAnswers));

  if (answerList.length === 0) return [];

  const requestQuestions: string[] = Array.isArray(request?.questions)
    ? request.questions.map((q: any) => (typeof q?.q === 'string' ? q.q : typeof q?.question === 'string' ? q.question : '')).filter(Boolean)
    : [];

  return answerList.map((answer, index) => ({
    question: requestQuestions[index] || `Question ${index + 1}`,
    answer,
    type: 'text',
    options: [],
    selected: null
  }));
}

/**
 * Read resume data and detect whether it was AI-enhanced or the user's original.
 * AI-enhanced: resume_response.json exists with a generated resume field.
 * Original: only the canonical resume file was used directly (no AI generation).
 */
function readTailoredResume(jobDirs: string[]): {
  text?: string;
  resumeSource: 'ai-enhanced' | 'original';
  resumePdfPath?: string;
} {
  const response = readJsonFromDirs(jobDirs, 'resume_response.json');
  if (response && typeof response === 'object') {
    const fromApi = response.resume ?? response.generatedText ?? response.tailoredResume;
    if (typeof fromApi === 'string' && fromApi.trim()) {
      // Find the PDF saved alongside the AI-generated resume
      let resumePdfPath: string | undefined;
      for (const dir of jobDirs) {
        const pdf = path.join(dir, 'resume.pdf');
        if (fs.existsSync(pdf)) { resumePdfPath = pdf; break; }
      }
      return { text: fromApi.trim(), resumeSource: 'ai-enhanced', resumePdfPath };
    }
  }
  // No AI response — original resume was uploaded directly
  for (const dir of jobDirs) {
    const docx = path.join(dir, 'resume.docx');
    if (fs.existsSync(docx)) return { text: docx, resumeSource: 'original' };
    const pdf = path.join(dir, 'resume.pdf');
    if (fs.existsSync(pdf)) return { text: pdf, resumeSource: 'original' };
  }
  return { resumeSource: 'original' };
}

/**
 * Read token usage from a response JSON file (cover_letter_response, qna_response, resume_response).
 */
function readTokenUsage(
  jobDirs: string[],
  filename: string,
  endpoint: string
): ApiCallTokenRecord | null {
  const data = readJsonFromDirs(jobDirs, filename);
  if (!data || typeof data !== 'object') return null;
  const tokensUsed = data.actualTokensUsed ?? data.tokensUsed;
  const inputTokens = data.inputTokens;
  const outputTokens = data.outputTokens;
  if (tokensUsed == null && inputTokens == null && outputTokens == null) return null;
  return {
    endpoint,
    timestamp: data.timestamp ?? new Date().toISOString(),
    aiProvider: data.aiProvider ?? 'unknown',
    tokensUsed: typeof tokensUsed === 'number' ? tokensUsed : undefined,
    inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
    cost: typeof data.cost === 'number' ? data.cost : undefined,
    processingTime: typeof data.processingTime === 'number' ? data.processingTime : undefined
  };
}

/**
 * Build apiCalls array from jobDir response files (cover letter, Q&A, resume).
 */
function readApiCallsFromJobDir(jobDirs: string[]): ApiCallTokenRecord[] {
  const calls: ApiCallTokenRecord[] = [];
  const cover = readTokenUsage(jobDirs, 'cover_letter_response.json', '/api/cover_letter');
  if (cover) calls.push(cover);
  const qna = readTokenUsage(jobDirs, 'qna_response.json', '/api/questionAndAnswers');
  if (qna) calls.push(qna);
  const resume = readTokenUsage(jobDirs, 'resume_response.json', '/api/resume');
  if (resume) calls.push(resume);
  return calls;
}

/**
 * Build payload from job file + job dir (contract-only; no backend types).
 */
export function buildJobApplicationPayload(input: RecordJobApplicationInput): JobApplicationPayload | null {
  const { jobFilePath, jobDirPath, platform: inputPlatform } = input;

  if (!fs.existsSync(jobFilePath)) {
    printLog(`[JobRecorder] Job file not found: ${jobFilePath}`);
    return null;
  }

  let jobData: any;
  try {
    jobData = JSON.parse(fs.readFileSync(jobFilePath, 'utf8'));
  } catch (e) {
    printLog(`[JobRecorder] Failed to parse job file: ${e}`);
    return null;
  }

  const platformJobId = jobData.job_id || jobData.jobId || '';
  const title = jobData.title || jobData.raw_title || '';
  const company = jobData.company || '';
  const platform = inputPlatform ?? (jobFilePath.includes('linkedinjobs') ? 'linkedin' : 'seek');

  if (!platformJobId || !title || !company) {
    printLog('[JobRecorder] Job file missing jobId, title or company');
    return null;
  }

  const candidateJobDirs = getCandidateJobDirs(jobDirPath, platform, platformJobId);
  const coverLetter = readCoverLetter(candidateJobDirs);
  const questionAnswers = readQuestionAnswers(candidateJobDirs);
  const { text: tailoredResume, resumeSource, resumePdfPath } = readTailoredResume(candidateJobDirs);
  const apiCalls = readApiCallsFromJobDir(candidateJobDirs);

  // Extra job fields for Job details tab (posted, category, application_volume, etc.)
  const jobDetails: Record<string, unknown> = {};
  if (jobData.posted != null) jobDetails.posted = jobData.posted;
  if (jobData.application_volume != null) jobDetails.application_volume = jobData.application_volume;
  if (jobData.category != null) jobDetails.category = jobData.category;
  if (jobData.raw_title != null) jobDetails.raw_title = jobData.raw_title;

  return {
    platform,
    platformJobId,
    title,
    company,
    url: jobData.url,
    description: jobData.details || jobData.description,
    location: jobData.location,
    salary: jobData.salary_note || jobData.salary || jobData.category,
    jobType: jobData.work_type || jobData.jobType,
    workMode: jobData.workMode,
    postedDate: typeof jobData.posted === 'string' ? jobData.posted : undefined,
    hrContact: jobData.hrContact,
    requiredSkills: Array.isArray(jobData.requiredSkills) ? jobData.requiredSkills : undefined,
    requiredExperience: typeof jobData.requiredExperience === 'string' ? jobData.requiredExperience : undefined,
    ...(Object.keys(jobDetails).length > 0 ? { jobDetails } : {}),
    application: {
      coverLetter,
      tailoredResume,
      resumeSource,
      ...(resumePdfPath ? { resumePdfPath } : {}),
      questionAnswers,
      ...(apiCalls.length > 0 ? { apiCalls } : {})
    },
    source: {
      jobFile: jobFilePath,
      jobDir: jobDirPath,
      clientFolder: jobDirPath.includes(`${path.sep}clients${path.sep}`) ? jobDirPath.split(`${path.sep}jobs${path.sep}`)[0] : undefined
    }
  };
}

/**
 * Record one job application to corpus-rag (POST /api/job-applications).
 * Does not throw; logs and returns success/failure so the bot workflow can continue.
 */
export async function recordJobApplicationToBackend(input: RecordJobApplicationInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  const payload = buildJobApplicationPayload(input);
  if (!payload) {
    logger.warn('recorder.payload_invalid', 'Could not build payload from job file and dir', {
      jobFilePath: input.jobFilePath,
      jobDirPath: input.jobDirPath
    });
    return { ok: false, error: 'Could not build payload from job file and dir' };
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info('recorder.post_attempt', 'Recording job application attempt', {
        attempt,
        maxAttempts,
        platform: payload.platform,
        platformJobId: payload.platformJobId,
        company: payload.company,
        title: payload.title
      }, {
        platform: payload.platform,
        jobId: payload.platformJobId
      });
      const result = await apiRequest('/api/job-applications', 'POST', payload);
      const id = result?.id ?? result?.data?.id;
      printLog(`[JobRecorder] Recorded application: ${payload.company} / ${payload.title} (${id ?? 'ok'})`);
      logger.info('recorder.post_success', 'Recorded job application', {
        id,
        attempt
      }, {
        platform: payload.platform,
        jobId: payload.platformJobId
      });
      return { ok: true, id };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isLast = attempt === maxAttempts;
      printLog(`[JobRecorder] Record attempt ${attempt}/${maxAttempts} failed: ${message}`);
      logger.error('recorder.post_failed', 'Record attempt failed', {
        attempt,
        maxAttempts,
        error: message,
        isLast
      }, {
        platform: payload.platform,
        jobId: payload.platformJobId
      });
      if (isLast) {
        return { ok: false, error: message };
      }
      await sleep(300 * attempt);
    }
  }
  return { ok: false, error: 'Unexpected recorder failure' };
}

/**
 * Build job dir path from job file path and jobId (e.g. .../jobs/company_123.json -> .../jobs/123).
 */
export function getJobDirPathFromJobFile(jobFilePath: string, jobId: string): string {
  const dir = path.dirname(jobFilePath);
  if (path.basename(dir) === jobId) {
    return dir;
  }
  return path.join(dir, jobId);
}
