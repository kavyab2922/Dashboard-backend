const express = require('express');
const router = express.Router();

const {
  authenticate,
  requireAdmin,
  requireAdminUnlessReadOnly,
  requireAdminForEventImage,
} = require('../middleware/auth');

const { requireAllowedNetwork } = require('../middleware/network');
const upload = require('../middleware/upload');
const validate = require('../middleware/validate');
const schemas = require('../validation/schemas');

const authController = require('../controllers/authController');
const ssoController = require('../controllers/ssoController');
const loginController = require('../controllers/loginController');
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
const moodController = require('../controllers/moodController');
const uploadController = require('../controllers/uploadController');
const presenceController = require('../controllers/presenceController');
const chatbotController = require('../controllers/chatbotController');
const chatbotDocumentController = require('../controllers/chatbotDocumentController');
const chatbotDocumentUpload = require('../middleware/chatbotDocumentUpload');

const { pool } = require('../config/db');
const redis = require('../config/redis');

// Health check
router.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';

  try {
    await pool.query('SELECT 1');
    dbStatus = 'connected';
  } catch (error) {
    dbStatus = `error: ${error.message}`;
  }

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: dbStatus,
    redis:
      redis.client && redis.client.isOpen
        ? 'connected'
        : 'disabled_or_connecting',
  });
});

// Authentication and user profile
// Sign-in is only allowed from the office Wi-Fi or VPN.
router.get('/auth/sso/start', requireAllowedNetwork, ssoController.start);
router.get('/auth/sso/callback', requireAllowedNetwork, ssoController.callback);
router.post('/auth/login', requireAllowedNetwork, loginController.passwordLogin);
router.get('/auth/me', authenticate, authController.getMe);
router.get('/profile', authenticate, authController.getMe);
router.put('/profile', authenticate, employeeController.updateProfile);

// Employees, birthday notifications and celebrations
router.get(
  '/employees',
  authenticate,
  employeeController.getEmployees
);

router.get(
  '/birthdays/today',
  authenticate,
  employeeController.getTodaysBirthdays
);

router.put(
  '/birthdays/read-all',
  authenticate,
  employeeController.markAllBirthdaysRead
);

router.put(
  '/birthdays/:employeeId/read',
  authenticate,
  employeeController.markBirthdayRead
);

router.get(
  '/celebrations',
  authenticate,
  employeeController.getCelebrations
);

router.get(
  '/hr-contacts',
  authenticate,
  employeeController.getHRContacts
);

// Presence: browsers report activity each minute; Teams status is used when configured
router.post(
  '/presence/heartbeat',
  authenticate,
  presenceController.heartbeat
);

router.post(
  '/presence',
  authenticate,
  validate(schemas.presenceLookup),
  presenceController.getPresence
);

// Announcements
router.get(
  '/announcements',
  authenticate,
  announcementController.getAllAnnouncements
);

router.post(
  '/announcements',
  authenticate,
  requireAdmin,
  validate(schemas.announcementCreate),
  announcementController.createAnnouncement
);

router.put(
  '/announcements/:id',
  authenticate,
  requireAdminUnlessReadOnly,
  validate(schemas.idParams, 'params'),
  validate(schemas.announcementUpdate),
  announcementController.updateAnnouncement
);

router.delete(
  '/announcements/:id',
  authenticate,
  requireAdmin,
  validate(schemas.idParams, 'params'),
  announcementController.deleteAnnouncement
);

// Events
router.get(
  '/events',
  authenticate,
  eventController.getAllEvents
);

router.post(
  '/events',
  authenticate,
  requireAdmin,
  validate(schemas.eventCreate),
  requireAdminForEventImage,
  eventController.createEvent
);

router.put(
  '/events/:id',
  authenticate,
  requireAdmin,
  validate(schemas.idParams, 'params'),
  validate(schemas.eventUpdate),
  requireAdminForEventImage,
  eventController.updateEvent
);

router.delete(
  '/events/:id',
  authenticate,
  requireAdmin,
  validate(schemas.idParams, 'params'),
  eventController.deleteEvent
);

