/**
 * API Client for Corpus RAG API
 * Handles authentication and API calls to the backend
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from './logger.js';

interface ApiConfig {
  baseUrl: string;
}

interface JwtTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function summarizeBody(body: any): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const summary: Record<string, unknown> = {};
  const fields = ['job_id', 'platform', 'platform_job_id', 'job_title', 'company', 'questions_count'];
  for (const field of fields) {
    if (body[field] != null) summary[field] = body[field];
  }
  if (Array.isArray(body.questions)) summary.questions_count = body.questions.length;
  if (typeof body.job_details === 'string') summary.job_details_length = body.job_details.length;
  if (typeof body.resume_text === 'string') summary.resume_text_length = body.resume_text.length;
  return summary;
}

function shouldLogFullPayload(endpoint: string): boolean {
  return endpoint === '/api/questionAndAnswers' || endpoint === '/api/employer-questions/compare';
}

/**
 * Get API configuration from environment
 */
function getApiConfig(): ApiConfig {
  return {
    baseUrl: process.env.API_BASE || 'http://localhost:3000',
  };
}

/**
 * Get session token from the shared cache.
 * The UI process is responsible for keeping this token valid.
 */
async function getSessionToken(): Promise<string | null> {
  const tokenCachePath = path.join(process.cwd(), '.cache', 'api_token.txt');

  if (fs.existsSync(tokenCachePath)) {
    const cachedToken = fs.readFileSync(tokenCachePath, 'utf8').trim();
    if (cachedToken) {
      logger.auth('debug', 'auth.session_cache_hit', 'Using shared authentication token');
      return cachedToken;
    }
  }

  logger.auth('warn', 'auth.session_cache_miss', 'No shared authentication token available');
  return null;
}

/**
 * Get or refresh JWT access token
 */
async function getAccessToken(): Promise<string | null> {
  const jwtCachePath = path.join(process.cwd(), '.cache', 'jwt_tokens.json');

  // Check if we have cached JWT tokens
  if (fs.existsSync(jwtCachePath)) {
    try {
      const cached: JwtTokens = JSON.parse(fs.readFileSync(jwtCachePath, 'utf8'));

      // Check if access token is still valid (with 1 minute buffer)
      if (cached.expiresAt > Date.now() + 60000) {
        logger.auth('debug', 'auth.jwt_cache_hit', 'Using cached JWT access token');
        return cached.accessToken;
      }

      // Try to refresh the token
      logger.auth('info', 'auth.jwt_refresh_start', 'Access token expired, refreshing');
      const config = getApiConfig();
      const response = await fetch(`${config.baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: cached.refreshToken })
      });

      if (response.ok) {
        const data = await response.json();
        const newTokens: JwtTokens = {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: Date.now() + (data.expiresIn * 1000)
        };
        fs.writeFileSync(jwtCachePath, JSON.stringify(newTokens, null, 2));
        logger.auth('info', 'auth.jwt_refresh_success', 'JWT token refreshed successfully');
        return newTokens.accessToken;
      }
    } catch (error) {
      logger.auth('warn', 'auth.jwt_refresh_failed', 'Error refreshing JWT, trying session token conversion', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Convert session token to JWT
  const sessionToken = await getSessionToken();
  if (!sessionToken) {
    return null;
  }

  try {
    logger.auth('info', 'auth.session_to_jwt_start', 'Converting session token to JWT');
    const config = getApiConfig();
    const response = await fetch(`${config.baseUrl}/api/auth/session-to-jwt`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.auth('error', 'auth.session_to_jwt_failed', 'Session to JWT conversion failed', {
        status: response.status,
        errorText
      });
      return null;
    }

    const data = await response.json();
    const tokens: JwtTokens = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + (data.expiresIn * 1000)
    };

    // Cache the JWT tokens
    const cacheDir = path.join(process.cwd(), '.cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(jwtCachePath, JSON.stringify(tokens, null, 2));

    logger.auth('info', 'auth.session_to_jwt_success', 'Session token converted to JWT successfully');
    return tokens.accessToken;
  } catch (error) {
    logger.auth('error', 'auth.session_to_jwt_error', 'Error converting session token to JWT', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Make an authenticated API request
 */
/**
 * Returns a ready-to-use "Bearer <token>" string for manual fetch calls (e.g. FormData uploads).
 */
export async function getBearerHeader(): Promise<string> {
  const token = await getAccessToken();
  if (!token) throw new Error('No authentication token available. Please login first.');
  return `Bearer ${token}`;
}

export async function apiRequest(
  endpoint: string,
  method: string = 'POST',
  body?: any
): Promise<any> {
  const config = getApiConfig();
  const token = await getAccessToken();

  if (!token) {
    throw new Error('No authentication token available. Please login first.');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  const url = `${config.baseUrl}${endpoint}`;
  const requestId = randomUUID().slice(0, 12);
  const startedAt = Date.now();

  logger.apiRequest(`${method} ${endpoint}`, {
    requestId,
    method,
    endpoint,
    url,
    bodySummary: summarizeBody(body),
    ...(shouldLogFullPayload(endpoint) ? { requestBody: body } : {})
  });

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.apiError(`${method} ${endpoint}`, {
      requestId,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorText
    });
    throw new Error(`API request failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  logger.apiResponse(`${method} ${endpoint}`, {
    requestId,
    status: response.status,
    durationMs: Date.now() - startedAt,
    success: data?.success !== false,
    ...(shouldLogFullPayload(endpoint) ? { responseBody: data } : {})
  });
  return data;
}

// The save and clear functions are kept for potential direct use or testing,
// but the primary flow is now managed by the UI via Tauri IPC.

/**
 * Save authentication token to cache
 */
export function saveSessionToken(token: string): void {
  const cacheDir = path.join(process.cwd(), '.cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const tokenCachePath = path.join(cacheDir, 'api_token.txt');
  fs.writeFileSync(tokenCachePath, token, 'utf8');
  logger.auth('info', 'auth.session_saved', 'Session token saved to cache');
}

/**
 * Clear cached session token
 */
export function clearSessionToken(): void {
  const tokenCachePath = path.join(process.cwd(), '.cache', 'api_token.txt');
  if (fs.existsSync(tokenCachePath)) {
    fs.unlinkSync(tokenCachePath);
    logger.auth('info', 'auth.session_cleared', 'Session token cleared');
  }
}
