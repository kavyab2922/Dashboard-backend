const { query } = require('../config/db');

exports.getAllEvents = async (req, res, next) => {
  try {
    const customEventsRes = await query(`
      SELECT id, title, description, TO_CHAR(date, 'YYYY-MM-DD') AS date, time, venue, category, rsvp, color, image
      FROM hcm.events
      ORDER BY date ASC, id ASC
    `);

    // Fetch upcoming holidays from organization_holidays
    const holidaysRes = await query(`
      SELECT DISTINCT ON (LOWER(TRIM(holiday_name)), start_date::date)
             id, holiday_name, description, TO_CHAR(start_date, 'YYYY-MM-DD') AS date, holiday_type
      FROM hcm.organization_holidays
      WHERE start_date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY LOWER(TRIM(holiday_name)), start_date::date, id ASC
      LIMIT 10
    `);

    const holidayEvents = holidaysRes.rows.map(h => ({
      id: `holiday-${h.id}`,
      title: h.holiday_name,
      description: h.description || 'Public Company Holiday',
      date: h.date,
      time: 'All Day',
      venue: 'Company-Wide',
      category: 'Holiday',
      rsvp: '',
      color: 'gold',
      image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=800&q=85',
    }));

    const events = [
      ...customEventsRes.rows.map(r => ({ ...r, id: String(r.id) })),
      ...holidayEvents,
    ].sort((a, b) => a.date.localeCompare(b.date));

    res.json({ success: true, data: events });
  } catch (err) {
    next(err);
  }
};

exports.createEvent = async (req, res, next) => {
  try {
    const { title, description, date, time, venue, category, rsvp, color, image } = req.body;
    if (!title || !description || !date) {
      return res.status(400).json({ success: false, message: 'Title, description and date are required' });
    }

    const result = await query(`
      INSERT INTO hcm.events (title, description, date, time, venue, category, rsvp, color, image)
      VALUES ($1, $2, $3::date, COALESCE($4, '12:00 PM'), $5, COALESCE($6, 'Community'), $7, COALESCE($8, 'mint'), $9)
      RETURNING id, title, description, TO_CHAR(date, 'YYYY-MM-DD') AS date, time, venue, category, rsvp, color, image
    `, [title, description, date, time, venue || '', category, rsvp || '', color, image || null]);

    const row = result.rows[0];
    res.status(201).json({ success: true, data: { ...row, id: String(row.id) } });
  } catch (err) {
    next(err);
  }
};

exports.updateEvent = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, date, time, venue, category, rsvp, color, image } = req.body;

    const result = await query(`
      UPDATE hcm.events
      SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        date = COALESCE($3::date, date),
        time = COALESCE($4, time),
        venue = COALESCE($5, venue),
        category = COALESCE($6, category),
        rsvp = COALESCE($7, rsvp),
        color = COALESCE($8, color),
        image = COALESCE($9, image),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING id, title, description, TO_CHAR(date, 'YYYY-MM-DD') AS date, time, venue, category, rsvp, color, image
    `, [title, description, date, time, venue, category, rsvp, color, image, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const row = result.rows[0];
    res.json({ success: true, data: { ...row, id: String(row.id) } });
  } catch (err) {
    next(err);
  }
};

exports.deleteEvent = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM hcm.events WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (err) {
    next(err);
  }
};
