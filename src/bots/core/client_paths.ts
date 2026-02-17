import * as fs from 'fs';
import * as path from 'path';

export function sanitizeEmailForPath(email: string): string {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return 'unknown_client';
  return normalized
    .replace(/@/g, '_at_')
    .replace(/[^a-z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

export function getClientEmailFromContext(ctx: any): string {
  const fromFormData = ctx?.config?.formData?.email;
  const fromConfig = ctx?.config?.email;
  const fromContext = ctx?.clientEmail;
  const fromEnv = process.env.CLIENT_EMAIL;
  return String(fromFormData || fromConfig || fromContext || fromEnv || '').trim().toLowerCase();
}

export function getClientRootDir(clientEmail: string): string {
  return path.join(process.cwd(), 'clients', sanitizeEmailForPath(clientEmail));
}

export function getClientJobDir(clientEmail: string, platform: 'seek' | 'linkedin' | 'indeed' | 'other', jobId: string): string {
  return path.join(getClientRootDir(clientEmail), 'jobs', platform, String(jobId));
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function getLegacyJobDir(platform: 'seek' | 'linkedin' | 'indeed' | 'other', jobId: string): string {
  return path.join(process.cwd(), 'jobs', platform, String(jobId));
}

export function getJobArtifactDir(ctx: any, platform: 'seek' | 'linkedin' | 'indeed' | 'other', jobId: string): string {
  const clientEmail = getClientEmailFromContext(ctx);
  if (clientEmail) {
    const dir = getClientJobDir(clientEmail, platform, jobId);
    ensureDir(dir);
    return dir;
  }
  const legacy = getLegacyJobDir(platform, jobId);
  ensureDir(legacy);
  return legacy;
}

export function getJobArtifactCandidates(ctx: any, platform: 'seek' | 'linkedin' | 'indeed' | 'other', jobId: string): string[] {
  const dirs: string[] = [];
  const clientEmail = getClientEmailFromContext(ctx);
  if (clientEmail) {
    dirs.push(getClientJobDir(clientEmail, platform, jobId));
  }
  // New canonical path
  dirs.push(getLegacyJobDir(platform, jobId));
  // Old legacy paths as read fallbacks
  if (platform === 'linkedin') {
    dirs.push(path.join(process.cwd(), 'jobs', 'linkedinjobs', String(jobId)));
  }
  dirs.push(path.join(process.cwd(), 'src', 'bots', 'jobs', String(jobId)));
  return Array.from(new Set(dirs));
}
