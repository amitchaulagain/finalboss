/**
 * Client-side resume text parser.
 * Takes plain text extracted from a PDF/DOC and returns a structured object
 * whose shape mirrors the resume builder's ResumeData interface.
 */

export interface ParsedResumePersonalInfo {
  fullName: string;
  title: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  website: string;
  address: string;
}

export interface ParsedExperience {
  jobTitle: string;
  company: string;
  location: string;
  startDate: string;
  endDate: string;
  achievements: string[];
}

export interface ParsedEducation {
  degree: string;
  institution: string;
  location: string;
  graduationDate: string;
  gpa: string;
}

export interface ParsedSkill {
  name: string;
  category: string;
}

export interface ParsedCertification {
  name: string;
  issuer: string;
  date: string;
}

export interface ParsedProject {
  title: string;
  description: string[];
}

export interface ParsedLanguage {
  name: string;
  proficiency: 'Native' | 'Fluent' | 'Advanced' | 'Intermediate' | 'Basic';
}

export interface ParsedResume {
  personalInfo: ParsedResumePersonalInfo;
  summary: string;
  experience: ParsedExperience[];
  education: ParsedEducation[];
  skills: ParsedSkill[];
  certifications: ParsedCertification[];
  projects: ParsedProject[];
  languages: ParsedLanguage[];
}

// ── Regex constants ──────────────────────────────────────────────────────────

const EMAIL_RE = /[\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([\w-]+)/i;
const GITHUB_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w-]+)/i;
// Capture standalone URLs that aren't LinkedIn/GitHub
const WEBSITE_RE = /https?:\/\/(?!(?:www\.)?(?:linkedin|github)\.com)[\w.-]+\.[a-zA-Z]{2,}(?:\/[\w./-]*)?/i;

const DATE_RE = /(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4}/i;
const DATE_RANGE_RE = /((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4})\s*[-–—to]+\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4}|Present|Current|Now)/i;

const DEGREE_KEYWORDS = [
  'bachelor', 'master', 'phd', 'ph.d', 'doctor', 'associate', 'diploma',
  'certificate', 'bsc', 'msc', 'b.sc', 'm.sc', 'ba', 'ma', 'mba',
  'beng', 'meng', 'b.eng', 'm.eng', 'bcomm', 'bcs', 'bis', 'llb', 'llm',
  'b.a.', 'm.a.', 'b.com', 'm.com'
];

