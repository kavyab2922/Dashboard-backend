const { query } = require('../config/db');

exports.getAllNotifications = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, title, detail, type, read, time, created_at
      FROM hcm.notifications
      WHERE employee_id = $1 OR employee_id IS NULL
      ORDER BY id DESC
    `, [req.user?.id]);

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
    await query('UPDATE hcm.notifications SET read = true WHERE id = $1 AND employee_id = $2', [id, req.user?.id]);
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    next(err);
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    await query('UPDATE hcm.notifications SET read = true WHERE employee_id = $1', [req.user?.id]);
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    next(err);
  }
};
