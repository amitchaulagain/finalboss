import type { ResumeData } from '../../types';

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function dateRange(start: string | undefined, end: string | null | undefined): string {
  if (!start) return '';
  const endStr = end === null || end === undefined ? 'Present' : (end || 'Present');
  return `${start} – ${endStr}`;
}

export function generate(
  resume: ResumeData,
  sectionTitles?: Record<string, string>,
  hiddenSections?: string[]
): string {
  const hidden = new Set(hiddenSections ?? resume.hiddenSections ?? []);
  const sTitle = (id: string, def: string) =>
    (sectionTitles ?? resume.sectionTitles)?.[id] ?? def;

  const pi = resume.personalInfo;
  const exp = resume.experience ?? [];
  const edu = resume.education ?? [];
  const skills = resume.skills ?? [];
  const certs = resume.certifications ?? [];
  const projects = resume.projects ?? [];
  const langs = resume.languages ?? [];

  // Contact line
  const contactParts: string[] = [];
  if (pi.phone) contactParts.push(esc(pi.phone));
  if (pi.email) contactParts.push(esc(pi.email));
  if (pi.linkedin) contactParts.push(esc(pi.linkedin));
  if (pi.github) contactParts.push(esc(pi.github));
  if (pi.website) contactParts.push(esc(pi.website));
  if (pi.address) contactParts.push(esc(pi.address));
  (pi.contactExtras ?? []).forEach(e => {
    if (e.value) contactParts.push(e.label ? `${esc(e.label)}: ${esc(e.value)}` : esc(e.value));
  });

  const sections: string[] = [];

  // Summary
  if (!hidden.has('summary') && resume.summary?.trim()) {
    sections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('summary', 'Summary'))}</div>
        <p class="body-text">${esc(resume.summary)}</p>
      </div>`);
  }

  // Experience
  if (!hidden.has('experience') && exp.length) {
    const expEntries = exp.map(e => `
      <div class="entry">
        <div class="entry-header">
          <span class="entry-title">${esc(e.jobTitle)}</span>
          <span class="entry-date">${esc(dateRange(e.startDate, e.endDate))}</span>
        </div>
        <div class="entry-sub">${esc(e.company)}${e.location ? `, ${esc(e.location)}` : ''}</div>
        <ul class="bullet-list">
          ${e.achievements.filter(a => a.trim()).map(a => `<li>${esc(a)}</li>`).join('')}
        </ul>
      </div>`).join('');
    sections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('experience', 'Experience'))}</div>
        ${expEntries}
      </div>`);
  }

  // Education
  if (!hidden.has('education') && edu.length) {
    const eduEntries = edu.map(e => `
      <div class="entry">
        <div class="entry-header">
          <span class="entry-title">${esc(e.degree)}</span>
          <span class="entry-date">${esc(e.graduationDate)}</span>
        </div>
        <div class="entry-sub">${esc(e.institution)}${e.location ? `, ${esc(e.location)}` : ''}</div>
        ${e.gpa ? `<div class="body-text">GPA: ${esc(e.gpa)}</div>` : ''}
      </div>`).join('');
    sections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('education', 'Education'))}</div>
        ${eduEntries}
      </div>`);
  }

  // Skills
  if (!hidden.has('skills') && skills.length) {
    const byCategory = new Map<string, string[]>();
    skills.forEach(s => {
      const cat = s.category || 'Skills';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(esc(s.name));
    });
    const skillRows = Array.from(byCategory.entries())
      .map(([cat, names]) => `<div class="skill-row"><strong>${esc(cat)}:</strong> ${names.join(', ')}</div>`)
      .join('');
    sections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('skills', 'Skills'))}</div>
        ${skillRows}
      </div>`);
  }

  // Certifications
  if (!hidden.has('certifications') && certs.length) {
    const certEntries = certs.map(c => `
      <div class="entry-row">
        <strong>${esc(c.name)}</strong>${c.issuer ? ` — ${esc(c.issuer)}` : ''}${c.date ? ` (${esc(c.date)})` : ''}
      </div>`).join('');
    sections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('certifications', 'Certifications'))}</div>
        ${certEntries}
      </div>`);
  }

  // Projects
  if (!hidden.has('projects') && projects.length) {
    const projEntries = projects.map(p => `
      <div class="entry">
        <div class="entry-header">
          <span class="entry-title">${esc(p.title)}</span>
          ${p.startDate ? `<span class="entry-date">${esc(dateRange(p.startDate, p.endDate))}</span>` : ''}
        </div>
        ${p.organization ? `<div class="entry-sub">${esc(p.organization)}</div>` : ''}
        <ul class="bullet-list">
          ${p.description.filter(d => d.trim()).map(d => `<li>${esc(d)}</li>`).join('')}
        </ul>
        ${p.technologies?.length ? `<div class="tech-line">Technologies: ${esc(p.technologies.join(', '))}</div>` : ''}
      </div>`).join('');
    sections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('projects', 'Projects'))}</div>
        ${projEntries}
      </div>`);
  }

  // Languages
  if (!hidden.has('languages') && langs.length) {
    const langItems = langs.map(l => `<li>${esc(l.name)} — ${esc(l.proficiency)}</li>`).join('');
    sections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('languages', 'Languages'))}</div>
        <ul class="bullet-list">${langItems}</ul>
      </div>`);
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: white; }
.page {
  width: 210mm;
  min-height: 297mm;
  padding: 15mm 20mm;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 10.5pt;
  color: #333;
  background: white;
}
.header {
  text-align: center;
  margin-bottom: 10mm;
  padding-bottom: 6mm;
  border-bottom: 2px solid #1a1a1a;
}
.name {
  font-size: 26pt;
  font-weight: bold;
  color: #1a1a1a;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 2mm;
}
.job-title {
  font-size: 11.5pt;
  color: #4495A2;
  font-style: italic;
  margin-bottom: 3mm;
}
.contact-line {
  font-size: 9.5pt;
  color: #555;
  line-height: 1.5;
}
.section {
  margin-bottom: 6mm;
}
.section-title {
  font-weight: bold;
  font-size: 10.5pt;
  color: #1a1a1a;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  border-bottom: 2px solid #1a1a1a;
  padding-bottom: 1.5mm;
  margin-bottom: 4mm;
}
.entry {
  margin-bottom: 4mm;
}
.entry-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.entry-title {
  font-weight: bold;
  font-size: 10.5pt;
  color: #1a1a1a;
}
.entry-date {
  font-size: 9.5pt;
  color: #666;
  white-space: nowrap;
  margin-left: 4mm;
}
.entry-sub {
  font-size: 10pt;
  color: #555;
  font-style: italic;
  margin-top: 0.5mm;
  margin-bottom: 2mm;
}
.bullet-list {
  list-style: disc;
  padding-left: 5mm;
}
.bullet-list li {
  font-size: 10pt;
  margin-bottom: 1.5mm;
  line-height: 1.5;
  color: #333;
}
.body-text {
  font-size: 10.5pt;
  line-height: 1.6;
  color: #333;
}
.skill-row {
  font-size: 10pt;
  margin-bottom: 2mm;
  line-height: 1.5;
}
.entry-row {
  font-size: 10pt;
  margin-bottom: 2mm;
  line-height: 1.5;
}
.tech-line {
  font-size: 9.5pt;
  color: #666;
  font-style: italic;
  margin-top: 1.5mm;
}
</style></head><body><div class="page">
  <div class="header">
    <div class="name">${esc(pi.fullName)}</div>
    ${pi.title ? `<div class="job-title">${esc(pi.title)}</div>` : ''}
    ${contactParts.length ? `<div class="contact-line">${contactParts.join(' | ')}</div>` : ''}
  </div>
  ${sections.join('\n')}
</div></body></html>`;
}
