import { json } from '@sveltejs/kit';

function parseAnswerArrayFromText(aiResponse) {
	if (!aiResponse || typeof aiResponse !== 'string') return [];
	const cleanResponse = aiResponse.trim();
	const startIndex = cleanResponse.indexOf('[');
	if (startIndex === -1) return [];
	let bracketCount = 0;
	let endIndex = -1;
	for (let i = startIndex; i < cleanResponse.length; i++) {
		if (cleanResponse[i] === '[') bracketCount++;
		if (cleanResponse[i] === ']') bracketCount--;
		if (bracketCount === 0) { endIndex = i; break; }
	}
	if (endIndex === -1) return [];
	try {
		const parsed = JSON.parse(cleanResponse.substring(startIndex, endIndex + 1));
		return Array.isArray(parsed) ? parsed : [];
	} catch { return []; }
}

function normalizeForMatch(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function mapTextToOptionIndex(answerText, options) {
	if (!answerText || !Array.isArray(options) || options.length === 0) return null;
	const normalizedAnswer = normalizeForMatch(answerText);
	const candidates = options
		.map((opt, idx) => ({ idx, normalized: normalizeForMatch(opt) }))
		.filter(({ normalized }) => normalized && !/^(select an option|select|please select|choose)$/.test(normalized));
	const exact = candidates.find(({ normalized }) => normalized === normalizedAnswer);
	if (exact) return exact.idx;
	const contains = candidates.find(({ normalized }) => normalizedAnswer.includes(normalized));
	if (contains) return contains.idx;
	if (normalizedAnswer.length >= 2) {
		const starts = candidates.find(({ normalized }) => normalized.startsWith(normalizedAnswer));
		if (starts) return starts.idx;
	}
	if (/\byes\b/i.test(answerText)) {
		const y = candidates.find(({ normalized }) => normalized.split(' ')[0] === 'yes');
		if (y) return y.idx;
	}
	if (/\bno\b/i.test(answerText)) {
		const n = candidates.find(({ normalized }) => normalized.split(' ')[0] === 'no');
		if (n) return n.idx;
	}
	return null;
}

/** Resolve a raw AI answer value into { selected, answer } for display. */
function resolveAiAnswer(value, question) {
	const options = question.options || [];
	const type = question.type || 'text';
	if (type === 'select' || type === 'radio') {
		if (typeof value === 'number') {
			const optionText = options[value];
			return { selected: value, answer: optionText || String(value) };
		}
		const normalizedValue = String(value).trim();
		const idx = mapTextToOptionIndex(normalizedValue, options);
		if (idx != null) return { selected: idx, answer: options[idx] || normalizedValue };
		return { selected: null, answer: normalizedValue };
	}
	if (type === 'checkbox') {
		if (Array.isArray(value)) {
			const mapped = value.map((item) => {
				if (typeof item === 'number') return options[item] || null;
				const idx = mapTextToOptionIndex(String(item), options);
				return idx != null ? options[idx] : String(item);
			}).filter(Boolean);
			return { selected: mapped, answer: mapped.join(', ') };
		}
		const parts = String(value).split(/,|\n|;|\band\b/gi).map((x) => x.trim()).filter(Boolean);
		const mapped = parts.map((p) => { const idx = mapTextToOptionIndex(p, options); return idx != null ? options[idx] : p; }).filter(Boolean);
		const result = mapped.length > 0 ? mapped : parts;
		return { selected: result, answer: result.join(', ') };
	}
	return { selected: null, answer: String(value).trim() };
}

/** Resolve a generic config answer (already in option-index or text form) into { selected, answer }. */
function resolveGenericAnswer(genericAnswer, question) {
	const options = question.options || [];
	const type = question.type || 'text';
	if (type === 'select' || type === 'radio') {
		if (typeof genericAnswer === 'number' && options[genericAnswer] != null) {
			return { selected: genericAnswer, answer: options[genericAnswer] };
		}
		return { selected: null, answer: String(genericAnswer ?? '') };
	}
	if (type === 'checkbox') {
		if (Array.isArray(genericAnswer)) {
			const mapped = genericAnswer.map((i) => options[i]).filter(Boolean);
			return { selected: mapped, answer: mapped.join(', ') };
		}
		return { selected: null, answer: String(genericAnswer ?? '') };
	}
	return { selected: null, answer: String(genericAnswer ?? '') };
}

function extractTextFromResumeJson(data) {
	const lines = [];
	const pi = data.personalInfo || {};
	if (pi.fullName) lines.push(pi.fullName);
	if (pi.title) lines.push(pi.title);
	const contact = [pi.email, pi.phone, pi.address, pi.linkedin, pi.github, pi.website].filter(Boolean);
	if (contact.length) lines.push(contact.join(' | '));
	if (data.summary) lines.push('', 'SUMMARY', String(data.summary));
	const experience = data.experience || [];
	if (experience.length) {
		lines.push('', 'EXPERIENCE');
		for (const exp of experience) {
			lines.push(`${exp.jobTitle} at ${exp.company}${exp.location ? ', ' + exp.location : ''}`);
			if (exp.startDate) lines.push(`${exp.startDate} – ${exp.endDate || 'Present'}`);
			if (Array.isArray(exp.achievements)) for (const a of exp.achievements) lines.push(`• ${a}`);
		}
	}
	const education = data.education || [];
	if (education.length) {
		lines.push('', 'EDUCATION');
		for (const edu of education) lines.push(`${edu.degree} – ${edu.institution}`);
	}
	const skills = data.skills || [];
	if (skills.length) {
		lines.push('', 'SKILLS');
		const byCategory = {};
		for (const s of skills) { const cat = s.category || 'Other'; (byCategory[cat] = byCategory[cat] || []).push(s.name); }
		for (const [cat, names] of Object.entries(byCategory)) lines.push(`${cat}: ${names.join(', ')}`);
	}
	return lines.join('\n').trim();
}

async function getResumeText(bodyResumeText, email) {
	if (bodyResumeText) return bodyResumeText;
	if (!email) return '';
	try {
		const { resolveBaseResumeJson } = await import('../../../../lib/canonical-resume.js');
		const baseData = resolveBaseResumeJson(email);
		if (baseData) { const text = extractTextFromResumeJson(baseData); if (text) return text; }
	} catch { /* fall through */ }
	try {
		const { resolveCanonicalResumePath } = await import('../../../../lib/canonical-resume.js');
		const { readFileSync, existsSync } = await import('fs');
		const { extname } = await import('path');
		const { getBearerHeader } = await import('../../../../bots/core/api_client.js');
		const { filename, filePath } = resolveCanonicalResumePath(email);
		if (!existsSync(filePath)) return '';
		const baseUrl = process.env.API_BASE || 'http://localhost:3000';
		const binary = readFileSync(filePath);
		const ext = extname(filename).toLowerCase();
		const mimeMap = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword' };
		const uploadForm = new FormData();
		uploadForm.append('userId', email);
		uploadForm.append('file', new Blob([binary], { type: mimeMap[ext] || 'application/octet-stream' }), filename);
		const uploadResp = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { Authorization: await getBearerHeader() }, body: uploadForm });
		if (uploadResp.ok) { const d = await uploadResp.json(); return typeof d?.content === 'string' ? d.content.trim() : ''; }
	} catch { /* fall through */ }
	return '';
}

