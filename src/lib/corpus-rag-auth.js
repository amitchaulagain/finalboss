/**
 * Corpus-RAG Authentication Handler
 * Bridges between finalboss's authService and corpus-rag API authentication
 */

import { authService } from './authService.js';
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

// Use environment variable for API base URL
const API_BASE_URL = env.PUBLIC_API_BASE || import.meta.env.VITE_API_BASE || 'http://localhost:3000';

export class CorpusRagAuth {
  /**
   * Get current authentication token
   * @returns {string|null} - Bearer token for API requests
   */
  static async getToken() {
    if (!browser) return null;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke('read_file_async', { filename: '.cache/auth_access_token.txt' });
    } catch {
      return null;
    }
  }

  /**
   * Get current authenticated user
   * @returns {Object|null} - User object or null
   */
  static async getCurrentUser() {
    if (!browser) return null;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const userStr = await invoke('read_file_async', { filename: '.cache/auth_user.json' });
      if (!userStr) return null;

      const user = JSON.parse(userStr);

      // Ensure user has the expected structure with API permissions
      if (!user.apiPermissions) {
        // Set default permissions if not present
        user.apiPermissions = {
          cover_letter: true,
          resume: true,
          questionAndAnswers: true,
          jobs: true,
          upload: true
        };
      }

      return user;
    } catch (error) {
      console.error('Failed to parse user data:', error);
      return null;
    }
  }

  /**
   * Check if user is authenticated
   * @returns {boolean}
   */
  static async isAuthenticated() {
    return (await this.getToken()) !== null;
  }

  /**
   * Logout user (clears auth data)
   */
  static async logout() {
    if (!browser) return;

    // Use authService logout if available
    await authService.logout();
  }

  /**
   * Validate current session with corpus-rag server
   * @returns {Promise<{valid: boolean, user?: Object, error?: string}>}
   */
  static async validateSession() {
    const token = await this.getToken();

    if (!token) {
      return { valid: false, error: 'No token found' };
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/verify`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        return { valid: true, user: data.user };
      } else {
        const error = await response.json();
        return { valid: false, error: error.message || error.error || 'Session validation failed' };
      }
    } catch (error) {
      console.error('Session validation error:', error);
      return { valid: false, error: error.message };
    }
  }

  /**
   * Refresh authentication token if needed
   * @returns {Promise<string|null>}
   */
  static async refreshToken() {
    // Use authService to refresh token
    return await authService.getAccessToken();
  }
}
