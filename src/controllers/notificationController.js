const { query } = require('../config/db');

function employeeIdFromRequest(req) {
  const value = Number(req.user?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

exports.getAllNotifications = async (req, res, next) => {
  try {
    const employeeId = employeeIdFromRequest(req);
    const result = employeeId === null
      ? await query(`
          SELECT id, title, detail, type, read, time, created_at
          FROM hcm.notifications
          WHERE employee_id IS NULL
          ORDER BY id DESC
        `)
      : await query(`
          SELECT id, title, detail, type, read, time, created_at
          FROM hcm.notifications
          WHERE employee_id = $1 OR employee_id IS NULL
          ORDER BY id DESC
        `, [employeeId]);

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
    const employeeId = employeeIdFromRequest(req);
    if (employeeId !== null) {
      await query('UPDATE hcm.notifications SET read = true WHERE id = $1 AND employee_id = $2', [id, employeeId]);
    }
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    next(err);
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    const employeeId = employeeIdFromRequest(req);
    if (employeeId !== null) {
      await query('UPDATE hcm.notifications SET read = true WHERE employee_id = $1', [employeeId]);
    }
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    next(err);
  }
};