const BULLET_RE = /^[•·▪▸►▶✓✔✗\-\*]\s+/;
const SECTION_NAMES: Record<string, RegExp> = {
  summary: /^(summary|professional summary|profile|objective|career objective|about me|overview|about|introduction)\s*$/i,
  experience: /^(experience|work experience|professional experience|employment|employment history|work history|career history|career)\s*$/i,
  education: /^(education|academic background|educational background|qualifications|academic qualifications|academic history)\s*$/i,
  skills: /^(skills|technical skills|key skills|core skills|core competencies|competencies|technical competencies|technologies|areas of expertise|expertise|skill set)\s*$/i,
  certifications: /^(certifications?|certificates?|licenses?|professional certifications?|credentials)\s*$/i,
  projects: /^(projects?|personal projects?|key projects?|notable projects?|side projects?)\s*$/i,
  languages: /^(languages?|language skills?|spoken languages?)\s*$/i,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasBullet(line: string): boolean {
  return BULLET_RE.test(line);
}

function stripBullet(line: string): string {
  return line.replace(BULLET_RE, '').trim();
}

function isDegree(line: string): boolean {
  const lower = line.toLowerCase();
  return DEGREE_KEYWORDS.some((k) => lower.includes(k));
}

function detectSection(line: string): string | null {
  for (const [key, re] of Object.entries(SECTION_NAMES)) {
    if (re.test(line.trim())) return key;
  }
  return null;
}

// ── Main export ──────────────────────────────────────────────────────────────

export function parseResumeText(rawText: string): ParsedResume {
  const result: ParsedResume = {
    personalInfo: {
      fullName: '',
      title: '',
      email: '',
      phone: '',
      linkedin: '',
      github: '',
      website: '',
      address: ''
    },
    summary: '',
    experience: [],
    education: [],
    skills: [],
    certifications: [],
    projects: [],
    languages: []
  };

  if (!rawText?.trim()) return result;

  const lines = rawText.split('\n').map((l) => l.trim());
  const fullText = rawText;

  // ── Contact details (regex over full text) ─────────────────────────────────

  const emailM = fullText.match(EMAIL_RE);
  if (emailM) result.personalInfo.email = emailM[0];

  const phoneM = fullText.match(PHONE_RE);
  if (phoneM) result.personalInfo.phone = phoneM[0].trim();

  const linkedinM = fullText.match(LINKEDIN_RE);
  if (linkedinM) result.personalInfo.linkedin = `https://linkedin.com/in/${linkedinM[1]}`;

  const githubM = fullText.match(GITHUB_RE);
  if (githubM) result.personalInfo.github = `https://github.com/${githubM[1]}`;

  const websiteM = fullText.match(WEBSITE_RE);
  if (websiteM) result.personalInfo.website = websiteM[0];

  // ── Name & title (first 1–5 non-contact lines) ────────────────────────────

  let nameFound = false;
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const line = lines[i];
    if (!line) continue;
    if (EMAIL_RE.test(line)) continue;
    if (PHONE_RE.test(line)) continue;
    if (LINKEDIN_RE.test(line) || GITHUB_RE.test(line)) continue;
    if (/https?:\/\//i.test(line)) continue;
    if (detectSection(line)) continue;

    if (!nameFound) {
      result.personalInfo.fullName = line;
      nameFound = true;
    } else if (!result.personalInfo.title) {
      // The next meaningful short line after the name is often the job title
      if (line.length < 100 && !DATE_RE.test(line)) {
        result.personalInfo.title = line;
      }
      break;
    }
  }

  // ── Split into labelled sections ──────────────────────────────────────────

  const sections: Record<string, string[]> = { header: [] };
  let currentSection = 'header';

  for (const line of lines) {
    const sec = detectSection(line);
    if (sec) {
      currentSection = sec;
      if (!sections[currentSection]) sections[currentSection] = [];
    } else {
      if (!sections[currentSection]) sections[currentSection] = [];
      sections[currentSection].push(line);
    }
  }

  // ── Address (look in header block) ─────────────────────────────────────────

  const headerText = (sections.header || []).join(' ');
  // Pattern: "City, ST" or "City, State" or "City, State Postcode"
  const addressM = headerText.match(/[A-Z][a-zA-Z]+(?:[\s,]+[A-Z][a-zA-Z]+)*,\s*(?:[A-Z]{2,3}|[A-Z][a-zA-Z]+)(?:\s+\d{4,6})?/);
  if (addressM) result.personalInfo.address = addressM[0];

  // ── Summary ────────────────────────────────────────────────────────────────

  if (sections.summary) {
    result.summary = sections.summary.filter(Boolean).join(' ').trim();
  }

  // ── Skills ─────────────────────────────────────────────────────────────────

  if (sections.skills?.length) {
    const skillText = sections.skills.join('\n');
    const items = skillText
      .replace(/[•·▪▸►▶✓✔✗]/g, ',')
      .split(/[,\n|\/]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1 && s.length < 60);

    result.skills = items.map((name) => ({ name, category: 'General' }));
  }

  // ── Languages ──────────────────────────────────────────────────────────────

  if (sections.languages?.length) {
    for (const raw of sections.languages) {
      const line = hasBullet(raw) ? stripBullet(raw) : raw.trim();
      if (!line) continue;
      let proficiency: ParsedLanguage['proficiency'] = 'Intermediate';
      if (/native|mother tongue/i.test(line)) proficiency = 'Native';
      else if (/fluent/i.test(line)) proficiency = 'Fluent';
      else if (/advanced/i.test(line)) proficiency = 'Advanced';
      else if (/basic|beginner|elementary/i.test(line)) proficiency = 'Basic';

      const name = line
        .replace(/(native|mother tongue|fluent|advanced|intermediate|basic|beginner|elementary)/gi, '')
        .replace(/[-:,()/|]/g, '')
        .trim();
      if (name) result.languages.push({ name, proficiency });
    }
  }

  // ── Certifications ─────────────────────────────────────────────────────────

  if (sections.certifications?.length) {
    for (const raw of sections.certifications) {
      const line = hasBullet(raw) ? stripBullet(raw) : raw.trim();
      if (!line) continue;
      const dateM = line.match(DATE_RE);
      result.certifications.push({
        name: dateM ? line.replace(dateM[0], '').replace(/[-,|]/g, '').trim() : line,
        issuer: '',
        date: dateM ? dateM[0] : ''
      });
    }
  }

  // ── Experience ─────────────────────────────────────────────────────────────

  if (sections.experience?.length) {
    const expLines = sections.experience;
    let current: ParsedExperience | null = null;

    const pushCurrent = () => {
      if (current && (current.jobTitle || current.company)) {
        result.experience.push(current);
      }
      current = null;
    };

    for (const raw of expLines) {
      const line = raw.trim();

      // Blank line = entry boundary
      if (!line) {
        if (current?.achievements.length || current?.company) pushCurrent();
        continue;
      }

      // Bullet → achievement
      if (hasBullet(line)) {
        if (!current) current = { jobTitle: '', company: '', location: '', startDate: '', endDate: '', achievements: [] };
        const text = stripBullet(line);
        if (text) current.achievements.push(text);
        continue;
      }

      // Date range → fills dates on current entry
      const rangeM = line.match(DATE_RANGE_RE);
      if (rangeM) {
        if (!current) current = { jobTitle: '', company: '', location: '', startDate: '', endDate: '', achievements: [] };
        current.startDate = rangeM[1];
        current.endDate = rangeM[2];
        // Grab any location text on the same line (after the date range)
        const rest = line.replace(rangeM[0], '').replace(/[|-]/g, '').trim();
        if (rest && !current.location) current.location = rest;
        continue;
      }

      // Short line = candidate for jobTitle → company → new entry
      if (line.length < 100 && !EMAIL_RE.test(line)) {
        if (!current) {
          current = { jobTitle: line, company: '', location: '', startDate: '', endDate: '', achievements: [] };
        } else if (!current.jobTitle) {
          current.jobTitle = line;
        } else if (!current.company) {
          current.company = line;
        } else {
          // Likely the start of a new entry
          pushCurrent();
          current = { jobTitle: line, company: '', location: '', startDate: '', endDate: '', achievements: [] };
        }
      }
    }
    pushCurrent();
  }

  // ── Education ──────────────────────────────────────────────────────────────

  if (sections.education?.length) {
    const eduLines = sections.education;
    let current: ParsedEducation | null = null;

    const pushCurrent = () => {
      if (current && (current.degree || current.institution)) {
        result.education.push(current);
      }
      current = null;
    };

    for (const raw of eduLines) {
      const line = raw.trim();

      if (!line) {
        pushCurrent();
        continue;
      }

      if (hasBullet(line)) continue; // skip bullet details in education

      const dateM = line.match(DATE_RE);

      // Degree keyword on this line
      if (isDegree(line)) {
        if (current) pushCurrent();
        current = {
          degree: dateM ? line.replace(dateM[0], '').replace(/[,|-]/g, '').trim() : line,
          institution: '',
          location: '',
          graduationDate: dateM ? dateM[0] : '',
          gpa: ''
        };
        continue;
      }

      // Date-only line
      if (dateM && current && !current.graduationDate) {
        current.graduationDate = dateM[0];
        continue;
      }

      // GPA
      if (/gpa/i.test(line) && current) {
        const gpaM = line.match(/[\d.]+\s*(?:\/\s*[\d.]+)?/);
        if (gpaM) current.gpa = gpaM[0];
        continue;
      }

      // Institution (first unmatched short line after degree)
      if (current && !current.institution && line.length < 120) {
        current.institution = line;
        continue;
      }

      // Location
      if (current && !current.location && line.length < 60 && /,/.test(line)) {
        current.location = line;
      }
    }
    pushCurrent();
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  if (sections.projects?.length) {
    let current: ParsedProject | null = null;

    for (const raw of sections.projects) {
      const line = raw.trim();
      if (!line) {
        if (current) { result.projects.push(current); current = null; }
        continue;
      }
      if (hasBullet(line)) {
        if (!current) current = { title: 'Project', description: [] };
        current.description.push(stripBullet(line));
      } else {
        if (current) result.projects.push(current);
        current = { title: line, description: [] };
      }
    }
    if (current) result.projects.push(current);
  }

  return result;
}
