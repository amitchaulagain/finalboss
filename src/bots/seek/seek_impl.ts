import { WebDriver, By } from 'selenium-webdriver';
import { setupChromeDriver } from '../core/browser_manager';
import { HumanBehavior, StealthFeatures, DEFAULT_HUMANIZATION } from '../core/humanization';
import { UniversalSessionManager, SessionConfigs } from '../core/sessionManager';
import { UniversalOverlay } from '../core/universal_overlay';
import type { WorkflowContext } from '../core/workflow_engine';
import { handleResumeSelection } from './handlers/resume_handler';
import { handleCoverLetter } from './handlers/cover_letter_handler';
import { answerEmployerQuestions as handleEmployerQuestions } from './handlers/answer_employer_questions';
import { extractEmployerQuestions } from './handlers/extract_employer_questions';
import { recordJobApplicationToBackend, getJobDirPathFromJobFile } from '../core/job_application_recorder';
import { getJobArtifactDir, getClientEmailFromContext } from '../core/client_paths';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const BASE_URL = "https://www.seek.com.au";

const printLog = (message: string) => {
  console.log(message);
};

/**
 * Parse HR contact, required skills, and required experience from job details text.
 * Used so Job Analytics can show these in the Job details tab.
 */
function parseJobDetailsFromText(details: string): {
  hrContact?: { name?: string; email?: string; phone?: string };
  requiredSkills?: string[];
  requiredExperience?: string;
} {
  const result: {
    hrContact?: { name?: string; email?: string; phone?: string };
    requiredSkills?: string[];
    requiredExperience?: string;
  } = {};
  if (!details || typeof details !== 'string') return result;

  const text = details.trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // --- Email ---
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const emails = text.match(emailRegex);
  if (emails && emails.length > 0) {
    result.hrContact = result.hrContact || {};
    result.hrContact.email = emails[0];
  }

  // --- Phone (AU-style and generic) ---
  const phoneRegex = /(?:\+61|0)[\s.-]?\(?\d\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b|\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4}\b|\b\d{8,10}\b/g;
  const phones = text.match(phoneRegex);
  if (phones && phones.length > 0) {
    result.hrContact = result.hrContact || {};
    result.hrContact.phone = phones[0].replace(/\s+/g, ' ').trim();
  }

  // --- Contact / Recruiter name (e.g. "Contact: John Smith", "Recruiter: Jane") ---
  const contactNamePatterns = [
    /(?:Contact|Recruiter|HR|Enquiries?)\s*[:\-]\s*([A-Za-z][A-Za-z\s.]{1,50}?)(?:\s*[|\n]|$)/i,
    /(?:contact|reach)\s+(?:me\s+at\s+)?([A-Za-z][A-Za-z\s.]{1,50}?)(?:\s+on\s+|\s*[|\n]|$)/i,
  ];
  for (const re of contactNamePatterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const name = m[1].replace(/\s+/g, ' ').trim();
      if (name.length >= 2 && name.length <= 60) {
        result.hrContact = result.hrContact || {};
        result.hrContact.name = name;
        break;
      }
    }
  }

  // --- Required skills: look for section then bullets or comma list; also inline "Skills: A, B, C" ---
  const skillInlineRegex = /^(?:Key\s+)?(?:Skills?|Technical\s+skills?|What\s+you'll\s+need|Essential\s+skills?)\s*[:\-]\s*(.+)$/i;
  const skillSectionHeaders = /^(?:Key\s+)?(?:Skills?|Requirements?|Technical\s+skills?|What\s+you'll\s+need|Essential\s+skills?)\s*[:\-]?\s*$/i;
  const bulletOrDash = /^[\s]*[-•*]\s+(.+)$/;
  const skillLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inlineMatch = line.match(skillInlineRegex);
    if (inlineMatch && inlineMatch[1].trim()) {
      const rest = inlineMatch[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      skillLines.push(...rest);
      continue;
    }
    if (skillSectionHeaders.test(line)) {
      // Next line(s) may be the list
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (/^(?:About|Responsibilities?|Experience|Benefits?|Apply)\s*[:\-]?/i.test(next) || next.length > 120) break;
        const bullet = next.match(bulletOrDash);
        if (bullet) skillLines.push(bullet[1].trim());
        else if (next.includes(',') && next.length < 200) skillLines.push(...next.split(',').map((s) => s.trim()).filter(Boolean));
        else if (next.length > 2 && next.length < 80 && !/^\d+\.?\s*$/.test(next)) skillLines.push(next);
      }
      break;
    }
  }
  if (skillLines.length > 0) {
    result.requiredSkills = [...new Set(skillLines)].slice(0, 50);
  }

  // --- Required experience: "X years' experience", "minimum X years", or block under "Experience:" ---
  const experiencePhrases: string[] = [];
  const yearsRegex = /(\d+\+?\s*(?:to\s+)?\d*\s*years?'?\s*(?:of\s+)?(?:experience|exp\.?|in\s+[A-Za-z\s]+))/gi;
  const minYearsRegex = /(?:minimum|at\s+least|min\.?)\s+\d+\+?\s*years?'?\s*(?:of\s+)?(?:experience|exp\.?)?/gi;
  for (const re of [yearsRegex, minYearsRegex]) {
    const matches = text.match(re);
    if (matches) experiencePhrases.push(...matches.map((m) => m.trim()));
  }
  const experienceHeader = /^(?:Experience|What\s+you'll\s+bring|Requirements?)\s*[:\-]?\s*$/i;
  let inExpSection = false;
  const expLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (experienceHeader.test(line)) {
      inExpSection = true;
      continue;
    }
    if (inExpSection && line.length > 10 && line.length < 500) {
      if (/^(?:About|Responsibilities?|Skills?|Benefits?|Apply)\s*[:\-]?/i.test(line)) break;
      expLines.push(line);
    }
  }
  if (experiencePhrases.length > 0 || expLines.length > 0) {
    const combined = [...experiencePhrases, ...expLines.slice(0, 5)].filter(Boolean);
    result.requiredExperience = combined.join(' ');
  }

  return result;
}

/** Log current job from context so you always know which job the bot is applying to. */
function logCurrentJob(ctx: WorkflowContext): void {
  const title = ctx.currentJobTitle ?? ctx.currentJobTitlePreview;
  const company = ctx.currentJobCompany ?? ctx.currentJobCompanyPreview;
  if (title || company) {
    printLog(`🎯 Current job: ${title || '?'} at ${company || '?'}`);
  }
}

function slugify(text: string): string {
  if (!text) return "";
  text = text.trim().toLowerCase();
  text = text.replace(/[^a-z0-9]+/g, "-");
  text = text.replace(/-+/g, "-");
  return text.replace(/^-|-$/g, "");
}

// Build search URL from keywords and location
function build_search_url(base_url: string, keywords: string, location: string): string {
  const keyword_slug = slugify(keywords);
  const location_slug = slugify(location);

  let search_path = keyword_slug ? `/${keyword_slug}-jobs` : "/jobs";
  if (location_slug) {
    search_path += `/in-${location_slug}`;
  }

  return `${base_url}${search_path}`;
}

// Step 0: Initialize Context
export async function* step0(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  const selectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/seek_selectors.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../user-bots-config.json'), 'utf8'));

  ctx.selectors = selectors;
  ctx.config = config;
  ctx.seek_url = build_search_url(BASE_URL, config.formData.keywords || "", config.formData.locations || "");

  // Initialize retry counters to prevent infinite loops
  ctx.retry_counts = {
    page_load_retries: 0,
    refresh_retries: 0,
    collect_cards_retries: 0,
    MAX_PAGE_LOAD_RETRIES: 3,
    MAX_REFRESH_RETRIES: 2,
    MAX_COLLECT_CARDS_RETRIES: 5
  };

  printLog(`Search URL: ${ctx.seek_url}`);
  yield "ctx_ready";
}

// Step 1: Open Homepage
export async function* openHomepage(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    // CRITICAL: Prevent multiple browser instances
    if (ctx.driver) {
      printLog("⚠️ Browser already exists, reusing existing instance");
      // Just navigate to the URL instead of creating new browser
      await ctx.driver.get(ctx.seek_url || `${BASE_URL}/jobs`);
      await ctx.driver.sleep(5000);

      const currentUrl = await ctx.driver.getCurrentUrl();
      const title = await ctx.driver.getTitle();

      printLog(`Current URL: ${currentUrl}`);
      printLog(`Page title: ${title}`);

      if (currentUrl && title && !title.includes('error')) {
        yield "homepage_opened";
      } else {
        yield "page_navigation_failed";
      }
      return;
    }

    const { driver, sessionExists, sessionsDir } = await setupChromeDriver('seek');
    ctx.driver = driver;
    ctx.sessionExists = sessionExists;
    ctx.sessionsDir = sessionsDir;
    ctx.humanBehavior = new HumanBehavior(DEFAULT_HUMANIZATION);
    ctx.sessionManager = new UniversalSessionManager(driver, SessionConfigs.seek);
    ctx.overlay = new UniversalOverlay(driver, 'Seek');

    await StealthFeatures.hideWebDriver(driver);
    await StealthFeatures.randomizeUserAgent(driver);

    printLog(`Opening URL: ${ctx.seek_url || `${BASE_URL}/jobs`}`);
    await driver.get(ctx.seek_url || `${BASE_URL}/jobs`);

    // Wait longer for slow networks
    printLog("Waiting for page to load...");
    await driver.sleep(5000);

    // Check if page loaded successfully
    const currentUrl = await driver.getCurrentUrl();
    const title = await driver.getTitle();

    printLog(`Current URL: ${currentUrl}`);
    printLog(`Page title: ${title}`);

    if (currentUrl && title && !title.includes('error')) {
      yield "homepage_opened";
    } else {
      printLog("Page load failed - will retry");
      yield "page_navigation_failed";
    }
  } catch (error) {
    printLog(`Homepage opening failed: ${error}`);
    yield "page_navigation_failed";
  }
}

