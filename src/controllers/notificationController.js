const { query } = require('../config/db');

async function employeeIdFromRequest(req) {
  const value = Number(req.user?.id);
  if (Number.isInteger(value) && value > 0) return value;
  const identities = [
    req.user?.employee_code,
    req.user?.employeeCode,
    req.user?.employee_id,
    req.user?.employeeId,
    req.user?.email,
    req.user?.official_email,
    req.user?.personal_email,
  ].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  if (!identities.length) return null;
  const result = await query(`
    SELECT id FROM hcm.employees
    WHERE LOWER(employee_code) = ANY($1::text[])
       OR LOWER(official_email) = ANY($1::text[])
       OR LOWER(personal_email) = ANY($1::text[])
    LIMIT 1
  `, [identities]);
  return result.rows[0]?.id || null;
}

exports.getAllNotifications = async (req, res, next) => {
  try {
    const employeeId = await employeeIdFromRequest(req);
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
    const employeeId = await employeeIdFromRequest(req);
    if (employeeId !== null) {
      await query(
        'UPDATE hcm.notifications SET read = true WHERE id = $1 AND (employee_id = $2 OR employee_id IS NULL)',
        [id, employeeId]
      );
    }
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    next(err);
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    const employeeId = await employeeIdFromRequest(req);
    const notificationIds = Array.isArray(req.body?.notificationIds)
      ? req.body.notificationIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id))
      : [];

    if (employeeId === null || !notificationIds.length) {
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
      [notificationIds, employeeId]
    );
    res.json({ success: true, data: { updated: result.rowCount } });
  } catch (err) {
    next(err);
  }
};
