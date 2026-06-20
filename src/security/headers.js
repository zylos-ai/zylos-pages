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

export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', DEFAULT_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0'); // Disabled per modern best practice
    next();
  };
}