/**
 * Silent inline equivalents of isGenericQuestion / getGenericAnswer from
 * generic_question_handler.ts. Reads the same config file but produces no
 * console output — the original handler is intended for bot use and always logs.
 */
async function loadGenericQuestionHelpers() {
	const { readFileSync, existsSync } = await import('fs');
	const { join, dirname } = await import('path');
	const { fileURLToPath } = await import('url');

	const configPath = join(
		dirname(fileURLToPath(import.meta.url)),
		'../../../../bots/seek/config/generic_questions_config.json'
	);

	let genericConfig = { questions: [], settings: { autoAnswer: true } };
	try {
		if (existsSync(configPath)) {
			genericConfig = JSON.parse(readFileSync(configPath, 'utf8'));
		}
	} catch { /* use empty config */ }

	function normalizeText(text) {
		if (!text) return '';
		return text.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '').trim();
	}

	function parseNumericValue(text) {
		if (!text) return null;
		const moreThan = text.match(/more than (\d+)/i);
		if (moreThan) return parseInt(moreThan[1], 10);
		let t = text.replace(/[^0-9.k+]/gi, '');
		if (t.toLowerCase().includes('k')) { const v = parseFloat(t) * 1000; return isNaN(v) ? null : v; }
		if (t.includes('+')) { const v = parseFloat(t.replace('+', '')); return isNaN(v) ? null : v; }
		const v = parseFloat(t);
		return isNaN(v) ? null : v;
	}

	function isGenericQuestion(questionText) {
		if (!genericConfig.settings?.autoAnswer) return false;
		return genericConfig.questions.some((q) =>
			(q.match_keywords || []).map((k) => (k || '').trim()).filter(Boolean)
				.some((k) => new RegExp(k, 'i').test(questionText))
		);
	}

	function getGenericAnswer(questionText, questionType, options = []) {
		for (const question of genericConfig.questions) {
			const keywords = (question.match_keywords || []).map((k) => (k || '').trim()).filter(Boolean);
			const answers = (question.answer || []).map((a) => String(a ?? '').trim()).filter(Boolean);
			if (!keywords.some((k) => new RegExp(k, 'i').test(questionText)) || answers.length === 0) continue;

			// Salary special case
			if (keywords.some((k) => k.includes('salary'))) {
				const desired = parseNumericValue(answers[0]);
				if (desired !== null) {
					let bestIdx = -1, bestVal = -1;
					options.forEach((opt, i) => {
						const v = parseNumericValue(opt);
						if (v !== null && v <= desired && v > bestVal) { bestVal = v; bestIdx = i; }
					});
					if (bestIdx !== -1) return bestIdx;
				}
			}

			switch (questionType) {
				case 'select':
				case 'radio':
					for (const ans of answers) {
						const idx = options.findIndex((o) => normalizeText(o) === normalizeText(ans));
						if (idx !== -1) return idx;
					}
					for (const ans of answers) {
						const idx = options.findIndex((o) => normalizeText(o).includes(normalizeText(ans)));
						if (idx !== -1) return idx;
					}
					return null;
				case 'checkbox': {
					const indices = [];
					options.forEach((opt, i) => {
						if (answers.some((a) => normalizeText(opt).includes(normalizeText(a)))) indices.push(i);
					});
					return indices;
				}
				case 'text':
				case 'textarea':
				case 'number':
				case 'date':
				case 'email':
				case 'tel':
				case 'url':
					return answers[0] || '';
				default:
					return null;
			}
		}
		return null;
	}

	return { isGenericQuestion, getGenericAnswer };
}