// Cover photo for a holiday-calendar entry (the holiday itself is read-only here)
router.put(
  '/events/holiday/:id/cover',
  authenticate,
  requireAdmin,
  validate(schemas.idParams, 'params'),
  validate(schemas.holidayCover),
  requireAdminForEventImage,
  eventController.setHolidayCover
);

// Quick links
router.get(
  '/quick-links',
  authenticate,
  quickLinkController.getAllQuickLinks
);

router.post(
  '/quick-links',
  authenticate,
  requireAdmin,
  quickLinkController.createQuickLink
);

router.put(
  '/quick-links/:id',
  authenticate,
  requireAdmin,
  quickLinkController.updateQuickLink
);

router.delete(
  '/quick-links/:id',
  authenticate,
  requireAdmin,
  quickLinkController.deleteQuickLink
);

// Kudos
router.get(
  '/kudos',
  authenticate,
  kudoController.getAllKudos
);

router.post(
  '/kudos',
  authenticate,
  kudoController.createKudo
);

// Notifications
router.get(
  '/notifications',
  authenticate,
  notificationController.getAllNotifications
);

router.put(
  '/notifications/:id/read',
  authenticate,
  notificationController.markRead
);

router.put(
  '/notifications/read-all',
  authenticate,
  notificationController.markAllRead
);

// Learning courses
router.get(
  '/courses',
  authenticate,
  courseController.getAllCourses
);

// FAQs
router.get(
  '/faqs',
  authenticate,
  faqController.getAllFaqs
);

// Games
router.get(
  '/games',
  authenticate,
  gameController.getAllGames
);

// Daily games
router.get(
  '/daily-games',
  authenticate,
  gameController.listDailyGames
);

router.get(
  '/daily-games/me/stats',
  authenticate,
  gameController.getStats
);

router.get(
  '/daily-games/:gameId/puzzle',
  authenticate,
  gameController.getPuzzle
);

router.post(
  '/daily-games/:gameId/sessions',
  authenticate,
  gameController.startGame
);

router.post(
  '/daily-games/:gameId/check',
  authenticate,
  gameController.checkSolution
);

router.post(
  '/daily-games/:gameId/hint',
  authenticate,
  gameController.useHint
);

router.post(
  '/daily-games/:gameId/complete',
  authenticate,
  gameController.completeGame
);

router.get(
  '/daily-games/leaderboard',
  authenticate,
  gameController.getLeaderboard
);

router.get(
  '/daily-games/champions',
  authenticate,
  gameController.getChampions
);

router.get(
  '/daily-games/celebrations',
  authenticate,
  gameController.getCelebrations
);

router.post(
  '/daily-games/celebrations/ack',
  authenticate,
  gameController.acknowledgeCelebration
);

// Dashboard summary
router.get(
  '/dashboard/summary',
  authenticate,
  dashboardController.getDashboardSummary
);

// Team mood and appreciation
router.get(
  '/moods/state',
  authenticate,
  moodController.getMoodState
);

router.put(
  '/moods/today',
  authenticate,
  moodController.saveMood
);

router.get(
  '/moods/team',
  authenticate,
  moodController.getTeamMoods
);

router.post(
  '/moods/:id/reactions',
  authenticate,
  moodController.addReaction
);

router.post(
  '/moods/:id/messages',
  authenticate,
  moodController.sendMessage
);

router.get(
  '/mood-messages',
  authenticate,
  moodController.getMessages
);

router.put(
  '/mood-messages/:id/chat',
  authenticate,
  moodController.respondToChatOffer
);

// File upload
router.post(
  '/upload',
  authenticate,
  upload.single('file'),
  uploadController.uploadFile
);

// HR assistant chatbot. Any signed-in employee can ask; only HR admins manage
// the PDF documents it answers from.
router.post('/chatbot/ask', authenticate, chatbotController.askChatbot);
router.get('/chatbot/employees-on-leave', authenticate, chatbotController.getEmployeesOnLeave);
router.post('/chatbot/documents', authenticate, requireAdmin, chatbotDocumentUpload.single('file'), chatbotDocumentController.uploadDocument);
router.get('/chatbot/documents', authenticate, requireAdmin, chatbotDocumentController.listDocuments);

module.exports = router;