const multer = require('multer');

const maxFileSize = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileSize,
    files: 1,
  },
  fileFilter: (req, file, callback) => {
    const isPdf =
      file.mimetype === 'application/pdf' ||
      file.originalname.toLowerCase().endsWith('.pdf');

    if (!isPdf) {
      // 400 so the error handler shows this message instead of a generic server error.
      const error = new Error('Only PDF files are allowed.');
      error.status = 400;
      return callback(error);
    }

    callback(null, true);
  },
});

module.exports = upload;