// Step 2: Wait For Page Load
export async function* waitForPageLoad(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  await ctx.driver.sleep(2000);
  const title = await ctx.driver.getTitle();

  if (title.toLowerCase().includes('seek')) {
    // Reset retry counter on success
    ctx.retry_counts.page_load_retries = 0;
    yield "page_loaded";
  } else {
    ctx.retry_counts.page_load_retries = (ctx.retry_counts.page_load_retries || 0) + 1;

    if (ctx.retry_counts.page_load_retries >= ctx.retry_counts.MAX_PAGE_LOAD_RETRIES) {
      printLog(`❌ Max page load retries (${ctx.retry_counts.MAX_PAGE_LOAD_RETRIES}) reached. Giving up.`);
      yield "page_load_failed_permanently";
    } else {
      printLog(`⚠️ Page load retry ${ctx.retry_counts.page_load_retries}/${ctx.retry_counts.MAX_PAGE_LOAD_RETRIES}`);
      yield "page_load_retry";
    }
  }
}

// Step 2.5: Refresh Page
export async function* refreshPage(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    if (!ctx.driver) {
      printLog("No driver available for refresh");
      yield "no_page_to_refresh";
      return;
    }

    ctx.retry_counts.refresh_retries = (ctx.retry_counts.refresh_retries || 0) + 1;

    if (ctx.retry_counts.refresh_retries > ctx.retry_counts.MAX_REFRESH_RETRIES) {
      printLog(`❌ Max refresh retries (${ctx.retry_counts.MAX_REFRESH_RETRIES}) reached. Giving up.`);
      yield "refresh_failed_permanently";
      return;
    }

    printLog(`Refreshing page... (attempt ${ctx.retry_counts.refresh_retries}/${ctx.retry_counts.MAX_REFRESH_RETRIES})`);
    await ctx.driver.navigate().refresh();

    // Wait longer for slow networks
    printLog("Waiting after refresh...");
    await ctx.driver.sleep(5000);

    // Check if refresh worked
    const currentUrl = await ctx.driver.getCurrentUrl();
    const title = await ctx.driver.getTitle();

    printLog(`After refresh - URL: ${currentUrl}, Title: ${title}`);

    if (currentUrl && title && !title.includes('error')) {
      // Reset retry counter on success
      ctx.retry_counts.refresh_retries = 0;
      yield "page_refreshed";
    } else {
      printLog("Refresh failed - will retry");
      yield "page_reload_failed";
    }
  } catch (error) {
    printLog(`Refresh failed: ${error}`);
    yield "page_reload_failed";
  }
}

