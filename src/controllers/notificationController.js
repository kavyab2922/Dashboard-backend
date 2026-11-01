const { query } = require('../config/db');
const { viewerId, employeeRecordId } = require('../utils/viewerId');

// created_at is TIMESTAMP WITHOUT TIME ZONE written in the database session's
// zone; node-postgres would read it as local (IST) time and shift it by hours.
// A notification sent to everyone is read when this viewer marked it, or when it was
// marked under the old company-wide flag; personal ones use their own read column.
const NOTIFICATION_COLUMNS = `n.id, n.title, n.detail, n.type, n.time,
  CASE WHEN n.employee_id IS NULL
    THEN COALESCE(n.read, false) OR EXISTS (SELECT 1 FROM hcm.notification_reads r WHERE r.notification_id = n.id AND r.viewer_id = $1)
    ELSE COALESCE(n.read, false) END AS read,
  (n.created_at AT TIME ZONE current_setting('TimeZone')) AS created_at`;

// Hide "Upcoming event" notifications whose event has been deleted. Older rows have
// no event_id, so they are matched by the "<title> · <YYYY-MM-DD> at" text they start with.
const EXISTING_EVENTS_ONLY = `NOT (n.type = 'event' AND (
    (n.event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hcm.events e WHERE e.id = n.event_id))
    OR (n.event_id IS NULL AND n.detail ~ ' · [0-9]{4}-[0-9]{2}-[0-9]{2} at '
        AND NOT EXISTS (SELECT 1 FROM hcm.events e WHERE n.detail LIKE e.title || ' · ' || TO_CHAR(e.date, 'YYYY-MM-DD') || ' at %'))
  ))`;

exports.getAllNotifications = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT ${NOTIFICATION_COLUMNS}
      FROM hcm.notifications n
      WHERE (n.employee_id IS NULL OR n.employee_id = $2) AND ${EXISTING_EVENTS_ONLY}
      ORDER BY n.id DESC
    `, [viewerId(req.user), employeeRecordId(req.user)]);

    const data = result.rows.map(row => ({
      ...row,
      id: String(row.id),
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// Marks the given notifications read for this viewer: personal ones on the row,
// company-wide ones in hcm.notification_reads.
async function markNotificationsRead(req, ids) {
  if (!ids.length) return 0;
  const personal = await query(
    'UPDATE hcm.notifications SET read = true WHERE id = ANY($1::int[]) AND employee_id = $2 AND COALESCE(read, false) = false',
    [ids, employeeRecordId(req.user)]
  );
  const shared = await query(
    `INSERT INTO hcm.notification_reads (notification_id, viewer_id)
     SELECT id, $2 FROM hcm.notifications WHERE id = ANY($1::int[]) AND employee_id IS NULL
     ON CONFLICT DO NOTHING`,
    [ids, viewerId(req.user)]
  );
  return personal.rowCount + shared.rowCount;
}

exports.markRead = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Valid notification ID is required.' });
    await markNotificationsRead(req, [id]);
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    next(err);
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    const notificationIds = Array.isArray(req.body?.notificationIds)
      ? req.body.notificationIds.map((id) => Number(id)).filter((id) => Number.isInteger(id))
      : [];
    const updated = await markNotificationsRead(req, notificationIds);
    res.json({ success: true, data: { updated } });
  } catch (err) {
    next(err);
  }
};
