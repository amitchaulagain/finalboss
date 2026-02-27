import { json } from '@sveltejs/kit';

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
			if (Array.isArray(exp.technologies) && exp.technologies.length) lines.push(`Technologies: ${exp.technologies.join(', ')}`);
		}
	}
	const education = data.education || [];
	if (education.length) {
		lines.push('', 'EDUCATION');
		for (const edu of education) {
			lines.push(`${edu.degree} – ${edu.institution}${edu.location ? ', ' + edu.location : ''}`);
			if (edu.graduationDate) lines.push(edu.graduationDate);
		}
	}
	const skills = data.skills || [];
	if (skills.length) {
		lines.push('', 'SKILLS');
		const byCategory = {};
		for (const s of skills) {
			const cat = s.category || 'Other';
			(byCategory[cat] = byCategory[cat] || []).push(s.name);
		}
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
		if (baseData) {
			const text = extractTextFromResumeJson(baseData);
			if (text) return text;
		}
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
		const mimeMap = {
			'.pdf': 'application/pdf',
			'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'.doc': 'application/msword'
		};
		const uploadForm = new FormData();
		uploadForm.append('userId', email);
		uploadForm.append('file', new Blob([binary], { type: mimeMap[ext] || 'application/octet-stream' }), filename);

		const uploadResp = await fetch(`${baseUrl}/api/upload`, {
			method: 'POST',
			headers: { Authorization: await getBearerHeader() },
			body: uploadForm
		});
		if (uploadResp.ok) {
			const uploadData = await uploadResp.json();
			return typeof uploadData?.content === 'string' ? uploadData.content.trim() : '';
		}
	} catch { /* fall through */ }

	return '';
}

export async function POST({ request }) {
	try {
		const body = await request.json();
		const { job_id, job_details, job_title, company, resume_text: bodyResumeText } = body;

		const { readUserConfig } = await import('../../../../bots/core/user-config.js');
		const { apiRequest } = await import('../../../../bots/core/api_client.js');

		const config = readUserConfig();
		const formData = config?.formData || {};
		const email = String(formData.email || '').trim();

		const resumeText = await getResumeText(bodyResumeText, email);
		if (!resumeText) {
			return json({ error: 'No resume text available. Please upload a resume in the Resume Builder or User Config.' }, { status: 400 });
		}

		const requestBody = {
			job_id: `seek_${job_id}`,
			job_details: job_details || `${job_title} at ${company}`,
			resume_text: resumeText,
			useAi: 'deepseek-chat',
			platform: 'seek',
			platform_job_id: String(job_id),
			job_title: job_title || '',
			company: company || '',
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

		const data = await apiRequest('/api/resume', 'POST', requestBody);

		if (!data.resume) {
			return json({ error: `No resume field in API response. success=${data.success}, error=${data.error}` }, { status: 500 });
		}

		const resume = stripMarkdown(data.resume);
		return json({ resume });
	} catch (error) {
		return json({ error: error.message }, { status: 500 });
	}
}
