const { query } = require('../config/db');

exports.getAllFaqs = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, category, question, answer
      FROM hcm.faqs
      ORDER BY id ASC
    `);

    const data = result.rows.map(row => ({
      ...row,
      id: `f${row.id}`,
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
