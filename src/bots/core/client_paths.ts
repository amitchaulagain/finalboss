import * as fs from 'fs';
import * as path from 'path';

export function getClientEmailFromContext(ctx: any): string {
  const fromFormData = ctx?.config?.formData?.email;
  const fromConfig = ctx?.config?.email;
  const fromContext = ctx?.clientEmail;
  const fromEnv = process.env.CLIENT_EMAIL;
  return String(fromFormData || fromConfig || fromContext || fromEnv || '').trim().toLowerCase();
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/** Canonical job artifact directory: jobs/{platform}/{jobId} */
export function getJobArtifactDir(ctx: any, platform: 'seek' | 'linkedin' | 'indeed' | 'other', jobId: string): string {
  const dir = path.join(process.cwd(), 'jobs', platform, String(jobId));
  ensureDir(dir);
  return dir;
}

/** Returns the single canonical path for reading job artifacts. */
export function getJobArtifactCandidates(ctx: any, platform: 'seek' | 'linkedin' | 'indeed' | 'other', jobId: string): string[] {
  return [getJobArtifactDir(ctx, platform, jobId)];
}
