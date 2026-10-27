const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    logger.warn('Invalid JWT token: ' + err.message);
    return res.status(401).json({ success: false, message: 'Session expired. Please sign in again.' });
  }
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function isAdminRole(role) {
  return ['admin', 'hr admin'].includes(String(role || '').trim().toLowerCase());
}

const MAX_EVENT_IMAGE_BYTES = 5 * 1024 * 1024;
const EVENT_IMAGE_ASPECT_RATIO = 16 / 9;
const EVENT_IMAGE_ASPECT_TOLERANCE = 0.01;
const EVENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function getImageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (mimeType === 'image/webp' && buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const format = buffer.toString('ascii', 12, 16);
    if (format === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (format === 'VP8L' && buffer.length >= 25) {
      return {
        width: 1 + (((buffer[21] | (buffer[22] << 8)) & 0x3fff)),
        height: 1 + ((((buffer[22] >> 6) | (buffer[23] << 2) | ((buffer[24] & 0xf) << 10)) & 0x3fff)),
      };
    }
  }

  if (mimeType === 'image/jpeg' && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      if (segmentLength < 2) break;
      offset += 2 + segmentLength;
    }
  }

  return null;
}

function validateEventImage(image) {
  if (!image) return null;
  const match = String(image).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !EVENT_IMAGE_TYPES.has(match[1])) {
    return 'Event photos must be JPG, PNG, or WebP images.';
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_EVENT_IMAGE_BYTES) {
    return 'Event photos must be 5 MB or smaller.';
  }

  const dimensions = getImageDimensions(buffer, match[1]);
  const aspectRatio = dimensions ? dimensions.width / dimensions.height : 0;
  if (!dimensions || Math.abs(aspectRatio - EVENT_IMAGE_ASPECT_RATIO) > EVENT_IMAGE_ASPECT_TOLERANCE) {
    return 'Event photos must use a 16:9 aspect ratio.';
  }
  return null;
}

function requireAdminForEventImage(req, res, next) {
  if (req.body?.image && !isAdminRole(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'Only admins can upload upcoming event photos.' });
  }
  const imageError = validateEventImage(req.body?.image);
  if (imageError) {
    return res.status(400).json({ success: false, message: imageError });
  }
  return next();
}

module.exports = {
  authenticate,
  generateToken,
  requireAdminForEventImage,
};
