import fs from 'fs';
import path from 'path';

const APP_NAME = 'FinalBoss';
const ALLOWED_RESUME_EXTENSIONS = ['.doc', '.docx', '.pdf'];

type ManagedFileEntry = {
  id: string;
  feature: string;
  filename: string;
  relative_path?: string;
  relativePath?: string;
  updated_at?: string;
  updatedAt?: string;
  tags?: string[];
};

type ManagedFileIndex = {
  version: number;
  entries: ManagedFileEntry[];
};

function sanitizeSegment(input: string): string {
  const raw = String(input || '');
  let out = '';
  for (const ch of raw) {
    if (/^[a-zA-Z0-9._-]$/.test(ch)) out += ch;
    else out += '_';
  }
  const trimmed = out.replace(/^_+|_+$/g, '');
  return trimmed || 'unknown';
}

function getAppDataRoot(): string {
  const home = process.env.HOME || '';
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, APP_NAME.toLowerCase());
}

function getUserRoot(userId: string): string {
  return path.join(getAppDataRoot(), 'users', sanitizeSegment(userId));
}

function getIndexPath(userId: string): string {
  return path.join(getUserRoot(userId), 'index', 'files-index.json');
}

function isSupportedResumeFile(name: string): boolean {
  const lower = String(name || '').toLowerCase();
  return ALLOWED_RESUME_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function loadIndex(userId: string): ManagedFileIndex {
  const indexPath = getIndexPath(userId);
  if (!fs.existsSync(indexPath)) {
    return { version: 1, entries: [] };
  }
  const raw = fs.readFileSync(indexPath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    version: Number(parsed?.version || 1),
    entries: Array.isArray(parsed?.entries) ? parsed.entries : []
  };
}

function resolveEntryPath(userId: string, entry: ManagedFileEntry): string {
  const userRoot = getUserRoot(userId);
  const rel = String(entry.relativePath || entry.relative_path || '');
  if (!rel || path.isAbsolute(rel)) {
    throw new Error('Managed file path must be relative');
  }
  const normalizedRel = rel.split('/').join(path.sep);
  const parts = normalizedRel.split(path.sep);
  if ((parts[0] !== 'storage' && parts[0] !== 'resumes') || parts.includes('..')) {
    throw new Error('Invalid managed file path');
  }
  const full = path.join(userRoot, normalizedRel);
  if (!full.startsWith(userRoot)) {
    throw new Error('Managed file path escaped user root');
  }
  return full;
}

function sortByUpdatedDesc(a: ManagedFileEntry, b: ManagedFileEntry): number {
  const aTs = Number(a.updatedAt || a.updated_at || 0);
  const bTs = Number(b.updatedAt || b.updated_at || 0);
  return bTs - aTs;
}

export function resolveCanonicalResumePath(userId: string, preferredResumeFileName = ''): { filename: string; filePath: string } {
  if (!userId) {
    throw new Error('Missing userId. Cannot resolve canonical resume path.');
  }
  const index = loadIndex(userId);
  const candidates = index.entries
    .filter((entry) => entry.feature === 'resume' && isSupportedResumeFile(entry.filename))
    .sort(sortByUpdatedDesc);

  if (candidates.length === 0) {
    throw new Error(`No canonical .doc/.docx/.pdf resume files found for userId ${userId}`);
  }

  const selected =
    (preferredResumeFileName
      ? candidates.find((entry) => entry.filename === preferredResumeFileName)
      : undefined) ||
    candidates.find((entry) => entry.filename.toLowerCase().includes('resume')) ||
    candidates[0];

  const fullPath = resolveEntryPath(userId, selected);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Resume file not found on disk: ${fullPath}`);
  }
  return { filename: selected.filename, filePath: fullPath };
}

export function resolveBaseResumeJson(userId: string): Record<string, unknown> | null {
  if (!userId) return null;
  try {
    const index = loadIndex(userId);
    const candidates = index.entries
      .filter(
        (entry) =>
          entry.feature === 'resume' &&
          String(entry.filename || '').toLowerCase().endsWith('.json') &&
          Array.isArray(entry.tags) &&
          entry.tags.includes('base-resume')
      )
      .sort(sortByUpdatedDesc);

    if (candidates.length === 0) return null;

    const selected = candidates[0];
    const fullPath = resolveEntryPath(userId, selected);
    if (!fs.existsSync(fullPath)) return null;
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

export function listCanonicalResumeNames(userId: string): string[] {
  const index = loadIndex(userId);
  return index.entries
    .filter((entry) => entry.feature === 'resume' && isSupportedResumeFile(entry.filename))
    .sort(sortByUpdatedDesc)
    .map((entry) => entry.filename);
}

export function readCanonicalResumeText(userId: string, preferredResumeFileName = ''): { filename: string; content: string } {
  if (!userId) {
    throw new Error('Missing userId. Cannot resolve canonical resume.');
  }
  const index = loadIndex(userId);
  const candidates = index.entries
    .filter((entry) => entry.feature === 'resume' && isSupportedResumeFile(entry.filename))
    .sort(sortByUpdatedDesc);

  if (candidates.length === 0) {
    throw new Error(`No canonical .doc/.docx/.pdf resume files found for userId ${userId}`);
  }

  const selected =
    (preferredResumeFileName
      ? candidates.find((entry) => entry.filename === preferredResumeFileName)
      : undefined) ||
    candidates.find((entry) => entry.filename.toLowerCase().includes('resume')) ||
    candidates[0];

  const fullPath = resolveEntryPath(userId, selected);
  const content = fs.readFileSync(fullPath, 'utf8').trim();
  if (!content) {
    throw new Error(`Canonical resume file ${selected.filename} is empty for userId ${userId}`);
  }
  return { filename: selected.filename, content };
}
