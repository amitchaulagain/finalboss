/**
 * Central utility for reading the user configuration file.
 * The canonical config location is the Tauri app data directory:
 *   Linux:   $XDG_DATA_HOME/finalboss/user-config.json  (default: ~/.local/share/finalboss/user-config.json)
 *   macOS:   ~/Library/Application Support/finalboss/user-config.json
 *   Windows: %APPDATA%/finalboss/user-config.json
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const APP_NAME = 'finalboss';

function getConfigPath(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, APP_NAME, 'user-config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME, 'user-config.json');
  }
  // Linux / other Unix
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, APP_NAME, 'user-config.json');
}

export const USER_CONFIG_PATH = getConfigPath();

/**
 * Read the user config synchronously. Returns an empty object on any error.
 */
export function readUserConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Read just the formData section of the user config synchronously.
 */
export function readUserFormData(): Record<string, string> {
  return readUserConfig()?.formData ?? {};
}
