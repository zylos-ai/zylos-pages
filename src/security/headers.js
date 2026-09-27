// Security response headers middleware (P0-5)

export const DEFAULT_CSP = "default-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "font-src 'self'; " +
  "script-src 'self'; " +
  "object-src 'none'; " +
  "frame-ancestors 'none'";

export const HTML_ARTIFACT_CSP = "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "frame-ancestors 'self'; " +
  "base-uri 'self'";

export const SANDBOXED_HTML_ARTIFACT_CSP = "sandbox allow-scripts; " +
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "frame-ancestors 'self'; " +
  "base-uri 'self'";

export function sandboxedHtmlArtifactCsp({ scriptsEnabled = true, outboundDenied = false } = {}) {
  const sandbox = scriptsEnabled ? 'sandbox allow-scripts' : 'sandbox';
  const script = scriptsEnabled ? "script-src 'self' 'unsafe-inline'" : "script-src 'none'";
  if (!outboundDenied) {
    return `${sandbox}; default-src 'self'; ${script}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'`;
  }
  return `${sandbox}; default-src 'none'; ${script}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; navigate-to 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; prefetch-src 'none'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'`;
}

export const SVG_ASSET_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', DEFAULT_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0'); // Disabled per modern best practice
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  };
}
