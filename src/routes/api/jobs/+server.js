import { json } from '@sveltejs/kit';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();

/**
 * Scan a directory for job subdirs containing job_details.json,
 * and optionally flat .json files at the top level.
 */
function scanJobDir(dirPath, platform, includeFlatJson = false) {
  const jobs = [];
  if (!fs.existsSync(dirPath)) return jobs;

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return jobs;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const detailsPath = path.join(dirPath, entry.name, 'job_details.json');
      if (fs.existsSync(detailsPath)) {
        try {
          const raw = fs.readFileSync(detailsPath, 'utf-8');
          const jobData = JSON.parse(raw);
          const jobId = jobData.job_id || jobData.jobId || entry.name;
          const detectedPlatform = platform || detectPlatform(jobData);
          jobs.push({
            filename: `${detectedPlatform}/${entry.name}/job_details.json`,
            company: jobData.company || 'Unknown',
            title: jobData.title || 'No title',
            location: jobData.location || '',
            jobId: String(jobId),
            hasJobDetails: !!jobData.description || !!jobData.details,
            size: Buffer.byteLength(raw),
            platform: detectedPlatform
          });
        } catch (err) {
          console.error(`Failed to parse job ${entry.name}:`, err.message);
        }
      }
    } else if (includeFlatJson && entry.isFile() && entry.name.endsWith('.json')) {
      const filePath = path.join(dirPath, entry.name);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const jobData = JSON.parse(raw);
        const jobId = jobData.job_id || jobData.jobId || entry.name.replace('.json', '');
        const detectedPlatform = platform || detectPlatform(jobData);
        jobs.push({
          filename: `${detectedPlatform}/${entry.name}`,
          company: jobData.company || 'Unknown',
          title: jobData.title || 'No title',
          location: jobData.location || '',
          jobId: String(jobId),
          hasJobDetails: !!jobData.description || !!jobData.details,
          size: Buffer.byteLength(raw),
          platform: detectedPlatform
        });
      } catch (err) {
        console.error(`Failed to parse flat job file ${entry.name}:`, err.message);
      }
    }
  }
  return jobs;
}

function detectPlatform(jobData) {
  const url = (jobData.url || jobData.link || '').toLowerCase();
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('seek.com')) return 'seek';
  if (url.includes('indeed.com')) return 'indeed';
  return 'other';
}

export async function GET() {
  try {
    const jobMap = new Map();

    // Helper: add jobs, skip duplicates (first write wins)
    function addJobs(list) {
      for (const job of list) {
        if (!jobMap.has(job.jobId)) {
          jobMap.set(job.jobId, job);
        }
      }
    }

    // 1. New canonical dirs (highest priority)
    addJobs(scanJobDir(path.join(PROJECT_ROOT, 'jobs', 'linkedin'), 'linkedin'));
    addJobs(scanJobDir(path.join(PROJECT_ROOT, 'jobs', 'seek'), 'seek'));
    addJobs(scanJobDir(path.join(PROJECT_ROOT, 'jobs', 'indeed'), 'indeed'));

    // 2. Legacy LinkedIn dir (subdirs + flat .json files)
    const legacyLinkedin = path.join(PROJECT_ROOT, 'jobs', 'linkedinjobs');
    for (const job of scanJobDir(legacyLinkedin, 'linkedin', true)) {
      // Remap filename to use legacy prefix so [...path] can resolve it
      job.filename = `linkedinjobs/${job.filename.replace('linkedin/', '')}`;
      if (!jobMap.has(job.jobId)) {
        jobMap.set(job.jobId, job);
      }
    }

    // 3. Legacy src/bots/jobs (Seek/Indeed, detect from url)
    const legacyBots = path.join(PROJECT_ROOT, 'src', 'bots', 'jobs');
    for (const job of scanJobDir(legacyBots, null, true)) {
      // Remap filename to use bots-legacy prefix so [...path] can resolve it
      const platformPrefix = job.filename.split('/')[0]; // detected platform
      job.filename = `bots-jobs/${job.filename.replace(`${platformPrefix}/`, '')}`;
      if (!jobMap.has(job.jobId)) {
        jobMap.set(job.jobId, job);
      }
    }

    // 4. Multi-tenant: clients/*/jobs/*/
    const clientsDir = path.join(PROJECT_ROOT, 'clients');
    if (fs.existsSync(clientsDir)) {
      try {
        for (const clientEntry of fs.readdirSync(clientsDir, { withFileTypes: true })) {
          if (!clientEntry.isDirectory()) continue;
          const clientJobsDir = path.join(clientsDir, clientEntry.name, 'jobs');
          if (!fs.existsSync(clientJobsDir)) continue;
          // Scan per-platform subdirs inside client jobs
          for (const platformEntry of fs.readdirSync(clientJobsDir, { withFileTypes: true })) {
            if (!platformEntry.isDirectory()) continue;
            const platform = platformEntry.name;
            for (const job of scanJobDir(path.join(clientJobsDir, platform), platform)) {
              job.filename = `clients/${clientEntry.name}/jobs/${job.filename}`;
              if (!jobMap.has(job.jobId)) {
                jobMap.set(job.jobId, job);
              }
            }
          }
        }
      } catch (err) {
        console.error('Error scanning clients dir:', err.message);
      }
    }

    const jobs = Array.from(jobMap.values());

    return json({
      success: true,
      data: {
        jobs
      }
    });
  } catch (error) {
    console.error('Error loading jobs:', error);
    return json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}

export async function POST({ request }) {
  try {
    const body = await request.json();
    const { company, title, location, description, platform } = body;

    if (!company || !title || !description) {
      return json({
        success: false,
        error: 'company, title, and description are required'
      }, { status: 400 });
    }

    const targetPlatform = platform || 'linkedin';
    const jobId = `manual_${Date.now()}`;
    const jobDir = path.join(PROJECT_ROOT, 'jobs', targetPlatform, jobId);

    fs.mkdirSync(jobDir, { recursive: true });

    const jobData = {
      job_id: jobId,
      company,
      title,
      location: location || '',
      description,
      platform: targetPlatform,
      created_at: new Date().toISOString()
    };

    const filePath = path.join(jobDir, 'job_details.json');
    fs.writeFileSync(filePath, JSON.stringify(jobData, null, 2));

    return json({
      success: true,
      data: {
        jobId,
        filename: `${targetPlatform}/${jobId}/job_details.json`
      }
    });
  } catch (error) {
    console.error('Error saving job:', error);
    return json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}