// Step 3: Detect Page State
export async function* detectPageState(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  await ctx.driver.sleep(2000);
  const pageSource = await ctx.driver.getPageSource();
  const hasSignIn = pageSource.includes('data-automation="sign in"') || pageSource.includes('Sign in');
  yield hasSignIn ? "sign_in_required" : "logged_in";
}

// Step 3.5: Click Search Button
export async function* clickSearchButton(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  const searchSelectors = ['button[data-automation="searchSubmit"]', 'button[type="submit"]', 'input[type="submit"]'];

  for (const selector of searchSelectors) {
    try {
      const button = await ctx.driver.findElement(By.css(selector));
      if (await button.isDisplayed()) {
        await button.click();
        yield "search_clicked";
        return;
      }
    } catch { continue; }
  }

  yield "search_clicked"; // Continue anyway
}

// Step 4: Show Sign In Banner and Wait for Login
export async function* showSignInBanner(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  await ctx.overlay.showSignInOverlay();
  await ctx.driver.get(ctx.seek_url || 'https://www.seek.com.au');
  await ctx.driver.sleep(2000);
  yield "signin_banner_shown";
}

// Step 5: Basic search functionality - just click search since we already have URL with keywords/location
export async function* performBasicSearch(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  await ctx.driver.sleep(2000);
  const currentUrl = await ctx.driver.getCurrentUrl();
  yield currentUrl.includes('jobs') ? "search_completed" : "search_failed";
}

// Step 6: Collect Job Cards
export async function* collectJobCards(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  const selectors = ctx.selectors?.job_cards || ['article[data-testid="job-card"]'];

  for (const selector of selectors) {
    try {
      const cards = await ctx.driver.findElements(By.css(selector));
      if (cards.length > 0) {
        ctx.job_cards = cards;
        ctx.job_index = 0;
        ctx.total_jobs = cards.length;
        ctx.applied_jobs = 0;

        // Reset retry counter on success
        ctx.retry_counts.collect_cards_retries = 0;
        printLog(`✅ Found ${cards.length} job cards`);
        yield "cards_collected";
        return;
      }
    } catch { continue; }
  }

  ctx.retry_counts.collect_cards_retries = (ctx.retry_counts.collect_cards_retries || 0) + 1;

  if (ctx.retry_counts.collect_cards_retries >= ctx.retry_counts.MAX_COLLECT_CARDS_RETRIES) {
    printLog(`❌ Max collect cards retries (${ctx.retry_counts.MAX_COLLECT_CARDS_RETRIES}) reached. No job cards found.`);
    yield "no_cards_found_permanently";
  } else {
    printLog(`⚠️ No job cards found, retry ${ctx.retry_counts.collect_cards_retries}/${ctx.retry_counts.MAX_COLLECT_CARDS_RETRIES}`);
    await ctx.driver.sleep(2000); // Add delay before retry
    yield "cards_collect_retry";
  }
}

// Step 7: Click Job Card
export async function* clickJobCard(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  const cards = ctx.job_cards || [];
  const index = ctx.job_index || 0;
  const total = cards.length;

  if (!cards.length || index >= cards.length) {
    yield "job_cards_finished";
    return;
  }

  try {
    // Log which job card we're opening (snippet from card text)
    const snippet = (await ctx.driver.executeScript(
      "const t = (arguments[0].textContent || '').trim(); return t.length > 70 ? t.substring(0, 70) + '...' : t;",
      cards[index]
    )) as string;
    printLog(`\n📌 Opening job card ${index + 1}/${total}: ${snippet || '(no text)'}`);

    await ctx.driver.executeScript("arguments[0].scrollIntoView(true);", cards[index]);
    await cards[index].click();
    await ctx.driver.sleep(2000); // Wait for details panel to load
    ctx.job_index = index + 1;
    yield "job_card_clicked";
  } catch {
    ctx.job_index = index + 1;
    yield "job_card_skipped";
  }
}

