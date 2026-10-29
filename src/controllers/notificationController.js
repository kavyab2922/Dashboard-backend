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
    await query(
      'UPDATE hcm.notifications SET read = true WHERE id = $1 AND (employee_id = $2 OR employee_id IS NULL)',
      [id, req.user?.id]
    );
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    next(err);
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    const notificationIds = Array.isArray(req.body?.notificationIds)
      ? req.body.notificationIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id))
      : [];

    if (!notificationIds.length) {
      return res.json({ success: true, data: { updated: 0 } });
    }

    const result = await query(
      `
        UPDATE hcm.notifications
        SET read = true
        WHERE id = ANY($1::int[])
          AND (employee_id = $2 OR employee_id IS NULL)
          AND COALESCE(read, false) = false
      `,
      [notificationIds, req.user?.id]
    );
    res.json({ success: true, data: { updated: result.rowCount } });
  } catch (err) {
    next(err);
  }
};

