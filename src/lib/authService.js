import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { invoke } from '@tauri-apps/api/core';
import { env } from '$env/dynamic/public';

// Use environment variable for API base URL
const API_BASE_URL = env.PUBLIC_API_BASE || import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const TOKEN_CACHE_FILE = '.cache/api_token.txt';

function createAuthStore() {
  const { subscribe, set, update } = writable({
    user: null,
    isLoggedIn: false,
    loading: true,
  });

  async function writeCache(filename, content) {
    await invoke('write_file_async', { filename, content: String(content) });
  }

  async function readCache(filename) {
    try {
      return await invoke('read_file_async', { filename });
    } catch {
      return null;
    }
  }

  async function deleteCache(filename) {
    try {
      await invoke('delete_file_async', { filename });
    } catch { /* ignore if file doesn't exist */ }
  }

  async function refreshAccessToken() {
    if (!browser) return null;

    const refreshToken = await readCache('.cache/auth_refresh_token.txt');
    if (!refreshToken) {
      console.log('No refresh token available.');
      await logout();
      return null;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (response.ok) {
        const data = await response.json();
        await setTokens(data);
        console.log('✅ Access token refreshed successfully.');
        return data.accessToken;
      } else {
        console.error('Failed to refresh access token.');
        await logout(); // If refresh fails, log the user out.
        return null;
      }
    } catch (error) {
      console.error('Error refreshing access token:', error);
      await logout();
      return null;
    }
  }

  async function setTokens(data) {
    if (!browser) return;
    const { accessToken, refreshToken, expiresIn, user } = data;
    await writeCache('.cache/auth_access_token.txt', accessToken);
    await writeCache('.cache/auth_refresh_token.txt', refreshToken);
    // Store expiry time (current time + expiresIn seconds)
    const expiresAt = new Date().getTime() + expiresIn * 1000;
    await writeCache('.cache/auth_expires_at.txt', expiresAt);

    if (user) {
      await writeCache('.cache/auth_user.json', JSON.stringify(user));
    }

    // Save the token for bot processes via Tauri IPC
    try {
      await invoke('write_file_async', { filename: TOKEN_CACHE_FILE, content: accessToken });
      console.log('✅ Token saved to shared cache for bot processes.');
    } catch (e) {
      console.error('Failed to save token to shared cache:', e);
    }
  }

  async function signup(email, password, name, rememberMe = true) {
    update(state => ({ ...state, loading: true }));
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        if (browser) {
          const expiresAt = new Date().getTime() + 30 * 24 * 60 * 60 * 1000;
          await writeCache('.cache/auth_access_token.txt', data.token);
          await writeCache('.cache/auth_user.json', JSON.stringify(data.user));
          await writeCache('.cache/auth_expires_at.txt', expiresAt);
          await writeCache('.cache/auth_remember_me.txt', rememberMe ? 'true' : 'false');
        }

        // Save token for bot processes
        try {
          await invoke('write_file_async', { filename: TOKEN_CACHE_FILE, content: data.token });
          console.log('✅ Token saved to shared cache for bot processes.');
        } catch (e) {
          console.error('Failed to save token to shared cache:', e);
        }

        set({
          user: data.user,
          isLoggedIn: true,
          loading: false,
        });
        console.log('✅ Signup successful');
        return { success: true };
      } else {
        throw new Error(data.error || 'Signup failed');
      }
    } catch (error) {
      console.error('Signup error:', error);
      update(state => ({ ...state, loading: false, user: null, isLoggedIn: false }));
      return { success: false, error: error.message };
    }
  }

  async function login(email, password, rememberMe = true) {
    update(state => ({ ...state, loading: true }));
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        if (browser) {
          const expiresAt = new Date().getTime() + 30 * 24 * 60 * 60 * 1000;
          await writeCache('.cache/auth_access_token.txt', data.token);
          await writeCache('.cache/auth_user.json', JSON.stringify(data.user));
          await writeCache('.cache/auth_expires_at.txt', expiresAt);
          await writeCache('.cache/auth_remember_me.txt', rememberMe ? 'true' : 'false');
        }

        // Save token for bot processes
        try {
          await invoke('write_file_async', { filename: TOKEN_CACHE_FILE, content: data.token });
          console.log('✅ Token saved to shared cache for bot processes.');
        } catch (e) {
          console.error('Failed to save token to shared cache:', e);
        }

        set({
          user: data.user,
          isLoggedIn: true,
          loading: false,
        });
        console.log('✅ Login successful');
        return { success: true };
      } else {
        throw new Error(data.error || 'Login failed');
      }
    } catch (error) {
      console.error('Login error:', error);
      update(state => ({ ...state, loading: false, user: null, isLoggedIn: false }));
      return { success: false, error: error.message };
    }
  }


  async function logout() {
    if (!browser) return;

    // Clear all auth cache files
    await deleteCache('.cache/auth_access_token.txt');
    await deleteCache('.cache/auth_refresh_token.txt');
    await deleteCache('.cache/auth_expires_at.txt');
    await deleteCache('.cache/auth_user.json');
    await deleteCache('.cache/auth_remember_me.txt');

    // Reset store
    set({ user: null, isLoggedIn: false, loading: false });

    // Clear the bot's cached token via Tauri IPC
    try {
      await invoke('delete_file_async', { filename: TOKEN_CACHE_FILE });
      console.log('✅ Cleared shared token cache.');
    } catch (e) {
      // It might fail if the file doesn't exist, which is fine.
      console.log('Could not clear shared token cache (it may not exist):', e);
    }

    console.log('Logged out.');
    goto('/login'); // Redirect to login page
  }

  async function getAccessToken() {
    if (!browser) return null;

    const expiresAt = await readCache('.cache/auth_expires_at.txt');
    const accessToken = await readCache('.cache/auth_access_token.txt');

    if (!accessToken || !expiresAt) {
      return null;
    }

    // Check if token is expired or close to expiring (e.g., within 60 seconds)
    if (new Date().getTime() > parseInt(expiresAt) - 60 * 1000) {
      console.log('Access token expired or nearing expiration, refreshing...');
      return await refreshAccessToken();
    }

    return accessToken;
  }

  async function initialize() {
    if (!browser) return;

    const rememberMe = await readCache('.cache/auth_remember_me.txt');

    // If user explicitly chose not to be remembered, treat as session-only:
    // clear tokens and return unauthenticated (mirrors old sessionStorage behaviour).
    if (rememberMe === 'false') {
      await deleteCache('.cache/auth_access_token.txt');
      await deleteCache('.cache/auth_refresh_token.txt');
      await deleteCache('.cache/auth_expires_at.txt');
      await deleteCache('.cache/auth_user.json');
      await deleteCache('.cache/auth_remember_me.txt');
      set({ user: null, isLoggedIn: false, loading: false });
      return;
    }

    const token = await readCache('.cache/auth_access_token.txt');
    const userStr = await readCache('.cache/auth_user.json');
    const expiresAt = await readCache('.cache/auth_expires_at.txt');

    if (token && userStr && expiresAt) {
      // Check if token is expired
      const now = new Date().getTime();
      const expiry = parseInt(expiresAt);

      if (now < expiry) {
        // Token is still valid
        try {
          const user = JSON.parse(userStr);
          set({ user, isLoggedIn: true, loading: false });
        } catch (e) {
          console.error('Failed to parse user data:', e);
          await logout();
        }
      } else {
        // Token is expired, clear everything
        console.log('Session expired, clearing auth state');
        await deleteCache('.cache/auth_access_token.txt');
        await deleteCache('.cache/auth_user.json');
        await deleteCache('.cache/auth_expires_at.txt');
        await deleteCache('.cache/auth_remember_me.txt');
        set({ user: null, isLoggedIn: false, loading: false });
      }
    } else {
      // No valid session data
      set({ user: null, isLoggedIn: false, loading: false });
    }
  }

  return {
    subscribe,
    signup,
    login,
    logout,
    getAccessToken,
    initialize,
  };
}

export const authService = createAuthStore();
