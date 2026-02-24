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

  // ── Sidebar ──────────────────────────────────────────────────────────────

  const sidebarSections: string[] = [];

  // Contact block (always in sidebar)
  const contactItems: string[] = [];
  if (pi.address) contactItems.push(`<div><strong>Address</strong><br>${esc(pi.address)}</div>`);
  if (pi.phone) contactItems.push(`<div><strong>Phone</strong><br>${esc(pi.phone)}</div>`);
  if (pi.email) contactItems.push(`<div><strong>Email</strong><br>${esc(pi.email)}</div>`);
  if (pi.linkedin) contactItems.push(`<div><strong>LinkedIn</strong><br>${esc(pi.linkedin)}</div>`);
  if (pi.github) contactItems.push(`<div><strong>GitHub</strong><br>${esc(pi.github)}</div>`);
  if (pi.website) contactItems.push(`<div><strong>Website</strong><br>${esc(pi.website)}</div>`);
  (pi.contactExtras ?? []).forEach(e => {
    if (e.value) contactItems.push(`<div><strong>${esc(e.label || 'Other')}</strong><br>${esc(e.value)}</div>`);
  });
  if (contactItems.length) {
    sidebarSections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('contact', 'Contact'))}</div>
        <div class="contact-block">${contactItems.join('')}</div>
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
    const skillHtml = Array.from(byCategory.entries())
      .map(([cat, names]) => `<div class="skill-cat"><strong>${esc(cat)}</strong><br>${names.join(', ')}</div>`)
      .join('');
    sidebarSections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('skills', 'Skills'))}</div>
        ${skillHtml}
      </div>`);
  }

  // Languages
  if (!hidden.has('languages') && langs.length) {
    const langItems = langs.map(l =>
      `<li>${esc(l.name)} — ${esc(l.proficiency)}</li>`
    ).join('');
    sidebarSections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('languages', 'Languages'))}</div>
        <ul class="dash-list">${langItems}</ul>
      </div>`);
  }

  // Certifications
  if (!hidden.has('certifications') && certs.length) {
    const certItems = certs.map(c =>
      `<li>${esc(c.name)}${c.issuer ? `<br><span class="sub">${esc(c.issuer)}</span>` : ''}${c.date ? ` (${esc(c.date)})` : ''}</li>`
    ).join('');
    sidebarSections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('certifications', 'Certifications'))}</div>
        <ul class="dash-list">${certItems}</ul>
      </div>`);
  }

  // ── Main Column ───────────────────────────────────────────────────────────

  const mainSections: string[] = [];

  // Summary (not standard for this template, but support it if present)
  if (!hidden.has('summary') && resume.summary?.trim()) {
    mainSections.push(`
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
        <ul class="dash-list">
          ${e.achievements.filter(a => a.trim()).map(a => `<li>${esc(a)}</li>`).join('')}
        </ul>
        ${e.technologies?.length ? `<div class="tech-line">Technologies: ${esc(e.technologies.join(', '))}</div>` : ''}
      </div>`).join('');
    mainSections.push(`
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
        ${e.gpa ? `<div class="body-text small-text">GPA: ${esc(e.gpa)}</div>` : ''}
        ${e.honors?.length ? `<ul class="dash-list">${e.honors.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
      </div>`).join('');
    mainSections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('education', 'Education'))}</div>
        ${eduEntries}
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
        <ul class="dash-list">
          ${p.description.filter(d => d.trim()).map(d => `<li>${esc(d)}</li>`).join('')}
        </ul>
      </div>`).join('');
    mainSections.push(`
      <div class="section">
        <div class="section-title">${esc(sTitle('projects', 'Projects'))}</div>
        ${projEntries}
      </div>`);
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: white; }
.page {
  width: 210mm;
  min-height: 297mm;
  padding: 12mm 15mm;
  font-family: 'Source Sans Pro', Calibri, Arial, sans-serif;
  font-size: 10pt;
  color: #272727;
  background: white;
  display: flex;
  flex-direction: column;
}
.header {
  padding-bottom: 5mm;
  margin-bottom: 5mm;
  border-bottom: 2px solid #2F5496;
}
.name {
  font-size: 24pt;
  font-weight: 700;
  color: #2F5496;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  line-height: 1.1;
}
.job-title {
  font-size: 11pt;
  color: #595959;
  font-style: italic;
  margin-top: 1.5mm;
}
.columns {
  display: flex;
  gap: 8mm;
  align-items: flex-start;
  flex: 1;
}
.sidebar {
  flex: 0 0 35%;
  border-right: 1px solid #2F5496;
  padding-right: 6mm;
}
.main-col {
  flex: 1;
  min-width: 0;
}
.section {
  margin-bottom: 5mm;
}
.section-title {
  font-weight: 700;
  font-size: 9pt;
  text-transform: uppercase;
  color: #2F5496;
  border-bottom: 1px solid #2F5496;
  padding-bottom: 1mm;
  margin-bottom: 3mm;
  letter-spacing: 0.5px;
}
.contact-block div {
  font-size: 8.5pt;
  margin-bottom: 2.5mm;
  line-height: 1.35;
  word-break: break-word;
}
.skill-cat {
  font-size: 8.5pt;
  margin-bottom: 2.5mm;
  line-height: 1.4;
}
.dash-list {
  list-style: none;
  padding: 0;
}
.dash-list li {
  font-size: 9pt;
  margin-bottom: 1.5mm;
  line-height: 1.4;
  padding-left: 4mm;
}
.dash-list li::before {
  content: "– ";
  color: #2F5496;
  margin-left: -4mm;
}
.sub {
  color: #595959;
  font-size: 8pt;
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
  font-weight: 700;
  font-size: 10pt;
  color: #272727;
}
.entry-date {
  font-size: 8.5pt;
  color: #595959;
  white-space: nowrap;
  margin-left: 3mm;
  flex-shrink: 0;
}
.entry-sub {
  font-size: 9.5pt;
  color: #595959;
  font-style: italic;
  margin-top: 0.5mm;
  margin-bottom: 1.5mm;
}
.entry .dash-list li {
  font-size: 9.5pt;
}
.body-text {
  font-size: 10pt;
  line-height: 1.5;
}
.small-text {
  font-size: 8.5pt;
}
.tech-line {
  font-size: 8.5pt;
  color: #595959;
  font-style: italic;
  margin-top: 1mm;
}
</style></head><body><div class="page">
  <div class="header">
    <div class="name">${esc(pi.fullName)}</div>
    ${pi.title ? `<div class="job-title">${esc(pi.title)}</div>` : ''}
  </div>
  <div class="columns">
    <div class="sidebar">${sidebarSections.join('')}</div>
    <div class="main-col">${mainSections.join('')}</div>
  </div>
</div></body></html>`;
}
