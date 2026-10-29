require('dotenv').config();
const path = require('path');
const fs = require('fs');
// Load backend environment variables before importing routes/controllers that create the S3 client.
require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  override: true,
});
const express = require('express');
const cors = require('cors');
const logger = require('./config/logger');
const initDb = require('./db/initDb');
const apiRoutes = require('./routes/api');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS setup
const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (like mobile apps, curl, postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    // allow localhost origins in development
    if (process.env.NODE_ENV === 'development' && origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Request parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static file serving for uploads
const uploadDir = path.resolve(process.env.UPLOAD_PATH || './uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// Fallback: If a requested upload is in S3 but not on local disk, fetch and cache it
app.get('/uploads/*filename', async (req, res) => {
  // Express 5 returns wildcard params as an array of path segments.
  const filename = [].concat(req.params.filename).join('/');
  try {
    const { getObjectStream } = require('./config/s3');
    const key = filename.startsWith('uploads/') ? filename : `uploads/${filename}`;
    const s3Response = await getObjectStream(key);
    if (!s3Response || !s3Response.Body) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    res.setHeader('Content-Type', s3Response.ContentType || 'image/jpeg');
    if (s3Response.ContentLength) {
      res.setHeader('Content-Length', s3Response.ContentLength);
    }

    // Save locally for future fast hits
    const localFilePath = path.join(uploadDir, path.basename(filename));
    const writeStream = fs.createWriteStream(localFilePath);
    s3Response.Body.pipe(writeStream);
    s3Response.Body.pipe(res);
  } catch (err) {
    logger.debug(`Upload not found in local or S3 (/uploads/${filename}): ${err.message}`);
    return res.status(404).json({ success: false, message: 'File not found' });
  }
});

// Request logging in development
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.url}`);
    next();
  });
}

// API Routes
app.use('/api', apiRoutes);

// Root health ping
app.get('/', (req, res) => {
  res.json({
    message: 'HROrbit Backend API Server is running',
    version: '1.0.0',
    documentation: '/api/health',
  });
});

// Centralized error handler
app.use(errorHandler);

// Start Server
async function startServer() {
  try {
    await initDb();
    app.listen(PORT, () => {
      logger.info(`Server successfully started on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
      logger.info(`API Base URL: ${process.env.BACKEND_URL || `http://localhost:${PORT}/api`}`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
