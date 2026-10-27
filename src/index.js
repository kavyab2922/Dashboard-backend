require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
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
app.use('/uploads', express.static(uploadDir));

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