// Detect Apply Button Type
export async function* detectApplyType(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const result = (await ctx.driver.executeScript(`
      const container = document.querySelector('[data-automation="jobDetailsPage"]') || document.body;

      // Snapshot job title/company for logging (before we return apply result)
      const titleEl = container.querySelector('[data-automation="job-detail-title"]') || container.querySelector('h1[data-automation="jobTitle"]') || container.querySelector('h1');
      const companyEl = container.querySelector('[data-automation="advertiser-name"]') || container.querySelector('[data-automation="jobCompany"]');
      const jobTitle = titleEl ? (titleEl.textContent || '').trim() : '';
      const companyName = companyEl ? (companyEl.textContent || '').trim() : '';

      // Look for buttons/links with apply text
      const applyButtons = Array.from(container.querySelectorAll('button, a, [role="button"]')).filter(el => {
        return el.offsetParent !== null && !el.disabled;
      });

      let foundQuickApply = false;
      let foundRegularApply = false;
      const buttonDetails = [];

      for (const button of applyButtons) {
        const text = (button.textContent || '').trim();
        const lowerText = text.toLowerCase();

        buttonDetails.push({
          text: text,
          lowerText: lowerText,
          tagName: button.tagName
        });

        // ONLY Quick Apply if it contains the word "quick"
        if (lowerText.includes('quick') && lowerText.includes('apply')) {
          foundQuickApply = true;
          console.log('✓ QUICK APPLY found:', text);
          break; // Stop at first Quick Apply
        }
        // Regular Apply if it's exactly "Apply" or "Apply Now" but NO "quick"
        else if ((lowerText === 'apply' || lowerText === 'apply now') && !lowerText.includes('quick')) {
          foundRegularApply = true;
          console.log('✓ REGULAR APPLY found:', text);
        }
      }

      console.log('=== APPLY DETECTION DEBUG ===');
      console.log('All button texts:', buttonDetails);
      console.log('Found Quick Apply:', foundQuickApply);
      console.log('Found Regular Apply:', foundRegularApply);
      console.log('============================');

      return { hasQuickApply: foundQuickApply, hasRegularApply: foundRegularApply, jobTitle: jobTitle, companyName: companyName };
    `)) as { hasQuickApply: boolean; hasRegularApply: boolean; jobTitle?: string; companyName?: string };

    ctx.currentJobTitlePreview = result?.jobTitle || '';
    ctx.currentJobCompanyPreview = result?.companyName || '';
    if (ctx.currentJobTitlePreview || ctx.currentJobCompanyPreview) {
      printLog(`📋 Job: ${ctx.currentJobTitlePreview || '?'} at ${ctx.currentJobCompanyPreview || '?'}`);
    }
    printLog(`Apply detection result: Quick=${result.hasQuickApply}, Regular=${result.hasRegularApply}`);

    if (result.hasQuickApply) {
      printLog("🚀 QUICK APPLY detected - proceeding with application");
      yield "quick_apply_found";
    } else if (result.hasRegularApply) {
      printLog("⏭️ REGULAR APPLY detected - skipping to next job card");
      yield "regular_apply_found";
    } else {
      printLog("❌ NO APPLY BUTTON detected - skipping to next job card");
      yield "no_apply_found";
    }
  } catch (error) {
    printLog(`Apply detection error: ${error}`);
    yield "detect_apply_failed";
  }
}

