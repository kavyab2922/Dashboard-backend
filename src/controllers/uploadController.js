const path = require('path');
const fs = require('fs');
const { uploadToS3 } = require('../config/s3');
const logger = require('../config/logger');

function safeFileName(fileName) {
  return String(fileName || 'upload').replace(/[^a-zA-Z0-9._-]/g, '-');
}

exports.uploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }

    const uploadDir = path.resolve(process.env.UPLOAD_PATH || './uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeFileName(req.file.originalname)}`;
    const filePath = path.join(uploadDir, uniqueName);

    // 1. Always persist locally so image is immediately served without S3 permission or latency issues
    fs.writeFileSync(filePath, req.file.buffer);

    // 2. If AWS S3 is configured, also upload to S3 as cloud backup
    let s3Key = null;
    let s3Url = null;
    try {
      const s3Res = await uploadToS3(req.file.buffer, req.file.originalname, req.file.mimetype);
      s3Key = s3Res?.key;
      s3Url = s3Res?.url;
    } catch (s3Err) {
      logger.warn(`S3 cloud backup skipped: ${s3Err.message}`);
    }

    const localUrl = `/uploads/${uniqueName}`;

    return res.json({
      success: true,
      data: {
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        key: s3Key || `uploads/${uniqueName}`,
        url: localUrl,
        cloudUrl: s3Url,
        storage: s3Key ? 'local+s3' : 'local',
      },
    });
  } catch (err) {
    next(err);
  }
};
