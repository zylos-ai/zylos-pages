// Security response headers middleware (P0-5)

export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; " +
      "font-src 'self'; " +
      "script-src 'none'; " +
      "object-src 'none'; " +
      "frame-ancestors 'none'"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0'); // Disabled per modern best practice
    next();
  };
}
