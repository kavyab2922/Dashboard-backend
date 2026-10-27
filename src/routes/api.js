const express = require('express');
const router = express.Router();

const { authenticate, requireAdminForEventImage } = require('../middleware/auth');
const upload = require('../middleware/upload');

const authController = require('../controllers/authController');
const employeeController = require('../controllers/employeeController');
const announcementController = require('../controllers/announcementController');
const eventController = require('../controllers/eventController');
const quickLinkController = require('../controllers/quickLinkController');
const kudoController = require('../controllers/kudoController');
const notificationController = require('../controllers/notificationController');
const courseController = require('../controllers/courseController');
const faqController = require('../controllers/faqController');
const gameController = require('../controllers/gameController');
const dashboardController = require('../controllers/dashboardController');
const uploadController = require('../controllers/uploadController');
const { pool } = require('../config/db');
const redis = require('../config/redis');

// Health Check
router.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'connected';
  } catch (e) {
    dbStatus = 'error: ' + e.message;
  }

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: dbStatus,
    redis: redis.client && redis.client.isOpen ? 'connected' : 'disabled_or_connecting',
  });
});

// Auth & User Profile
router.post('/auth/login', authController.login);
router.get('/auth/me', authenticate, authController.getMe);
router.get('/profile', authenticate, authController.getMe);
router.put('/profile', authenticate, employeeController.updateProfile);

// Employees & Celebrations
router.get('/employees', authenticate, employeeController.getEmployees);
router.get('/celebrations', authenticate, employeeController.getCelebrations);
router.get('/hr-contacts', authenticate, employeeController.getHRContacts);

// Announcements (CRUD)
router.get('/announcements', authenticate, announcementController.getAllAnnouncements);
router.post('/announcements', authenticate, announcementController.createAnnouncement);
router.put('/announcements/:id', authenticate, announcementController.updateAnnouncement);
router.delete('/announcements/:id', authenticate, announcementController.deleteAnnouncement);

// Events (CRUD)
router.get('/events', authenticate, eventController.getAllEvents);
router.post('/events', authenticate, requireAdminForEventImage, eventController.createEvent);
router.put('/events/:id', authenticate, requireAdminForEventImage, eventController.updateEvent);
router.delete('/events/:id', authenticate, eventController.deleteEvent);

// Quick Links (CRUD)
router.get('/quick-links', authenticate, quickLinkController.getAllQuickLinks);
router.post('/quick-links', authenticate, quickLinkController.createQuickLink);
router.put('/quick-links/:id', authenticate, quickLinkController.updateQuickLink);
router.delete('/quick-links/:id', authenticate, quickLinkController.deleteQuickLink);

// Kudos
router.get('/kudos', authenticate, kudoController.getAllKudos);
router.post('/kudos', authenticate, kudoController.createKudo);

// Notifications
router.get('/notifications', authenticate, notificationController.getAllNotifications);
router.put('/notifications/:id/read', authenticate, notificationController.markRead);
router.put('/notifications/read-all', authenticate, notificationController.markAllRead);

// Learning Courses
router.get('/courses', authenticate, courseController.getAllCourses);

// FAQs
router.get('/faqs', authenticate, faqController.getAllFaqs);

// Games
router.get('/games', authenticate, gameController.getAllGames);

// Dashboard Summary
router.get('/dashboard/summary', authenticate, dashboardController.getDashboardSummary);

// File Upload
router.post('/upload', authenticate, upload.single('file'), uploadController.uploadFile);

module.exports = router;
