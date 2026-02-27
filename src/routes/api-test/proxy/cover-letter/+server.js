import { json } from '@sveltejs/kit';

function fixSignOffName(text, correctName) {
	if (!correctName) return text;
	const closingPhrases = [
		'yours sincerely', 'yours faithfully', 'sincerely yours', 'sincerely',
		'kind regards', 'warm regards', 'best regards', 'regards',
		'with regards', 'many thanks', 'thank you', 'yours truly'
	];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const lower = lines[i].trim().toLowerCase().replace(/,\s*$/, '');
		if (closingPhrases.includes(lower)) {
			let j = i + 1;
			while (j < lines.length && lines[j].trim() === '') j++;
			if (j < lines.length && lines[j].trim() !== '') {
				const oldName = lines[j].trim();
				if (oldName !== correctName) {
					lines[j] = lines[j].replace(oldName, correctName);
				}
			}
			break;
		}
	}
	return lines.join('\n');
}

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

	// Try base resume JSON (Resume Builder)
	try {
		const { resolveBaseResumeJson } = await import('../../../../lib/canonical-resume.js');
		const baseData = resolveBaseResumeJson(email);
		if (baseData) {
			const text = extractTextFromResumeJson(baseData);
			if (text) return text;
		}
	} catch { /* fall through */ }

	// Try canonical uploaded resume via /api/upload
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
		const contactProfile = {
			full_name: String(formData.fullName || '').trim(),
			email,
			phone: String(formData.phone || '').trim()
		};

		const resumeText = await getResumeText(bodyResumeText, email);
		if (!resumeText) {
			return json({ error: 'No resume text available. Please upload a resume in the Resume Builder or User Config.' }, { status: 400 });
		}

		const requestBody = {
			job_id: `seek_${job_id}`,
			job_details: job_details || `${job_title} at ${company}`,
			resume_text: resumeText,
			useAi: 'deepseek-chat',
			strictQuality: true,
			qualityThreshold: 92,
			strictQualityRetries: 1,
			contact_profile: contactProfile,
			useRag: false,
			platform: 'seek',
			platform_job_id: String(job_id),
			job_title: job_title || '',
			company: company || '',
			prompt: `Write a compelling, professional cover letter for this Seek job posting.

STRICT RULES — these override everything else:
- NEVER invent, fabricate, or modify any factual information
- Only reference experiences, skills, and achievements that are explicitly stated in the provided resume
- Do NOT fabricate projects, companies, dates, or accomplishments
- Do NOT include a LinkedIn URL or any other URL anywhere in the letter
- The sender's full name is "${contactProfile.full_name}". Use this EXACT name — and only this name — in the closing signature. Do not use any other name from the resume.

Highlight relevant experience and skills that match the job requirements.
Keep it concise (300-400 words) and personalized to ${company || 'the company'}.
Focus on demonstrating value and enthusiasm for the role.`
		};

		const data = await apiRequest('/api/cover_letter', 'POST', requestBody);

		if (data.success === false) {
			return json({ error: data.error || 'API returned error' }, { status: 500 });
		}
		if (!data.cover_letter) {
			return json({ error: 'No cover_letter field in API response' }, { status: 500 });
		}

		const coverLetter = fixSignOffName(stripMarkdown(data.cover_letter), contactProfile.full_name);
		return json({ cover_letter: coverLetter });
	} catch (error) {
		return json({ error: error.message }, { status: 500 });
	}
}
