import type { WorkflowContext } from '../../core/workflow_engine';
import { isGenericQuestion, getGenericAnswer } from './generic_question_handler';
import * as fs from 'fs';
import * as path from 'path';
import { getClientEmailFromContext, getJobArtifactDir } from '../../core/client_paths';
import { logger } from '../../core/logger';
import { resolveCanonicalResumePath } from '../../../lib/canonical-resume';

/**
 * Parse API response text like "**Question 1:**\nAnswer one\n\n**Question 2:**\nAnswer two"
 * into an array of answer strings. Returns empty array if format is unrecognized.
 */
function parseQuestionAnswersFromText(text: string): string[] {
  const out: string[] = [];
  const re = /\*\*Question\s*(\d+)\s*:?\s*([^*]*)\*\*\s*([\s\S]*?)(?=\n?\s*\*\*Question\s*\d+\s*:?\s*[^*]*\*\*|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let answer = (m[3] || '').trim();
    answer = answer.replace(/^\*\*Answer\*\*\s*:?\s*/i, '').trim();
    answer = answer.replace(/^Answer\s*:?\s*/i, '').trim();
    if (answer && !/^Based on the provided resume/i.test(answer)) {
      out.push(answer);
    }
  }
  if (out.length > 0) return out;
  // Fallback: treat whole block as one answer only if it looks like a short direct answer
  const trimmed = text.replace(/^Based on the provided resume[.:\s\n]*/i, '').trim();
  if (trimmed.length > 0 && trimmed.length < 500) {
    return [trimmed];
  }
  return [];
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function mapTextToOptionIndex(answerText: string, options: string[]): number | null {
  if (!answerText || !Array.isArray(options) || options.length === 0) return null;
  const normalizedAnswer = normalizeForMatch(answerText);

  // Remove common placeholder options while keeping original indices.
  const candidateOptions = options
    .map((opt, idx) => ({ idx, opt, normalized: normalizeForMatch(opt) }))
    .filter(({ normalized }) => normalized && !/^(select an option|select|please select|choose)$/.test(normalized));

  // 1. Exact option text match.
  const exact = candidateOptions.find(({ normalized }) => normalized === normalizedAnswer);
  if (exact) return exact.idx;

  // 2. Answer text contains the full option phrase (e.g. answer is a sentence that mentions the option).
  const answerContainsOption = candidateOptions.find(({ normalized }) => normalizedAnswer.includes(normalized));
  if (answerContainsOption) return answerContainsOption.idx;

  // 3. Option text starts with the answer (e.g. option is "Yes, I have 3+ years experience" and
  //    answer is just "Yes"). Require at least 2 chars to avoid false matches on single letters.
  if (normalizedAnswer.length >= 2) {
    const optionStartsWithAnswer = candidateOptions.find(({ normalized }) => normalized.startsWith(normalizedAnswer));
    if (optionStartsWithAnswer) return optionStartsWithAnswer.idx;
  }

  // 4. First-word matching for yes/no-style options with longer descriptive text
  //    (e.g. "Yes, I satisfy this requirement" → first word "yes" matches answer "yes").
  if (/\byes\b/i.test(answerText)) {
    const yesOpt = candidateOptions.find(({ normalized }) => normalized.split(' ')[0] === 'yes');
    if (yesOpt) return yesOpt.idx;
  }
  if (/\bno\b/i.test(answerText)) {
    const noOpt = candidateOptions.find(({ normalized }) => normalized.split(' ')[0] === 'no');
    if (noOpt) return noOpt.idx;
  }

  return null;
}

function parseAnswerArrayFromText(aiResponse: string): unknown[] {
  if (!aiResponse || typeof aiResponse !== 'string') return [];
  const cleanResponse = aiResponse.trim();
  const startIndex = cleanResponse.indexOf('[');
  if (startIndex === -1) return [];

  let bracketCount = 0;
  let endIndex = -1;
  for (let i = startIndex; i < cleanResponse.length; i++) {
    if (cleanResponse[i] === '[') bracketCount++;
    if (cleanResponse[i] === ']') bracketCount--;
    if (bracketCount === 0) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return [];

  try {
    const jsonString = cleanResponse.substring(startIndex, endIndex + 1);
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getEmployerQuestionsComparePrompt(): string {
  return `For each of these employer questions, analyze the question and my resume/background, then return ONLY a JSON array with the recommended responses.

Response Format:
- For "select" questions: single number (e.g., 2)
- For "checkbox" questions: array of numbers (e.g., [0,3,7])
- For "text" questions: concise string answer

Example: If Q1 is select (recommend option 3), Q2 is checkbox (recommend options 1,4), Q3 is text:
Return: [3, [1,4], "Your concise answer"]

Rules:
- Return ONLY the array, no explanations or text
- Use 0-based indexing (first option = 0, second = 1, etc.)
- Array length must match number of questions
- Select questions = single number, checkbox questions = array of numbers, text questions = string
- Consider my actual experience and background from resume
- Choose answers that are truthful and aligned with the job

Questions: [Questions List]`;
}

/**
 * Unified intelligent question answering function
 * Used by both main flow and test flow
 *
 * Flow:
 * 1. Check if question matches generic questions config → use generic answer
 * 2. If no match → send to AI via employer questions API → use AI answer
 * 3. Fallback to default answers if all else fails
 */
export async function getIntelligentAnswers(questions: any[], ctx: WorkflowContext): Promise<any[]> {
  const answeredQuestions: any[] = [];
  const aiQuestions = [];
  const genericAnsweredIndices = new Set();

  const formData = (ctx.config as any)?.formData || {};
  const configPhone = (formData.phone || '').trim();
  const configEmail = (formData.email || '').trim();

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    let answerSource = 'unknown';
    let selectedAnswer = null;
    let textAnswer = null;
    const qText = (question.question || '').toLowerCase();

    if (configPhone && (qText.includes('mobile phone') || qText.includes('phone number') || qText.includes('phone') || qText.includes('telephone'))) {
      textAnswer = configPhone;
      answerSource = 'Config (phone)';
      genericAnsweredIndices.add(i);
    } else if (configEmail && (qText.includes('email') || qText.includes('e-mail'))) {
      textAnswer = configEmail;
      answerSource = 'Config (email)';
      genericAnsweredIndices.add(i);
    } else if (isGenericQuestion(question.question)) {
      const genericAnswer = getGenericAnswer(question.question, question.type, question.options || []);
      if (genericAnswer !== null) {
        answerSource = 'Generic Config';
        genericAnsweredIndices.add(i);
        if (question.type === 'select') {
          selectedAnswer = genericAnswer;
        } else if (question.type === 'radio') {
          selectedAnswer = genericAnswer;
        } else if (question.type === 'checkbox') {
          if (Array.isArray(genericAnswer)) {
            const checkboxAnswers = genericAnswer.map((index: number) => question.options[index]).filter(Boolean);
            selectedAnswer = checkboxAnswers;
          }
        } else if (question.type === 'text' || question.type === 'textarea') {
          textAnswer = genericAnswer;
        }
      }
    }

    answeredQuestions.push({
      ...question,
      answerSource,
      selectedAnswer,
      textAnswer,
      originalIndex: i
    });

    if (answerSource === 'unknown') {
      aiQuestions.push({
        q: question.question,
        opts: question.options || []
      });
    }
  }

  if (aiQuestions.length > 0) {
    try {
      console.log(`🤖 Calling AI API for ${aiQuestions.length} questions...`);

      const jobData = ctx.currentJobFile ?
        JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf8')) :
        {};

      const jobId = jobData.job_id || jobData.jobId || 'unknown';
      const platform = (ctx as any).platform || (ctx.currentJobFile && ctx.currentJobFile.includes('linkedinjobs') ? 'linkedin' : 'seek');
      const clientEmail = getClientEmailFromContext(ctx) || '';
      const fallbackEmail = String((ctx as any)?.config?.formData?.email || '').trim();
      const userEmail = clientEmail || fallbackEmail;
      if (!userEmail) {
        throw new Error('Missing user email. Canonical resume lookup requires email in config.');
      }
      const preferredResumeFileName = String(((ctx as any)?.config?.formData?.resumeFileName || '')).trim();
      // Resolve the binary file path and extract text via /api/upload (same approach as
      // cover_letter_handler). readCanonicalResumeText() reads PDFs/DOCX as raw UTF-8 which
      // produces garbage — the upload endpoint properly decodes binary resume formats.
      const { filename: resumeFilename, filePath: resumeFilePath } = resolveCanonicalResumePath(userEmail, preferredResumeFileName);
      const baseUrl = process.env.API_BASE || 'http://localhost:3000';
      const { getBearerHeader } = await import('../../core/api_client.js');
      const resumeBinary = fs.readFileSync(resumeFilePath);
      const ext = path.extname(resumeFilename).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.doc': 'application/msword'
      };
      const uploadForm = new FormData();
      uploadForm.append('userId', userEmail);
      uploadForm.append('file', new Blob([resumeBinary], { type: mimeMap[ext] || 'application/octet-stream' }), resumeFilename);
      const uploadResp = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: { Authorization: await getBearerHeader() },
        body: uploadForm
      });
      if (!uploadResp.ok) throw new Error(`Resume text extraction failed: HTTP ${uploadResp.status}`);
      const uploadData = await uploadResp.json();
      const resumeText = typeof uploadData?.content === 'string' ? uploadData.content.trim() : '';
      if (!resumeText) {
        throw new Error(`Resume text extraction returned empty content for ${resumeFilename}`);
      }
      console.log(`📄 Resume text extracted for Q&A: ${resumeText.length} chars from ${resumeFilename}`);

      const { apiRequest: apiClient } = await import('../../core/api_client');

      const compareRequestBody = {
        userId: userEmail || 'unknown@local',
        prompt: getEmployerQuestionsComparePrompt(),
        questions: aiQuestions.map((q: { q: string; opts: string[] }, idx: number) => ({
          q: q.q,
          type: answeredQuestions.filter((x) => x.answerSource === 'unknown')[idx]?.type || 'select',
          options: q.opts || []
        })),
        details: jobData.details || jobData.description || `${jobData.title || ''} at ${jobData.company || ''}`,
        resume_text: resumeText,
        stream: false,
        useRag: true,
        jobId: `${platform}_${jobId}`
      };

      const fallbackRequestBody = {
        job_id: `${platform}_${jobId}`,
        questions: aiQuestions,
        resume_text: resumeText,
        useAi: "deepseek-chat",
        job_details: compareRequestBody.details,
        platform,
        platform_job_id: jobId,
        job_title: jobData.title || '',
        company: jobData.company || '',
        prompt: compareRequestBody.prompt
      };

      const jobDir = getJobArtifactDir(ctx, platform === 'linkedin' ? 'linkedin' : 'seek', jobId);

      fs.writeFileSync(
        path.join(jobDir, 'qna_request.json'),
        JSON.stringify({
          primaryEndpoint: '/api/employer-questions/compare',
          primaryRequest: compareRequestBody,
          fallbackEndpoint: '/api/questionAndAnswers',
          fallbackRequest: fallbackRequestBody
        }, null, 2)
      );

      console.log(`📋 Q&A API request (POST /api/employer-questions/compare):\n${JSON.stringify(compareRequestBody, null, 2)}`);

      // Use apiRequest helper for authenticated calls
      let data: any;
      let answerPayload: unknown;
      try {
        data = await apiClient('/api/employer-questions/compare', 'POST', compareRequestBody);
        const results = Array.isArray(data?.results) ? data.results : [];
        const firstSuccessful = results.find((r: any) => r && !r.error && typeof r.text === 'string');
        answerPayload = firstSuccessful?.text ?? '';
      } catch (compareError) {
        logger.warn('qa.compare_api_failed', 'Primary compare API failed, using questionAndAnswers fallback', {
          error: compareError instanceof Error ? compareError.message : String(compareError)
        });
        data = await apiClient('/api/questionAndAnswers', 'POST', fallbackRequestBody);
        answerPayload = data?.answers;
      }

      fs.writeFileSync(
        path.join(jobDir, 'qna_response.json'),
        JSON.stringify(data, null, 2)
      );

      console.log(`✅ AI answers received for ${aiQuestions.length} questions`);
      console.log(`📋 Question answers API response (full):\n${JSON.stringify(data, null, 2)}`);

      // Log answers payload explicitly for readability
      if (answerPayload != null) {
        const rawStr = Array.isArray(answerPayload)
          ? JSON.stringify(answerPayload, null, 2)
          : typeof answerPayload === 'string'
            ? answerPayload
            : String(answerPayload);
        console.log(`📋 Question answers API response (data.answers):\n${rawStr}`);
      }

      // Only set textAnswer when we have a real answer; otherwise leave field empty
      if (answerPayload) {
        const raw = answerPayload;
        const parsedArray = Array.isArray(raw)
          ? raw
          : parseAnswerArrayFromText(typeof raw === 'string' ? raw : String(raw));
        const fallbackTextAnswers = parseQuestionAnswersFromText(typeof raw === 'string' ? raw : String(raw));

        if (parsedArray.length > 0 || fallbackTextAnswers.length > 0) {
          const debugAnswers = parsedArray.length > 0 ? parsedArray : fallbackTextAnswers;
          console.log(`📋 Parsed ${debugAnswers.length} answer(s) from API:`);
          debugAnswers.forEach((ans, idx) => {
            console.log(`   [${idx + 1}] ${ans}`);
          });
        }

        let aiAnswerIndex = 0;
        for (let i = 0; i < answeredQuestions.length; i++) {
          if (answeredQuestions[i].answerSource === 'unknown') {
            answeredQuestions[i].answerSource = 'AI API';
            const structuredValue = parsedArray[aiAnswerIndex];
            const fallbackValue = fallbackTextAnswers[aiAnswerIndex];
            const value = structuredValue != null ? structuredValue : fallbackValue;
            if (value != null && String(value).trim() !== '') {
              const normalizedValue = String(value).trim();
              if (answeredQuestions[i].type === 'select' || answeredQuestions[i].type === 'radio') {
                const indexCandidate = typeof value === 'number' ? value : mapTextToOptionIndex(normalizedValue, answeredQuestions[i].options || []);
                if (indexCandidate != null) {
                  answeredQuestions[i].selectedAnswer = indexCandidate;
                  const mappedOption = (answeredQuestions[i].options || [])[indexCandidate];
                  console.log(`✅ Q: "${answeredQuestions[i].question}" → mapped AI answer "${normalizedValue}" to option [${indexCandidate}] "${mappedOption}"`);
                } else {
                  // Keep text for debugging if we fail to map.
                  answeredQuestions[i].textAnswer = normalizedValue;
                  const opts = (answeredQuestions[i].options || []).map((o: string, i: number) => `[${i}] "${o}"`).join(', ');
                  console.log(`⚠️ Could not map AI answer to available options`);
                  console.log(`   Question : "${answeredQuestions[i].question}"`);
                  console.log(`   AI answer: "${normalizedValue}"`);
                  console.log(`   Options  : ${opts || '(none)'}`);
                }
              } else if (answeredQuestions[i].type === 'checkbox') {
                const options = answeredQuestions[i].options || [];
                if (Array.isArray(value)) {
                  const mappedValues = value
                    .map((item) => {
                      if (typeof item === 'number') return options[item];
                      if (typeof item === 'string') {
                        const mapped = mapTextToOptionIndex(item, options);
                        if (mapped != null) return options[mapped];
                        return item;
                      }
                      return null;
                    })
                    .filter(Boolean);
                  answeredQuestions[i].selectedAnswer = mappedValues;
                } else {
                  const rawParts = normalizedValue.split(/,|\n|;|\band\b/gi).map((x) => x.trim()).filter(Boolean);
                  const mappedValues = rawParts
                    .map((part) => {
                      const mapped = mapTextToOptionIndex(part, options);
                      if (mapped != null) return options[mapped];
                      return null;
                    })
                    .filter(Boolean);
                  answeredQuestions[i].selectedAnswer = mappedValues.length > 0 ? mappedValues : rawParts;
                }
                logger.debug('qa.answer_mapped_checkbox', 'Mapped AI answer for checkbox question', {
                  question: answeredQuestions[i].question,
                  rawAnswer: normalizedValue,
                  selectedAnswer: answeredQuestions[i].selectedAnswer
                });
              } else {
                answeredQuestions[i].textAnswer = normalizedValue;
                logger.debug('qa.answer_mapped_text', 'Using AI text answer', {
                  question: answeredQuestions[i].question,
                  rawAnswer: normalizedValue
                });
              }
            }
            // else: leave textAnswer null so the field is not filled
            aiAnswerIndex++;
          }
        }
      }
    } catch (error) {
      console.log(`⚠️ AI API failed: ${error}`);
    }
  }

  return answeredQuestions;
}

/**
 * Extract questions from current page using the browser script
 */
export async function extractQuestionsFromPage(ctx: WorkflowContext): Promise<any[]> {
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');

  // Get current file directory
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Use the same extraction logic as the test
  const scriptPath = path.join(__dirname, '../scripts/browser_question_extractor.js');
  const browserScript = fs.readFileSync(scriptPath, 'utf8');
  const extractedData: any = await ctx.driver.executeScript(browserScript);

  if (!extractedData || extractedData.questionsFound === 0) {
    return [];
  }

  return extractedData.questions;
}