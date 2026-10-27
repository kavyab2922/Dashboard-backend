const { query } = require('../config/db');

exports.getAllNotifications = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, title, detail, type, read, time, created_at
      FROM hcm.notifications
      ORDER BY id DESC
    `);

    const data = result.rows.map(row => ({
      ...row,
      id: String(row.id),
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.markRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    await query('UPDATE hcm.notifications SET read = true WHERE id = $1', [id]);
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    next(err);
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    await query('UPDATE hcm.notifications SET read = true');
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    next(err);
  }
};
