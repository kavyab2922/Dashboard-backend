const { query } = require('../config/db');

// created_at is TIMESTAMP WITHOUT TIME ZONE written in the database session's
// zone; node-postgres would read it as local (IST) time and shift it by hours.
const NOTIFICATION_COLUMNS = `id, title, detail, type, read, time,
  (created_at AT TIME ZONE current_setting('TimeZone')) AS created_at`;

// Hide "Upcoming event" notifications whose event has been deleted. Older rows have
// no event_id, so they are matched by the "<title> · <YYYY-MM-DD> at" text they start with.
const EXISTING_EVENTS_ONLY = `NOT (n.type = 'event' AND (
    (n.event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hcm.events e WHERE e.id = n.event_id))
    OR (n.event_id IS NULL AND n.detail ~ ' · [0-9]{4}-[0-9]{2}-[0-9]{2} at '
        AND NOT EXISTS (SELECT 1 FROM hcm.events e WHERE n.detail LIKE e.title || ' · ' || TO_CHAR(e.date, 'YYYY-MM-DD') || ' at %'))
  ))`;

function employeeIdFromRequest(req) {
  const value = Number(req.user?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

exports.getAllNotifications = async (req, res, next) => {
  try {
    const employeeId = employeeIdFromRequest(req);
    const result = employeeId === null
      ? await query(`
          SELECT ${NOTIFICATION_COLUMNS}
          FROM hcm.notifications n
          WHERE n.employee_id IS NULL AND ${EXISTING_EVENTS_ONLY}
          ORDER BY n.id DESC
        `)
      : await query(`
          SELECT ${NOTIFICATION_COLUMNS}
          FROM hcm.notifications n
          WHERE (n.employee_id = $1 OR n.employee_id IS NULL) AND ${EXISTING_EVENTS_ONLY}
          ORDER BY n.id DESC
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
    const employeeId = employeeIdFromRequest(req);
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
