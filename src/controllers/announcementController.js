const { query } = require('../config/db');
const redis = require('../config/redis');

exports.getAllAnnouncements = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, title, description, details, category, priority, pinned, read, image,
             TO_CHAR(date, 'YYYY-MM-DD') AS date, created_at
      FROM hcm.announcements
      ORDER BY pinned DESC, date DESC, id DESC
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

exports.createAnnouncement = async (req, res, next) => {
  try {
    const { title, description, details, category, priority, pinned, image, date } = req.body;
    if (!title || !description) {
      return res.status(400).json({ success: false, message: 'Title and description are required' });
    }

    const result = await query(`
      INSERT INTO hcm.announcements (title, description, details, category, priority, pinned, read, image, date)
      VALUES ($1, $2, $3, $4, $5, $6, false, $7, COALESCE($8::date, CURRENT_DATE))
      RETURNING id, title, description, details, category, priority, pinned, read, image, TO_CHAR(date, 'YYYY-MM-DD') AS date
    `, [title, description, details || '', category || 'Company News', priority || 'Normal', Boolean(pinned), image || null, date || null]);

    const row = result.rows[0];
    res.status(201).json({ success: true, data: { ...row, id: String(row.id) } });
  } catch (err) {
    next(err);
  }
};

exports.updateAnnouncement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, details, category, priority, pinned, read, image, date } = req.body;

    const result = await query(`
      UPDATE hcm.announcements
      SET 
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        details = COALESCE($3, details),
        category = COALESCE($4, category),
        priority = COALESCE($5, priority),
        pinned = COALESCE($6, pinned),
        read = COALESCE($7, read),
        image = COALESCE($8, image),
        date = COALESCE($9::date, date),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING id, title, description, details, category, priority, pinned, read, image, TO_CHAR(date, 'YYYY-MM-DD') AS date
    `, [title, description, details, category, priority, pinned, read, image, date, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Announcement not found' });
    }

    const row = result.rows[0];
    res.json({ success: true, data: { ...row, id: String(row.id) } });
  } catch (err) {
    next(err);
  }
};

exports.deleteAnnouncement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM hcm.announcements WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Announcement not found' });
    }
    res.json({ success: true, message: 'Announcement deleted successfully' });
  } catch (err) {
    next(err);
  }
};
