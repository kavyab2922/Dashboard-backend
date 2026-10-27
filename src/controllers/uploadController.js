const { uploadToS3 } = require('../config/s3');

exports.uploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }

    const uploaded = await uploadToS3(req.file.buffer, req.file.originalname, req.file.mimetype);

    res.json({
      success: true,
      data: {
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        key: uploaded.key,
        url: uploaded.url,
      },
    });
  } catch (err) {
    next(err);
  }
};
