const { query } = require('../config/db');

exports.getAllCourses = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, title, provider, category, level, duration, access, certificate, description, url, image
      FROM hcm.learning_courses
      ORDER BY id ASC
    `);

    const data = result.rows.map(row => ({
      ...row,
      id: `c${row.id}`,
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
