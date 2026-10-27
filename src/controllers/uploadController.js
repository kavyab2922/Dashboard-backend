const path = require('path');
const { uploadToS3 } = require('../config/s3');
const logger = require('../config/logger');

exports.uploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }

    let fileUrl = `/uploads/${req.file.filename}`;

    // If AWS credentials configured, upload to S3
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      try {
        const s3Url = await uploadToS3(req.file.buffer || require('fs').readFileSync(req.file.path), req.file.originalname, req.file.mimetype);
        fileUrl = s3Url;
      } catch (s3Err) {
        logger.warn('S3 upload skipped or failed, using local upload path: ' + s3Err.message);
      }
    }

    res.json({
      success: true,
      data: {
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        url: fileUrl,
      },
    });
  } catch (err) {
    next(err);
  }
};