// Parse Job Details
export async function* parseJobDetails(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const jobData = await ctx.driver.executeScript(`
      // Extract job content with improved Seek structure handling
      function extractJobContent() {
        const container = document.querySelector('[data-automation="jobDetailsPage"]');
        if (!container) return null;

        // Try to extract title using specific selectors first
        let titleText = '';
        const titleSelectors = [
          '[data-automation="job-detail-title"]',
          'h1[data-automation="jobTitle"]',
          'h1',
          '.job-title'
        ];

        for (const selector of titleSelectors) {
          const titleEl = container.querySelector(selector);
          if (titleEl && titleEl.textContent.trim()) {
            titleText = titleEl.textContent.trim();
            break;
          }
        }

        // Try to extract company using specific selectors
        let companyText = '';
        const companySelectors = [
          '[data-automation="advertiser-name"]',
          '[data-automation="jobCompany"]',
          '.advertiser-name'
        ];

        for (const selector of companySelectors) {
          const companyEl = container.querySelector(selector);
          if (companyEl && companyEl.textContent.trim()) {
            companyText = companyEl.textContent.trim();
            break;
          }
        }

        // Extract job header section (title, company, location, etc.)
        let headerText = '';
        const headerEl = container.querySelector('[data-automation="jobHeader"]') ||
                        container.querySelector('.job-header') ||
                        container.querySelector('header');

        if (headerEl) {
          headerText = headerEl.textContent.trim();
        } else {
          // Fallback: construct header from individual elements
          const locationEl = container.querySelector('[data-automation="job-detail-location"]');
          const workTypeEl = container.querySelector('[data-automation="job-detail-work-type"]');
          const salaryEl = container.querySelector('[data-automation="job-detail-salary"]');

          headerText = [titleText, companyText,
                       locationEl?.textContent?.trim(),
                       workTypeEl?.textContent?.trim(),
                       salaryEl?.textContent?.trim()].filter(Boolean).join('\\n');
        }

        // Extract full content using DOM walker for details
        const texts = [];
        const detailsContainer = container.querySelector('[data-automation="jobAdDetails"]');
        const walker = document.createTreeWalker(
          detailsContainer || container,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: function(node) {
              let parent = node.parentElement;
              while (parent && parent !== container) {
                const tagName = parent.tagName.toLowerCase();
                const style = window.getComputedStyle(parent);

                if (tagName === 'style' || tagName === 'script' || tagName === 'noscript' ||
                    style.display === 'none' || style.visibility === 'hidden') {
                  return NodeFilter.FILTER_REJECT;
                }
                parent = parent.parentElement;
              }
              return NodeFilter.FILTER_ACCEPT;
            }
          },
          false
        );

        while (walker.nextNode()) {
          const text = walker.currentNode.textContent.trim();
          if (text !== '') texts.push(text);
        }

        const allText = [...new Set(texts)].join('\\n');

        const unwantedLines = [
          'View all jobs', 'Quick apply', 'Apply', 'Save', 'Report this job advert',
          'Be careful', "Don\'t provide your bank or credit card details when applying for jobs.",
          'Learn how to protect yourself', 'Report this job ad', 'Career Advice'
        ];

        const ratingPatterns = [/^\\d+\\.\\d+$/, /^\\d+\\s+reviews?$/, /^·$/];

        let cleanedLines = allText.split('\\n').filter(line => {
          const trimmed = line.trim();
          if (trimmed === '' || unwantedLines.includes(trimmed)) return false;
          return !ratingPatterns.some(pattern => pattern.test(trimmed));
        });

        const cleanedText = cleanedLines.join('\\n');

        return {
          raw_title: headerText || titleText,
          details: cleanedText,
          extracted_title: titleText,
          extracted_company: companyText
        };
      }

      // Parse job title with structured fields
      function parseJobTitle(titleText) {
        const lines = titleText ? titleText.split('\\n').map(l => l.trim()).filter(l => l) : [];

        const parsed = {
          title: '', company: '', location: '', work_type: '', category: '',
          salary_note: '', posted: '', application_volume: ''
        };

        if (!lines.length) return parsed;

        parsed.title = lines[0];
        if (lines.length >= 2) parsed.company = lines[1];

        let postedIndex = -1;
        for (let i = 2; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes('posted') || lines[i].includes('ago')) {
            postedIndex = i;
            parsed.posted = lines[i].replace(/posted\\s+/i, '');
            break;
          }
        }

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes('application volume')) {
            parsed.application_volume = lines[i];
            break;
          }
        }

        const structuredEndIndex = postedIndex > 0 ? postedIndex : lines.length;
        const structuredData = lines.slice(2, structuredEndIndex).filter(line => {
          return !/^\\d+\\.\\d+$/.test(line) && !/^\\d+\\s+reviews?$/.test(line) && line !== '·';
        });

        if (structuredData.length >= 1) parsed.location = structuredData[0];
        if (structuredData.length >= 2) parsed.work_type = structuredData[1];
        if (structuredData.length >= 3) parsed.category = structuredData[2];

        for (const item of structuredData) {
          if (item.includes('$') && !parsed.salary_note) {
            parsed.salary_note = item;
            break;
          }
        }

        return parsed;
      }

      const extracted = extractJobContent();
      if (!extracted) return null;

      const parsedTitle = parseJobTitle(extracted.raw_title);

      // Extract job ID from URL
      const jobId = new URL(window.location.href).searchParams.get('jobId') || '';

      // Use directly extracted values if parsing failed
      const finalData = {
        ...parsedTitle,
        details: extracted.details,
        raw_title: extracted.raw_title,
        url: window.location.href,
        jobId: jobId,
        scrapedAt: new Date().toISOString(),
        debug: {
          title_length: extracted.raw_title ? extracted.raw_title.length : 0,
          details_length: extracted.details ? extracted.details.length : 0,
          extracted_title: extracted.extracted_title,
          extracted_company: extracted.extracted_company
        }
      };

      // Override with directly extracted values if available and parsed values are empty
      if (!finalData.title && extracted.extracted_title) {
        finalData.title = extracted.extracted_title;
      }
      if (!finalData.company && extracted.extracted_company) {
        finalData.company = extracted.extracted_company;
      }

      return finalData;
    `);

    if (jobData) {
      // Parse HR contact, required skills, required experience from details text (for Job Analytics)
      const parsed = parseJobDetailsFromText(jobData.details || '');
      if (parsed.hrContact && (parsed.hrContact.name || parsed.hrContact.email || parsed.hrContact.phone)) {
        jobData.hrContact = parsed.hrContact;
      }
      if (parsed.requiredSkills && parsed.requiredSkills.length > 0) {
        jobData.requiredSkills = parsed.requiredSkills;
      }
      if (parsed.requiredExperience) {
        jobData.requiredExperience = parsed.requiredExperience;
      }

      // Store in context so every step can log "which job"
      ctx.currentJobTitle = jobData.title || '';
      ctx.currentJobCompany = jobData.company || '';

      const jobId = jobData.jobId || Date.now().toString();
      const jobDir = getJobArtifactDir(ctx, 'seek', jobId);
      const filepath = path.join(jobDir, 'job_details.json');
      const clientEmail = getClientEmailFromContext(ctx);
      if (clientEmail) {
        jobData.clientEmail = clientEmail;
      }

      fs.writeFileSync(filepath, JSON.stringify(jobData, null, 2));

      // Store current job file path in context for employer questions step
      ctx.currentJobFile = filepath;
      ctx.currentJobDir = jobDir;

      printLog(`\n═══════════════════════════════════════════════════════════════`);
      printLog(`🎯 APPLYING TO: ${ctx.currentJobTitle} | ${ctx.currentJobCompany}`);
      printLog(`═══════════════════════════════════════════════════════════════\n`);
      printLog(`Quick Apply job saved: ${jobData.title} at ${jobData.company} (${filepath})`);

      // Update progress counter and overlay
      if (ctx.overlay && ctx.total_jobs) {
        ctx.applied_jobs = (ctx.applied_jobs || 0) + 1;
        await ctx.overlay.updateJobProgress(
          ctx.applied_jobs,
          ctx.total_jobs,
          "Quick Apply job saved",
          9
        );
      }
    } else {
      printLog("Quick Apply job found but failed to extract data");
    }

    yield "job_parsed";
  } catch (error) {
    printLog(`Job parsing error: ${error}`);
    yield "parse_failed";
  }
}

