const { query } = require('../config/db');

exports.getAllKudos = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, from_name AS "from", to_name AS "to", category, message, initials, color,
             TO_CHAR(date, 'YYYY-MM-DD') AS date, created_at
      FROM hcm.kudos
      ORDER BY date DESC, id DESC
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

exports.createKudo = async (req, res, next) => {
  try {
    const { from, to, category, message, initials, color, date } = req.body;
    if (!from || !to || !message) {
      return res.status(400).json({ success: false, message: 'From, To and Message are required' });
    }

    const computedInitials = initials || from.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();

    const result = await query(`
      INSERT INTO hcm.kudos (from_name, to_name, category, message, initials, color, date)
      VALUES ($1, $2, COALESCE($3, 'Teamwork'), $4, $5, COALESCE($6, 'purple'), COALESCE($7::date, CURRENT_DATE))
      RETURNING id, from_name AS "from", to_name AS "to", category, message, initials, color, TO_CHAR(date, 'YYYY-MM-DD') AS date
    `, [from, to, category, message, computedInitials, color, date]);

    const row = result.rows[0];
    res.status(201).json({ success: true, data: { ...row, id: String(row.id) } });
  } catch (err) {
    next(err);
  }
};
