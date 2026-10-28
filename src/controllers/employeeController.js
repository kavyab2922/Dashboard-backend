const { query } = require('../config/db');
const redis = require('../config/redis');
const logger = require('../config/logger');

const COLORS = ['blue', 'purple', 'mint', 'gold', 'rose', 'slate'];

function dateOnly(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

exports.getEmployees = async (req, res, next) => {
  try {
    const cached = await redis.get('hrobit:employees:list:v3');
    if (cached) {
      return res.json({ success: true, data: JSON.parse(cached) });
    }

    const result = await query(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, e.official_email, e.dob, e.join_date,
             e.profile_picture_url, d.department_name, des.designation_name
      FROM hcm.employees e
      LEFT JOIN hcm.departments d ON e.department_id = d.id
      LEFT JOIN hcm.designations des ON e.designation_id = des.id
      WHERE e.is_active = true AND e.is_deleted = false
      ORDER BY e.first_name, e.last_name
    `);

    const employees = result.rows.map((row, idx) => {
      const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Team Member';
      const initials = name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
      return {
        id: String(row.id),
        employee_code: row.employee_code,
        name,
        role: row.designation_name || 'Software Specialist',
        team: row.department_name || 'Engineering',
        email: row.official_email || `${row.employee_code?.toLowerCase() || 'member'}@simplify3x.com`,
        location: 'Bengaluru',
        birthday: row.dob ? row.dob.toISOString().slice(0, 10) : '2000-01-01',
        joined: row.join_date ? row.join_date.toISOString().slice(0, 10) : '2025-01-01',
        initials,
        color: COLORS[idx % COLORS.length],
        avatar: row.profile_picture_url || null,
      };
    });

    await redis.set('hrobit:employees:list:v3', employees, 300);
    res.json({ success: true, data: employees });
  } catch (err) {
    next(err);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const userId = req.user?.id || 15002;
    const { bio, location, roleTitle, interests, coverUrl, avatarUrl } = req.body;

    await query(`
      INSERT INTO hcm.user_profiles (employee_id, bio, location, role_title, interests, cover_url, avatar_url, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (employee_id) DO UPDATE SET
        bio = COALESCE(EXCLUDED.bio, hcm.user_profiles.bio),
        location = COALESCE(EXCLUDED.location, hcm.user_profiles.location),
        role_title = COALESCE(EXCLUDED.role_title, hcm.user_profiles.role_title),
        interests = COALESCE(EXCLUDED.interests, hcm.user_profiles.interests),
        cover_url = COALESCE(EXCLUDED.cover_url, hcm.user_profiles.cover_url),
        avatar_url = COALESCE(EXCLUDED.avatar_url, hcm.user_profiles.avatar_url),
        updated_at = CURRENT_TIMESTAMP
    `, [userId, bio, location, roleTitle, JSON.stringify(interests || []), coverUrl, avatarUrl]);

    await redis.del('hrobit:employees:list');
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    next(err);
  }
};

exports.getCelebrations = async (req, res, next) => {
  try {
    const cached = await redis.get('hrobit:celebrations');
    if (cached) {
      return res.json({ success: true, data: JSON.parse(cached) });
    }

    // Query active employees with DOB
    const result = await query(`
      SELECT e.id, e.first_name, e.last_name, e.dob, e.join_date,
             d.department_name, des.designation_name
      FROM hcm.employees e
      LEFT JOIN hcm.departments d ON e.department_id = d.id
      LEFT JOIN hcm.designations des ON e.designation_id = des.id
      WHERE e.dob IS NOT NULL AND e.is_active = true AND e.is_deleted = false
      LIMIT 200
    `);

    const today = new Date();
    const currentMonth = today.getMonth(); // 0-indexed
    const currentDay = today.getDate();

    const celebrations = [];

    for (const row of result.rows) {
      if (!row.dob) continue;
      const name = `${row.first_name || ''} ${row.last_name || ''}`.trim();
      const dobDate = new Date(row.dob);
      const dobMonth = dobDate.getUTCMonth();
      const dobDay = dobDate.getUTCDate();

      // Check if birthday falls in upcoming window (next 45 days)
      const thisYearBirthday = new Date(today.getFullYear(), dobMonth, dobDay);
      let diffDays = Math.ceil((thisYearBirthday - today) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) {
        const nextYearBirthday = new Date(today.getFullYear() + 1, dobMonth, dobDay);
        diffDays = Math.ceil((nextYearBirthday - today) / (1000 * 60 * 60 * 24));
      }

      if (diffDays >= 0 && diffDays <= 45) {
        const monthName = dobDate.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
        celebrations.push({
          id: String(row.id),
          name,
          role: row.designation_name || 'Team Member',
          team: row.department_name || 'Engineering',
          birthday: row.dob.toISOString().slice(0, 10),
          dateLabel: diffDays === 0 ? 'Today' : diffDays === 1 ? 'Tomorrow' : `${monthName} ${dobDay}`,
          daysUntil: diffDays,
          initials: name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase(),
          color: COLORS[celebrations.length % COLORS.length],
        });
      }
    }

    celebrations.sort((a, b) => a.daysUntil - b.daysUntil);
    const topCelebrations = celebrations.slice(0, 10);

    await redis.set('hrobit:celebrations', topCelebrations, 300);
    res.json({ success: true, data: topCelebrations });
  } catch (err) {
    next(err);
  }
};

exports.getHRContacts = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, e.official_email, e.personal_email, e.phone,
             e.profile_picture_url, e.employee_type,
             d.department_name, des.designation_name
      FROM hcm.employees e
      LEFT JOIN hcm.departments d ON e.department_id = d.id
      LEFT JOIN hcm.designations des ON e.designation_id = des.id
      WHERE COALESCE(e.is_deleted, false) = false
        AND (
          e.is_active = true
          OR LOWER(COALESCE(e.employee_type, '')) IN ('intern', 'internship')
          OR LOWER(COALESCE(des.designation_name, '')) LIKE '%intern%'
        )
      ORDER BY e.first_name, e.last_name
    `);

    const contacts = result.rows.map((row, idx) => {
      const name = `${row.first_name || ''} ${row.last_name || ''}`.trim();
      const initials = name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
      let focus = 'General employee support, workplace inquiries and HR advisement';
      if (row.designation_name?.toLowerCase().includes('recruitment') || row.department_name?.toLowerCase().includes('recruitment')) {
        focus = 'Talent acquisition, career opportunities and hiring drives';
      } else if (row.designation_name?.toLowerCase().includes('benefit')) {
        focus = 'Health insurance, employee medical allowances and wellness benefits';
      } else if (row.designation_name?.toLowerCase().includes('lead') || row.designation_name?.toLowerCase().includes('manager')) {
        focus = 'People operations, strategic HR guidance and team escalations';
      }

      return {
        id: `hr-${row.id}`,
        db_id: row.id,
        name,
        team: row.department_name || 'People & Culture',
        role: row.designation_name || row.employee_type || 'HR Specialist',
        employmentType: row.employee_type || null,
        focus,
        email: row.official_email || row.personal_email || (row.employee_code ? `${row.employee_code.toLowerCase()}@simplify3x.com` : null),
        phone: row.phone || '+91 80 4000 1200',
        extension: `Ext. ${4000 + (idx * 17) % 900}`,
        location: 'Bengaluru',
        initials,
        color: COLORS[idx % COLORS.length],
        avatar: row.profile_picture_url || null,
        cover: 'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=800&q=85',
      };
    });

    res.json({ success: true, data: contacts });
  } catch (err) {
    next(err);
  }
};