// Click Quick Apply Button
export async function* clickQuickApply(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    logCurrentJob(ctx);
    printLog("Clicking Quick Apply button...");

    const clicked = await ctx.driver.executeScript(`
      const container = document.querySelector('[data-automation="jobDetailsPage"]') || document.body;

      // Try multiple selectors for Quick Apply button
      const quickApplySelectors = [
        '[data-automation="job-detail-apply"]',
        'button',
        'a'
      ];

      for (const selector of quickApplySelectors) {
        const elements = Array.from(container.querySelectorAll(selector));

        for (const element of elements) {
          const text = (element.textContent || '').toLowerCase();

          if (text.includes('quick apply') ||
              (text.includes('apply') && !text.includes('applied'))) {

            if (element.offsetParent !== null && !element.disabled) {
              element.scrollIntoView({ behavior: 'smooth', block: 'center' });

              // Small delay before clicking
              setTimeout(() => {
                element.click();
                console.log('Quick Apply button clicked successfully');
              }, 500);

              return true;
            }
          }
        }
      }

      console.log('Quick Apply button not found or not clickable');
      return false;
    `);

    if (clicked) {
      // Wait for potential new tab/window to open
      await ctx.driver.sleep(2000);

      // Check if a new window/tab opened
      const handles = await ctx.driver.getAllWindowHandles();
      if (handles.length > 1) {
        // Switch to the new tab (last one opened)
        await ctx.driver.switchTo().window(handles[handles.length - 1]);
        printLog("Switched to Quick Apply tab");
      }

      printLog("Quick Apply button clicked successfully");
      yield "quick_apply_clicked";
    } else {
      printLog("Quick Apply button not found or not clickable");
      yield "quick_apply_failed";
    }

  } catch (error) {
    printLog(`Error clicking Quick Apply: ${error}`);
    yield "quick_apply_failed";
  }
}

// Wait for Quick Apply Page to Load
export async function* waitForQuickApplyPage(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog("Waiting for Quick Apply page to load...");

    // Wait for page navigation and new elements to appear
    await ctx.driver.sleep(3000);

    // Check current URL to see if we're on a Quick Apply page
    const currentUrl = await ctx.driver.getCurrentUrl();
    printLog(`Current URL: ${currentUrl}`);

    // Try multiple checks with retries
    let pageReady = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      pageReady = await ctx.driver.executeScript(`
        // Check multiple indicators for Quick Apply page
        const progressBar = document.querySelector('nav[aria-label="Progress bar"]');
        const resumeSelect = document.querySelector('select[data-testid="select-input"]');
        const continueBtn = document.querySelector('button[data-testid="continue-button"]');
        const seekLogo = document.querySelector('[data-testid="seek-logo"]');
        const formElements = document.querySelectorAll('form, fieldset');

        // Check if URL contains Quick Apply indicators
        const urlHasQuickApply = window.location.href.includes('quick-apply') ||
                                 window.location.href.includes('apply') ||
                                 window.location.pathname.includes('/apply');

        const hasQuickApplyElements = !!(progressBar || resumeSelect || continueBtn);
        const hasFormElements = formElements.length > 0;
        const hasSeekBranding = !!seekLogo;

        console.log('Page check attempt ${attempt + 1}:', {
          progressBar: !!progressBar,
          resumeSelect: !!resumeSelect,
          continueBtn: !!continueBtn,
          urlHasQuickApply,
          hasFormElements,
          hasSeekBranding
        });

        return hasQuickApplyElements || (urlHasQuickApply && (hasFormElements || hasSeekBranding));
      `);

      if (pageReady) break;

      if (attempt < 2) {
        printLog(`Page not ready, attempt ${attempt + 1}/3, waiting...`);
        await ctx.driver.sleep(2000);
      }
    }

    if (pageReady) {
      printLog("Quick Apply page loaded successfully");
      yield "quick_apply_page_ready";
    } else {
      printLog("Quick Apply page not ready after retries");
      yield "page_load_timeout";
    }

  } catch (error) {
    printLog(`Quick Apply page load error: ${error}`);
    yield "page_load_timeout";
  }
}

