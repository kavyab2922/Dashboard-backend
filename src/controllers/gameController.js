const { query } = require('../config/db');

exports.getAllGames = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, title, subtitle, difficulty, description, icon, color, available
      FROM hcm.games
      ORDER BY CASE WHEN id = 'word-connections' THEN 1 WHEN id = 'orbit-grid' THEN 2 ELSE 3 END
    `);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
};
