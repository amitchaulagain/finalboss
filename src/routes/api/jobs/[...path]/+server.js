import { json } from '@sveltejs/kit';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();

export async function GET({ params }) {
  try {
    const filePath = params.path;

    // Path traversal protection
    const resolved = path.resolve(PROJECT_ROOT, filePath);
    if (!resolved.startsWith(PROJECT_ROOT)) {
      return json({
        success: false,
        error: 'Invalid path'
      }, { status: 400 });
    }

    // Try candidate paths in priority order
    const candidates = [
      // New canonical: jobs/{platform}/{id}/job_details.json
      path.join(PROJECT_ROOT, 'jobs', filePath),
      // Legacy LinkedIn: jobs/linkedinjobs/{path}
      path.join(PROJECT_ROOT, 'jobs', 'linkedinjobs', filePath),
      // Legacy bots: src/bots/jobs/{path} (for bots-jobs/ prefix from GET listing)
      ...(filePath.startsWith('bots-jobs/')
        ? [path.join(PROJECT_ROOT, 'src', 'bots', 'jobs', filePath.replace('bots-jobs/', ''))]
        : [path.join(PROJECT_ROOT, 'src', 'bots', 'jobs', filePath)]),
    ];

    // Multi-tenant: clients/*/jobs/{path}
    const clientsDir = path.join(PROJECT_ROOT, 'clients');
    if (filePath.startsWith('clients/') && fs.existsSync(clientsDir)) {
      candidates.push(path.join(PROJECT_ROOT, filePath));
    }

    let jobPath = null;
    for (const candidate of candidates) {
      // Re-check traversal for each resolved candidate
      const resolvedCandidate = path.resolve(candidate);
      if (!resolvedCandidate.startsWith(PROJECT_ROOT)) continue;

      if (fs.existsSync(candidate)) {
        jobPath = candidate;
        break;
      }
    }

    if (!jobPath) {
      return json({
        success: false,
        error: `Job file not found: ${filePath}`
      }, { status: 404 });
    }

    const jobData = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));

    return json({
      success: true,
      data: {
        content: jobData
      }
    });
  } catch (error) {
    console.error('Error loading job details:', error);
    return json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}
