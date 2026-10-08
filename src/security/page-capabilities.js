export const PAGE_CAPABILITIES = Object.freeze([
  'state.read',
  'state.write',
  'attachment.read',
  'attachment.write',
]);

const CAPABILITY_SET = new Set(PAGE_CAPABILITIES);
const READ_CAPABILITIES = new Set(['state.read', 'attachment.read']);

function invalid(message) {
  throw Object.assign(new Error(message), { statusCode: 400, code: 'invalid_capabilities' });
}

export function normalizeCapabilities(value = []) {
  if (!Array.isArray(value)) invalid('capabilities must be an array');
  const normalized = [];
  for (const capability of value) {
    if (typeof capability !== 'string' || !CAPABILITY_SET.has(capability)) {
      invalid(`unsupported capability: ${String(capability)}`);
    }
    if (!normalized.includes(capability)) normalized.push(capability);
  }
  return normalized.sort();
}

export function parseStoredCapabilities(value) {
  try {
    return normalizeCapabilities(JSON.parse(value || '[]'));
  } catch {
    return [];
  }
}

export function hasReadCapability(capabilities) {
  return capabilities.some(capability => READ_CAPABILITIES.has(capability));
}

export function normalizePageSecurity({ capabilities = [], outboundDenied = false, scriptsEnabled = true } = {}) {
  const normalizedCapabilities = normalizeCapabilities(capabilities);
  return {
    capabilities: normalizedCapabilities,
    outboundDenied: Boolean(outboundDenied) || hasReadCapability(normalizedCapabilities),
    scriptsEnabled: scriptsEnabled !== false,
  };
}

export function bridgePolicy(page) {
  const capabilities = normalizeCapabilities(page?.capabilities || []);
  const readRequiresOutboundDenial = hasReadCapability(capabilities);
  const invariantSatisfied = !readRequiresOutboundDenial || page?.outboundDenied === true;
  return {
    enabled: page?.type === 'html' && page?.scriptsEnabled !== false && invariantSatisfied,
    invariantSatisfied,
    capabilities,
  };
}