// Get Current Step in Quick Apply Flow
export async function* getCurrentStep(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    logCurrentJob(ctx);
    const currentStep = await ctx.driver.executeScript(`
      const nav = document.querySelector('nav[aria-label="Progress bar"]');
      if (!nav) return 'progress_bar_not_found';

      const currentStepBtn = nav.querySelector('li button[aria-current="step"]');
      if (!currentStepBtn) return 'progress_bar_not_found';

      const stepText = currentStepBtn.querySelector('span:nth-child(2) span:nth-child(2) span span')?.textContent?.trim() || '';
      return stepText;
    `);

    printLog(`Current Quick Apply step: ${currentStep}`);

    if (currentStep === 'progress_bar_not_found') {
      yield "progress_bar_not_found";
    } else if (currentStep === "Choose documents") {
      yield "current_step_choose_documents";
    } else if (currentStep === "Answer employer questions") {
      yield "current_step_employer_questions";
    } else if (currentStep === "Update SEEK Profile") {
      yield "current_step_update_profile";
    } else if (currentStep === "Review and submit") {
      yield "current_step_review_submit";
    } else {
      printLog(`Unknown step: ${currentStep}`);
      yield "current_step_unknown";
    }

  } catch (error) {
    printLog(`Error getting current step: ${error}`);
    yield "progress_bar_evaluation_error";
  }
}




// Click Continue Button
export async function* clickContinueButton(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    logCurrentJob(ctx);
    printLog("Clicking continue button...");

    // First, check the form state before clicking continue
    const formState = await ctx.driver.executeScript(`
      // Check cover letter state
      const textarea = document.querySelector('textarea[data-testid="coverLetterTextInput"]');
      const coverLetterValue = textarea ? textarea.value : 'NOT_FOUND';
      const coverLetterLength = textarea ? textarea.value.length : 0;

      // Check for any validation errors
      const errorElements = document.querySelectorAll('[role="alert"], .error, .invalid, [aria-invalid="true"]');
      const hasErrors = errorElements.length > 0;
      const errorMessages = Array.from(errorElements).map(el => el.textContent.trim()).filter(txt => txt);

      // Check if continue button is enabled
      const continueBtn = document.querySelector('button[data-testid="continue-button"]');
      const btnEnabled = continueBtn ? !continueBtn.disabled : false;

      return {
        coverLetterLength: coverLetterLength,
        coverLetterPreview: coverLetterValue.substring(0, 50),
        hasErrors: hasErrors,
        errorMessages: errorMessages,
        continueButtonEnabled: btnEnabled
      };
    `);

    printLog(`📋 FORM STATE CHECK: Cover letter length: ${formState.coverLetterLength}, Errors: ${formState.hasErrors}, Continue enabled: ${formState.continueButtonEnabled}`);
    if (formState.hasErrors) {
      printLog(`🔥 VALIDATION ERRORS: ${formState.errorMessages.join(', ')}`);
    }

    const continueClicked = await ctx.driver.executeScript(`
      const continueSelectors = [
        'button[data-testid="continue-button"]',
        'button:contains("Continue")',
        'button:contains("Next")'
      ];

      for (const selector of continueSelectors) {
        let button;
        if (selector.includes(':contains')) {
          const text = selector.match(/contains\\(\"([^\"]+)\"\\)/)[1];
          const buttons = Array.from(document.querySelectorAll('button')).filter(btn =>
            btn.textContent.toLowerCase().includes(text.toLowerCase())
          );
          button = buttons.find(btn => btn.offsetParent !== null && !btn.disabled);
        } else {
          button = document.querySelector(selector);
        }

        if (button && button.offsetParent !== null && !button.disabled) {
          button.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => {
            button.click();
            console.log('Continue button clicked');
          }, 300);
          return true;
        }
      }

      return false;
    `);

    if (continueClicked) {
      await ctx.driver.sleep(2000); // Wait for navigation/page change
      printLog("Continue button clicked successfully");
      yield "continue_clicked";
    } else {
      printLog("Continue button not found");
      yield "continue_button_not_found";
    }

  } catch (error) {
    printLog(`Continue button error: ${error}`);
    yield "continue_button_error";
  }
}

// Close Quick Apply and Continue Search
export async function* closeQuickApplyAndContinueSearch(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    // Record application to corpus-rag (loosely coupled; no block on failure)
    if (ctx.currentJobFile) {
      try {
        const jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf8'));
        const jobId = jobData.jobId || '';
        if (jobId) {
          const jobDirPath = getJobDirPathFromJobFile(ctx.currentJobFile, jobId);
          const result = await recordJobApplicationToBackend({
            jobFilePath: ctx.currentJobFile,
            jobDirPath
          });
          if (!result.ok) {
            printLog(`[JobRecorder] Backend record skipped: ${result.error}`);
          }
        }
      } catch (recordErr) {
        printLog(`[JobRecorder] Record failed (continuing): ${recordErr}`);
      }
    }

    printLog("Closing Quick Apply page and continuing search...");

    const handles = await ctx.driver.getAllWindowHandles();
    printLog(`Found ${handles.length} window handles`);

    if (handles.length > 1) {
      // Close current tab/window
      await ctx.driver.close();

      // Switch back to main window (first handle)
      await ctx.driver.switchTo().window(handles[0]);
      await ctx.driver.sleep(1000);

      // Verify we're back on the job search page
      const currentUrl = await ctx.driver.getCurrentUrl();
      printLog(`Switched back to main window: ${currentUrl}`);
    } else {
      printLog("Only one window found, staying on current page");
    }

    printLog("Returned to job search page");
    yield "hunting_next_job";

  } catch (error) {
    printLog(`Close and continue error: ${error}`);
    // Try to continue anyway
    yield "hunting_next_job";
  }
}

