import { json } from '@sveltejs/kit';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const PLATFORMS = ['seek', 'linkedin', 'indeed'];

export async function GET() {
	const jobsDir = join(process.cwd(), 'jobs');
	const results = [];

	for (const platform of PLATFORMS) {
		const platformDir = join(jobsDir, platform);
		if (!existsSync(platformDir)) continue;

		let entries;
		try {
			entries = await readdir(platformDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const jobId = entry.name;
			const detailsPath = join(platformDir, jobId, 'job_details.json');

			try {
				const raw = await readFile(detailsPath, 'utf8');
				const details = JSON.parse(raw);
				results.push({
					jobId,
					title: details.title || details.raw_title || `Job ${jobId}`,
					company: details.company || 'Unknown',
					platform,
					basePath: `jobs/${platform}/${jobId}`
				});
			} catch {
				// Skip job dirs without readable job_details.json
			}
		}
	}

	// Sort: most recently modified first (newest job ID descending within each platform)
	results.sort((a, b) => {
		if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
		return b.jobId.localeCompare(a.jobId);
	});

	return json(results);
}
