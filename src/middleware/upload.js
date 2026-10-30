const multer = require('multer');

// Event covers may be up to 10 MB; profile photos and covers are limited to
// 5 MB in the client. The server enforces the larger of the two.
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE },
});

module.exports = upload;
