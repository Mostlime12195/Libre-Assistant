// Version information for Libre Assistant
export const APP_VERSION = '0.1.0';
export const APP_NAME = 'Libre Assistant';

/**
 * Get the current application version
 */
export function getAppVersion(): string {
  return APP_VERSION;
}

/**
 * Get the application name
 */
export function getAppName(): string {
  return APP_NAME;
}

/**
 * Compare two version strings
 * Returns 1 if version1 > version2, -1 if version1 < version2, 0 if equal
 */
export function compareVersions(version1: string, version2: string): number {
  const parts1 = version1.split('.').map(Number);
  const parts2 = version2.split('.').map(Number);
  
  for (let i = 0; i < 3; i++) {
    if (parts1[i] > parts2[i]) return 1;
    if (parts1[i] < parts2[i]) return -1;
  }
  
  return 0;
}