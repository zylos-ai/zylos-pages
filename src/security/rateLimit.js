// Basic rate limiting middleware (P0-4)

import rateLimit from 'express-rate-limit';

export function createRateLimiter(config = {}) {
  return rateLimit({
    windowMs: config.windowMs || 60 * 1000, // 1 minute
    max: config.max || 60,                    // 60 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
}
