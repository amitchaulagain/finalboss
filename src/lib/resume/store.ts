/**
 * Resume Store
 * Centralized state management for resumes using Svelte stores
 */

import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import type { ResumeData, WorkExperience, Education, Skill, Certification, Project, Language } from './types';
import { getTemplateById } from './templates';

// Generate UUID helper (fallback if uuid not available)
function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Store for all user resumes
const createResumesStore = () => {
  const { subscribe, set, update } = writable<ResumeData[]>([]);
  
  // Add function defined outside return so it can be used by duplicate
  function add(resume: Omit<ResumeData, 'id' | 'createdAt' | 'updatedAt'>): ResumeData {
    const newResume: ResumeData = {
      ...resume,
      id: generateId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    update(resumes => [...resumes, newResume]);
    return newResume;
  }
  
  return {
    subscribe,
    set,
    update,
    // Get a specific resume by ID
    getById: (id: string): ResumeData | undefined => {
      const resumes = get({ subscribe });
      return resumes.find(r => r.id === id);
    },
    // Add a new resume
    add,
    // Update an existing resume
    updateById: (id: string, updates: Partial<ResumeData>): void => {
      update(resumes => 
        resumes.map(r => 
          r.id === id 
            ? { ...r, ...updates, updatedAt: new Date().toISOString() }
            : r
        )
      );
    },
    // Delete a resume
    delete: (id: string): void => {
      update(resumes => resumes.filter(r => r.id !== id));
    },
    // Duplicate a resume
    duplicate: (id: string): ResumeData | undefined => {
      const resume = get({ subscribe }).find(r => r.id === id);
      if (resume) {
        return add({
          ...resume,
          title: `${resume.title} (Copy)`,
          isBase: false,
        });
      }
    },
    // Set one resume as base (clears all others)
    setBase: (id: string): void => {
      update(resumes =>
        resumes.map(r => ({ ...r, isBase: r.id === id }))
      );
    },
  };
};

export const resumesStore = createResumesStore();

// Store for the currently active/editing resume
export const activeResume = writable<ResumeData | null>(null);

// Temporary store for a resume that hasn't been saved yet (draft before first Save)
export const draftResume = writable<ResumeData | null>(null);

// Store for available templates
export const templates = writable<any[]>([]); // Will be imported from templates

// ── Standalone setBase export ────────────────────────────────────────────────

/**
 * Set a resume as the base/primary resume (clears isBase on all others)
 */
export function setBase(id: string): void {
  resumesStore.setBase(id);
  autoSave();
}

// ── createResumeFromConfig ───────────────────────────────────────────────────

/** Return the first non-empty, non-'N/A' value, or empty string. */
function pick(...sources: (string | undefined | null)[]): string {
  for (const s of sources) {
    const v = s?.trim();
    if (v && v !== 'N/A') return v;
  }
  return '';
}

/**
 * Create a new resume pre-filled from user-config.json data.
 *
 * Personal info (fullName, email, phone, linkedin, address) is taken from
 * `formData` (the user's saved configuration).
 *
 * All other sections (experience, education, skills, …) are populated from
 * `parsedResume` only when that argument is explicitly supplied (e.g. when
 * saving an AI-enhanced resume). When called without `parsedResume` — i.e.
 * for a fresh template selection — all content sections start as single blank
 * placeholder entries so the edit-page inputs show their placeholder text.
 */
export function createResumeFromConfig(
  templateId: string,
  title: string = 'My Resume',
  formData?: Record<string, any>,
  parsedResume?: any
): ResumeData {
  const template = getTemplateById(templateId);
  if (!template) throw new Error(`Template not found: ${templateId}`);

  const f = formData || {};
  const pr = parsedResume || {};
  const pi = pr.personalInfo || {};

  // Whether the caller supplied a real parsed resume (e.g. AI enhancement save)
  const hasParsed = parsedResume != null;

  return {
    id: generateId(),
    title,
    isBase: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    templateId,
    // Personal info always comes from the user's saved configuration.
    personalInfo: {
      fullName: pick(f.fullName, pi.fullName),
      title:    pick(pi.title),
      email:    pick(f.email, pi.email),
      phone:    pick(f.phone, pi.phone),
      linkedin: pick(f.linkedinUrl, pi.linkedin),
      github:   pick(pi.github),
      address:  pick(f.address, pi.address),
    },
    // Content sections: use parsed data only when explicitly provided.
    summary: hasParsed ? (pr.summary?.trim() || '') : '',
    experience: hasParsed && pr.experience?.length
      ? pr.experience.map((e: any) => ({
          id: generateId(),
          jobTitle:     e.jobTitle  || '',
          company:      e.company   || '',
          location:     e.location  || '',
          startDate:    e.startDate || '',
          endDate:      e.endDate   || 'Present',
          achievements: Array.isArray(e.achievements) && e.achievements.length
            ? e.achievements.filter(Boolean)
            : [],
        }))
      : [createExperience()],
    education: hasParsed && pr.education?.length
      ? pr.education.map((e: any) => ({
          id: generateId(),
          degree:         e.degree         || '',
          institution:    e.institution    || '',
          graduationDate: e.graduationDate || '',
          gpa:            e.gpa            || '',
        }))
      : [createEducation()],
    skills: hasParsed && pr.skills?.length
      ? pr.skills.map((s: any) => createSkill(s.name || '', s.category || 'General'))
      : [createSkill()],
    certifications: hasParsed
      ? (pr.certifications || []).map((c: any) => ({
          id: generateId(), name: c.name || '', issuer: c.issuer || '', date: c.date || ''
        }))
      : [],
    projects: hasParsed
      ? (pr.projects || []).map((p: any) => ({
          id: generateId(), title: p.title || '',
          description: Array.isArray(p.description) ? p.description.filter(Boolean) : []
        }))
      : [],
    languages: hasParsed
      ? (pr.languages || []).map((l: any) => ({
          id: generateId(), name: l.name || '', proficiency: l.proficiency || 'Intermediate'
        }))
      : [],
    customSections: [],
  };
}

/**
 * Create a new empty resume with a template (delegates to createResumeFromConfig)
 */
export function createEmptyResume(templateId: string, title: string = 'New Resume'): ResumeData {
  return createResumeFromConfig(templateId, title);
}

/**
 * Create a new experience entry
 */
export function createExperience(): WorkExperience {
  return {
    id: generateId(),
    jobTitle: '',
    company: '',
    startDate: '',
    endDate: null,
    achievements: [],
  };
}

/**
 * Create a new education entry
 */
export function createEducation(): Education {
  return {
    id: generateId(),
    degree: '',
    institution: '',
    graduationDate: '',
  };
}

/**
 * Create a new skill
 */
export function createSkill(name: string = '', category: string = ''): Skill {
  return {
    id: generateId(),
    name,
    category,
  };
}

/**
 * Create a new certification
 */
export function createCertification(): Certification {
  return {
    id: generateId(),
    name: '',
    issuer: '',
    date: '',
  };
}

/**
 * Create a new project
 */
export function createProject(): Project {
  return {
    id: generateId(),
    title: '',
    description: [],
  };
}

/**
 * Create a new language
 */
export function createLanguage(): Language {
  return {
    id: generateId(),
    name: '',
    proficiency: 'Intermediate',
  };
}

// ── N/A migration ────────────────────────────────────────────────────────────

/**
 * Replace every 'N/A' placeholder string that the old PDF-extraction system
 * wrote into saved resumes with an empty string, so the edit-page inputs
 * show their HTML placeholder text instead of the orange 'N/A' value.
 */
function normalizeResumeData(r: ResumeData): ResumeData {
  const c = (v: string | null | undefined): string =>
    !v || v.trim() === 'N/A' ? '' : v;

  return {
    ...r,
    summary: c(r.summary),
    personalInfo: {
      ...r.personalInfo,
      title:    c(r.personalInfo.title),
      github:   c(r.personalInfo.github ?? ''),
      address:  c(r.personalInfo.address ?? ''),
    },
    experience: (r.experience || []).map(e => ({
      ...e,
      jobTitle:     c(e.jobTitle),
      company:      c(e.company),
      location:     c(e.location),
      startDate:    c(e.startDate),
      endDate:      e.endDate === 'N/A' ? null : e.endDate,
      achievements: (e.achievements || [])
        .map(a => c(a))
        .filter(a => a !== ''),
    })),
    education: (r.education || []).map(e => ({
      ...e,
      degree:         c(e.degree),
      institution:    c(e.institution),
      graduationDate: c(e.graduationDate),
    })),
    skills: (r.skills || []).map(s => ({
      ...s,
      name: c(s.name),
    })),
    certifications: (r.certifications || []).map(cert => ({
      ...cert,
      name:   c(cert.name),
      issuer: c(cert.issuer),
    })),
    projects: (r.projects || []).map(p => ({
      ...p,
      title:       c(p.title),
      description: (p.description || []).map(d => c(d)).filter(d => d !== ''),
    })),
    languages: (r.languages || []).map(l => ({
      ...l,
      name: c(l.name),
    })),
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Initialize the store with any persisted resumes.
 * Any legacy 'N/A' strings are normalised to '' on first load.
 */
export async function loadResumes(): Promise<void> {
  if (!browser) return;

  try {
    const stored = localStorage.getItem('questBot_resumes');
    if (stored) {
      const raw: ResumeData[] = JSON.parse(stored);
      const resumes = raw.map(normalizeResumeData);
      resumesStore.set(resumes);
      // Persist the cleaned data so normalization only runs once
      localStorage.setItem('questBot_resumes', JSON.stringify(resumes));
    }
  } catch (error) {
    console.error('Failed to load resumes:', error);
  }
}

/**
 * Persist resumes to storage
 */
export async function saveResumes(): Promise<void> {
  if (!browser) return;
  
  try {
    const resumes = get(resumesStore);
    localStorage.setItem('questBot_resumes', JSON.stringify(resumes));
    
    // TODO: Save to Tauri file system in production
  } catch (error) {
    console.error('Failed to save resumes:', error);
  }
}

/**
 * Auto-save function - call this whenever resumes change
 */
export function autoSave(): void {
  // Don't await - fire and forget for auto-save
  saveResumes().catch(err => console.error('Auto-save failed:', err));
}