// Pause for Cover Letter Review
export async function* pauseForCoverLetterReview(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  printLog("📄 COVER LETTER REVIEW TIME");
  printLog("🔍 Take 5 minutes to read and review the AI-generated cover letter");
  printLog("📋 Check the personalization, tone, and relevance to the job posting");
  printLog("⏳ Pausing for 5 minutes...");

  // Wait 5 minutes (300 seconds)
  await ctx.driver.sleep(300000);

  printLog("⏰ 5-minute review period complete");
  printLog("▶️ Continuing with resume selection...");

  yield "review_complete";
}

// Stay Put for Manual Inspection
export async function* stayPutForInspection(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  printLog("🔍 STAYING PUT FOR MANUAL INSPECTION - Still on Choose Documents tab");
  printLog("📋 Check the form manually to see what validation errors are present");
  printLog("⏳ Waiting 5 minutes for inspection, then will continue...");

  // Wait 5 minutes (300 seconds) for manual inspection
  await ctx.driver.sleep(300000);

  printLog("⏰ Inspection timeout reached, continuing workflow...");
  yield "inspection_complete";
}

// Skip to Next Card
export async function* skipToNextCard(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  const title = ctx.currentJobTitlePreview || ctx.currentJobTitle;
  const company = ctx.currentJobCompanyPreview || ctx.currentJobCompany;
  if (title || company) {
    printLog(`⏭️ Skipping (regular apply): ${title || '?'} at ${company || '?'}`);
  } else {
    printLog("Regular Apply job found - skipping job details parsing and moving to next card...");
  }

  // Update progress counter if overlay exists
  if (ctx.overlay && ctx.total_jobs) {
    const skippedJobs = (ctx.skipped_jobs || 0) + 1;
    ctx.skipped_jobs = skippedJobs;
    await ctx.overlay.updateJobProgress(
      ctx.applied_jobs || 0,
      ctx.total_jobs,
      "Regular apply job skipped",
      8
    );
  }

  yield "card_skipped";
}

// Click Next Page
export async function* clickNextPage(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog("Checking for next page button...");

    const nextButton = await ctx.driver.executeScript(`
      const nextButton = document.querySelector('a[rel=\"nofollow next\"]');
      if (nextButton && !nextButton.hasAttribute('disabled')) {
        nextButton.click();
        return true;
      }
      return false;
    `);

    if (nextButton) {
      printLog("Next page button clicked.");
      await ctx.driver.sleep(3000); // Wait for page to load
      yield "next_page_clicked";
    } else {
      printLog("No more pages found.");
      yield "no_more_pages";
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/no such window|target window already closed|web view not found/i.test(msg)) {
      printLog("Next page: window closed, treating as no more pages.");
    } else {
      printLog(`Error clicking next page: ${msg}`);
    }
    yield "no_more_pages";
  }
}

// Skip resume only
export async function* skipResume(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog("Skipping resume selection...");

    // Handle resume selection - click "Don't include a resumé"
    try {
      const noResumeRadio = await ctx.driver.findElement(By.xpath("//label[contains(., \"Don't include a resumé\")]"));
      await noResumeRadio.click();
      printLog('✅ Selected "Don\'t include a resumé"');
      await ctx.driver.sleep(1000);
      yield "resume_skipped";
    } catch (e) {
      printLog('⚠️ Could not find "Don\'t include a resumé" option');
      yield "resume_skip_failed";
    }
  } catch (error) {
    printLog(`Error skipping resume: ${error}`);
    yield "resume_skip_failed";
  }
}

// Skip documents (both resume and cover letter)
export async function* skipDocuments(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog("Skipping resume and cover letter selection...");

    // Handle resume selection - click "Don't include a resumé"
    try {
      const noResumeRadio = await ctx.driver.findElement(By.xpath("//label[contains(., \"Don't include a resumé\")]"));
      await noResumeRadio.click();
      printLog('✅ Selected "Don\'t include a resumé"');
      await ctx.driver.sleep(1000);
    } catch (e) {
      printLog('⚠️ Could not find "Don\'t include a resumé" option');
    }

    // Handle cover letter selection - click "Don't include a cover letter"
    try {
      const noCoverLetterRadio = await ctx.driver.findElement(By.xpath("//label[contains(., \"Don't include a cover letter\")]"));
      await noCoverLetterRadio.click();
      printLog('✅ Selected "Don\'t include a cover letter"');
      await ctx.driver.sleep(1000);
    } catch (e) {
      printLog('⚠️ Could not find "Don\'t include a cover letter" option');
    }

    yield "documents_skipped";
  } catch (error) {
    printLog(`Error skipping documents: ${error}`);
    yield "documents_skip_failed";
  }
}

export const seekStepFunctions = {
  step0,
  openHomepage,
  waitForPageLoad,
  refreshPage,
  detectPageState,
  clickSearchButton,
  showSignInBanner,
  performBasicSearch,
  collectJobCards,
  clickJobCard,
  detectApplyType,
  parseJobDetails,
  clickQuickApply,
  waitForQuickApplyPage,
  getCurrentStep,
  handleResumeSelection,
  handleCoverLetter,
  extractEmployerQuestions,
  handleEmployerQuestions,
  clickContinueButton,
  closeQuickApplyAndContinueSearch,
  stayPutForInspection,
  pauseForCoverLetterReview,
  skipToNextCard,
  skipResume,
  skipDocuments,
  clickNextPage
};