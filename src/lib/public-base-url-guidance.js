export const PUBLIC_BASE_URL_CONFIG_PATH = '~/zylos/components/pages/config.json';
export const PUBLIC_BASE_URL_EXAMPLE = 'https://agent.example/pages';

export function hasConfiguredPublicBaseUrl(config) {
  return typeof config?.publicBaseUrl === 'string' && config.publicBaseUrl.trim().length > 0;
}

export function publicBaseUrlGuidance() {
  return `Set "publicBaseUrl" in ${PUBLIC_BASE_URL_CONFIG_PATH} to the externally reachable absolute Pages base URL (for example, "${PUBLIC_BASE_URL_EXAMPLE}"). This is required when Pages is behind a reverse proxy. Agents must ask the owner for the external URL when it is unknown; do not infer it from forwarded headers.`;
}

export function warnIfPublicBaseUrlMissing(config, warn) {
  if (hasConfiguredPublicBaseUrl(config)) return false;
  warn(publicBaseUrlGuidance());
  return true;
}
