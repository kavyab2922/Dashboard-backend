const { query } = require('../config/db');

exports.getAllQuickLinks = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, title, description, category, url, icon, placeholder, sort_order
      FROM hcm.quick_links
      ORDER BY sort_order ASC, id ASC
    `);

    const data = result.rows.map(row => {
      const isLeaveManagement = String(row.title || '').trim().toLowerCase() === 'leave management';
      return {
        ...row,
        id: String(row.id),
        ...(isLeaveManagement ? {
          url: 'https://hrorbit.simplify3x.com/login',
          placeholder: false,
        } : {}),
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.createQuickLink = async (req, res, next) => {
  try {
    const { title, description, category, url, icon, placeholder, sort_order } = req.body;
    if (!title || !url) {
      return res.status(400).json({ success: false, message: 'Title and URL are required' });
    }

    const result = await query(`
      INSERT INTO hcm.quick_links (title, description, category, url, icon, placeholder, sort_order)
      VALUES ($1, $2, COALESCE($3, 'HR'), $4, COALESCE($5, 'Orbit'), COALESCE($6, false), COALESCE($7, 0))
      RETURNING id, title, description, category, url, icon, placeholder, sort_order
    `, [title, description || '', category, url, icon, placeholder, sort_order]);

    const row = result.rows[0];
    res.status(201).json({ success: true, data: { ...row, id: String(row.id) } });
  } catch (err) {
    next(err);
  }
};

exports.updateQuickLink = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, category, url, icon, placeholder, sort_order } = req.body;

    const result = await query(`
      UPDATE hcm.quick_links
      SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        category = COALESCE($3, category),
        url = COALESCE($4, url),
        icon = COALESCE($5, icon),
        placeholder = COALESCE($6, placeholder),
        sort_order = COALESCE($7, sort_order)
      WHERE id = $8
      RETURNING id, title, description, category, url, icon, placeholder, sort_order
    `, [title, description, category, url, icon, placeholder, sort_order, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quick link not found' });
    }

    const row = result.rows[0];
    res.json({ success: true, data: { ...row, id: String(row.id) } });
  } catch (err) {
    next(err);
  }
};

exports.deleteQuickLink = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM hcm.quick_links WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quick link not found' });
    }
    res.json({ success: true, message: 'Quick link deleted successfully' });
  } catch (err) {
    next(err);
  }
};
