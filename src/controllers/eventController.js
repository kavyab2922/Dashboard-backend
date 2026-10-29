const { query } = require('../config/db');

exports.getAllEvents = async (req, res, next) => {
  try {
    const customEventsRes = await query(`
      SELECT id, title, description, TO_CHAR(date, 'YYYY-MM-DD') AS date, time, venue, category, rsvp, color, image, COALESCE(hosts, '[]'::jsonb) AS hosts
      FROM hcm.events
      ORDER BY date ASC, id ASC
    `);

    // Fetch upcoming holidays from organization_holidays
    const holidaysRes = await query(`
      SELECT DISTINCT ON (LOWER(TRIM(h.holiday_name)), h.start_date::date)
             h.id, h.holiday_name, h.description, TO_CHAR(h.start_date, 'YYYY-MM-DD') AS date, h.holiday_type,
             hc.image AS cover_image
      FROM hcm.organization_holidays h
      LEFT JOIN hcm.holiday_covers hc ON hc.holiday_id = h.id
      WHERE h.start_date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY LOWER(TRIM(h.holiday_name)), h.start_date::date, h.id ASC
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
      image: h.cover_image || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=800&q=85',
      hasCustomCover: Boolean(h.cover_image),
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

// Sets (or with an empty image, clears) the cover photo of a holiday-calendar entry.
exports.setHolidayCover = async (req, res, next) => {
  try {
    const holidayId = Number(req.params.id);
    const { image } = req.body;
    const holiday = await query('SELECT id FROM hcm.organization_holidays WHERE id = $1', [holidayId]);
    if (holiday.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Holiday not found' });
    }

    if (!image) {
      await query('DELETE FROM hcm.holiday_covers WHERE holiday_id = $1', [holidayId]);
      return res.json({ success: true, data: { id: `holiday-${holidayId}`, image: null } });
    }

    await query(`
      INSERT INTO hcm.holiday_covers (holiday_id, image, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (holiday_id) DO UPDATE SET image = EXCLUDED.image, updated_at = CURRENT_TIMESTAMP
    `, [holidayId, image]);
    return res.json({ success: true, data: { id: `holiday-${holidayId}`, image } });
  } catch (err) {
    return next(err);
  }
};

exports.createEvent = async (req, res, next) => {
  try {
    const { title, description, date, time, venue, category, rsvp, color, image, hosts } = req.body;
    const requiresHost = category !== 'Holiday';
    if (!title || !description || !date || !time || !venue || !Array.isArray(hosts) || (requiresHost && hosts.length === 0)) {
      return res.status(400).json({ success: false, message: requiresHost ? 'Title, description, date, time, venue and at least one host are required' : 'Title, description, date and venue are required' });
    }

    const result = await query(`
      INSERT INTO hcm.events (title, description, date, time, venue, category, rsvp, color, image, hosts)
      VALUES ($1, $2, $3::date, COALESCE($4, '12:00 PM'), $5, COALESCE($6, 'Community'), $7, COALESCE($8, 'mint'), $9, COALESCE($10::jsonb, '[]'::jsonb))
      RETURNING id, title, description, TO_CHAR(date, 'YYYY-MM-DD') AS date, time, venue, category, rsvp, color, image, COALESCE(hosts, '[]'::jsonb) AS hosts
    `, [title, description, date, time, venue || '', category, rsvp || '', color, image || null, JSON.stringify(Array.isArray(hosts) ? hosts : [])]);

    const row = result.rows[0];
    res.status(201).json({ success: true, data: { ...row, id: String(row.id) } });
  } catch (err) {
    next(err);
  }
};

exports.updateEvent = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, date, time, venue, category, rsvp, color, image, hosts } = req.body;
    const requiresHost = category !== 'Holiday';
    if (hosts !== undefined && (!Array.isArray(hosts) || (requiresHost && hosts.length === 0))) {
      return res.status(400).json({ success: false, message: requiresHost ? 'At least one host is required' : 'Hosts are optional for Holiday events' });
    }
    if (title === '' || description === '' || date === '' || time === '' || venue === '') {
      return res.status(400).json({ success: false, message: 'Title, description, date, time and venue cannot be empty' });
    }

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
        hosts = COALESCE($10::jsonb, hosts),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING id, title, description, TO_CHAR(date, 'YYYY-MM-DD') AS date, time, venue, category, rsvp, color, image, COALESCE(hosts, '[]'::jsonb) AS hosts
    `, [title, description, date, time, venue, category, rsvp, color, image, hosts === undefined ? null : JSON.stringify(Array.isArray(hosts) ? hosts : []), id]);

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