export async function POST({ request }) {
	try {
		const body = await request.json();
		const { job_id, job_details, job_title, company, resume_text: bodyResumeText, questions } = body;

		if (!Array.isArray(questions) || questions.length === 0) {
			return json({ error: 'No questions provided. Load a job with saved Q&A data to use this feature.' }, { status: 400 });
		}

		const { readUserConfig } = await import('../../../../bots/core/user-config.js');
		const { apiRequest } = await import('../../../../bots/core/api_client.js');
		const { isGenericQuestion, getGenericAnswer } = await loadGenericQuestionHelpers();

		const config = readUserConfig();
		const formData = config?.formData || {};
		const email = String(formData.email || '').trim();
		const configPhone = String(formData.phone || '').trim();

		// ── Phase 1: resolve questions from user config / generic config ──────────
		// Each entry: { ...question, answerSource, selected, answer, resolved }
		const answered = questions.map((q) => {
			const qText = (q.question || '').toLowerCase();

			// Phone/email from user config (same check as intelligent_qa_handler)
			if (configPhone && /mobile phone|phone number|\bphone\b|telephone/.test(qText)) {
				return { ...q, answerSource: 'Config (phone)', selected: null, answer: configPhone, resolved: true };
			}
			if (email && /\bemail\b|e-mail/.test(qText)) {
				return { ...q, answerSource: 'Config (email)', selected: null, answer: email, resolved: true };
			}

			// Generic questions config
			if (isGenericQuestion(q.question)) {
				const genericAnswer = getGenericAnswer(q.question, q.type || 'text', q.options || []);
				if (genericAnswer !== null) {
					const { selected, answer } = resolveGenericAnswer(genericAnswer, q);
					return { ...q, answerSource: 'Generic Config', selected, answer, resolved: true };
				}
			}

			return { ...q, answerSource: 'AI API', selected: null, answer: null, resolved: false };
		});

		// ── Phase 2: send unresolved questions to AI ───────────────────────────────
		const aiIndices = answered.map((q, i) => q.resolved ? null : i).filter((i) => i !== null);

		if (aiIndices.length > 0) {
			const resumeText = await getResumeText(bodyResumeText, email);
			if (!resumeText) {
				return json({ error: 'No resume text available. Please upload a resume in the Resume Builder or User Config.' }, { status: 400 });
			}

			const aiQuestions = aiIndices.map((i) => ({
				q: questions[i].question || questions[i].q || '',
				type: questions[i].type || 'select',
				options: questions[i].options || []
			}));

			const compareRequestBody = {
				userId: email || 'unknown@local',
				prompt: `For each of these employer questions, analyze the question and my resume/background, then return ONLY a JSON array with the recommended responses.

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

Questions: [Questions List]`,
				questions: aiQuestions,
				details: job_details || `${job_title} at ${company}`,
				resume_text: resumeText,
				stream: false,
				useRag: true,
				jobId: `seek_${job_id}`
			};

			const data = await apiRequest('/api/employer-questions/compare', 'POST', compareRequestBody);
			const results = Array.isArray(data?.results) ? data.results : [];
			const firstSuccessful = results.find((r) => r && !r.error && typeof r.text === 'string');
			const parsedAnswers = parseAnswerArrayFromText(firstSuccessful?.text ?? '');

			// Merge AI answers back into answered array
			aiIndices.forEach((originalIdx, aiIdx) => {
				const rawValue = parsedAnswers[aiIdx];
				if (rawValue == null || String(rawValue).trim() === '') return; // leave as unresolved
				const q = answered[originalIdx];
				const { selected, answer } = resolveAiAnswer(rawValue, q);
				answered[originalIdx] = { ...q, selected, answer, resolved: Boolean(answer) };
			});
		}

		// ── Phase 3: normalise output ──────────────────────────────────────────────
		const normalizedQna = answered.map((q) => ({
			question: q.question || q.q || '',
			type: q.type || 'text',
			options: q.options || [],
			answer: q.answer || '',
			selected: q.selected ?? null,
			answerSource: q.answerSource,
			status: q.answer ? 'success' : 'failed'
		}));

		const successCount = normalizedQna.filter((q) => q.status === 'success').length;
		return json({
			questions: normalizedQna,
			summary: { total: normalizedQna.length, success: successCount, failed: normalizedQna.length - successCount }
		});
	} catch (error) {
		return json({ error: error.message }, { status: 500 });
	}
}
