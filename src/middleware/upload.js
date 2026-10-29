const multer = require('multer');

// Profile uploads are intentionally unrestricted. S3 stores the original file
// and the client decides how to present it in the profile editor.
const upload = multer({
  storage: multer.memoryStorage(),
});

module.exports = upload;
