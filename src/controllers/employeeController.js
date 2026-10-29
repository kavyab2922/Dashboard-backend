const { query } = require('../config/db');
const redis = require('../config/redis');
const logger = require('../config/logger');

const COLORS = ['blue', 'purple', 'mint', 'gold', 'rose', 'slate'];

function dateOnly(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Fetch all active employees.
exports.getEmployees = async (req, res, next) => {
  try {
    // Use a new cache key to avoid serving outdated employee records.
    const cached = await redis.get('hrobit:employees:list:v4');

    if (cached) {
      return res.json({
        success: true,
        data: JSON.parse(cached),
      });
    }

    const result = await query(`
      SELECT
        e.id,
        e.employee_code,
        e.first_name,
        e.last_name,
        e.official_email,
        e.dob,
        e.join_date,
        e.profile_picture_url,
        d.department_name,
        des.designation_name
      FROM hcm.employees e
      LEFT JOIN hcm.departments d
        ON e.department_id = d.id
      LEFT JOIN hcm.designations des
        ON e.designation_id = des.id
      WHERE e.is_active = true
        AND e.is_deleted = false
      ORDER BY e.first_name, e.last_name
    `);

    const employees = result.rows.map((row, index) => {
      const name =
        `${row.first_name || ''} ${row.last_name || ''}`.trim() ||
        'Team Member';

      const initials = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase();

      return {
        id: String(row.id),
        employee_code: row.employee_code,
        name,
        role: row.designation_name || 'Software Specialist',
        team: row.department_name || 'Engineering',
        email:
          row.official_email ||
          `${row.employee_code?.toLowerCase() || 'member'}@simplify3x.com`,
        location: 'Bengaluru',

        // Return actual DOB; never substitute a fake date.
        dob: dateOnly(row.dob),
        birthday: dateOnly(row.dob),

        joined: row.join_date
          ? dateOnly(row.join_date, '2025-01-01')
          : '2025-01-01',

        initials,
        color: COLORS[index % COLORS.length],
        avatar: row.profile_picture_url || null,
      };
    });

    await redis.set('hrobit:employees:list:v4', employees, 300);

    return res.json({
      success: true,
      data: employees,
    });
  } catch (err) {
    return next(err);
  }
};

// Fetch employees whose birthdays match the requested month and day.
exports.getTodaysBirthdays = async (req, res, next) => {
  try {
    const month = Number(req.query.month);
    const day = Number(req.query.day);
    const viewerId = Number(req.user?.id);

    if (
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      !Number.isInteger(day) ||
      day < 1 ||
      day > 31
    ) {
      return res.status(400).json({
        success: false,
        message: 'Valid month and day are required.',
      });
    }

    const result = await query(
      `
        SELECT
          e.id,
          e.first_name,
          e.last_name,
          e.dob::date::text AS dob,
          d.department_name,
          des.designation_name,
          COALESCE(e.profile_picture_url, p.avatar_url) AS profile_picture_url,
          COALESCE(br.read, false) AS read
        FROM hcm.employees e
        LEFT JOIN hcm.departments d
          ON e.department_id = d.id
        LEFT JOIN hcm.designations des
          ON e.designation_id = des.id
        LEFT JOIN hcm.user_profiles p
          ON e.id = p.employee_id
        LEFT JOIN hcm.birthday_notification_reads br
          ON br.viewer_employee_id = $3
         AND br.birthday_employee_id = e.id
         AND br.birthday_date = CURRENT_DATE
        WHERE e.dob IS NOT NULL
          AND e.is_active = true
          AND COALESCE(e.is_deleted, false) = false
          AND EXTRACT(MONTH FROM e.dob) = $1
          AND EXTRACT(DAY FROM e.dob) = $2
        ORDER BY e.first_name, e.last_name
      `,
      [month, day, Number.isInteger(viewerId) ? viewerId : null]
    );

    const birthdays = result.rows.map((row, index) => {
      const name =
        `${row.first_name || ''} ${row.last_name || ''}`.trim() ||
        'Employee';

      return {
        id: String(row.id),
        name,
        dob: dateOnly(row.dob),
        birthday: dateOnly(row.dob),
        role: row.designation_name || 'Team Member',
        team: row.department_name || 'Team',

        initials: name
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0])
          .join('')
          .toUpperCase(),

        color: COLORS[index % COLORS.length],
        avatar: row.profile_picture_url || null,
        profile_picture_url: row.profile_picture_url || null,
        notificationId: `birthday-${dateOnly(new Date())}-${String(row.id)}`,
        read: Boolean(row.read),
      };
    });

    return res.json({
      success: true,
      data: birthdays,
    });
  } catch (err) {
    return next(err);
  }
};

// Mark one of today's birthday notifications as read for the signed-in employee.
exports.markBirthdayRead = async (req, res, next) => {
  try {
    const viewerId = Number(req.user?.id);
    const birthdayEmployeeId = Number(req.params.employeeId);
    if (!Number.isInteger(viewerId) || !Number.isInteger(birthdayEmployeeId)) {
      return res.status(400).json({ success: false, message: 'Valid employee IDs are required.' });
    }

    const result = await query(
      `
        INSERT INTO hcm.birthday_notification_reads
          (viewer_employee_id, birthday_employee_id, birthday_date, read, read_at, updated_at)
        SELECT $1, e.id, CURRENT_DATE, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM hcm.employees e
        WHERE e.id = $2
          AND e.dob IS NOT NULL
          AND e.is_active = true
          AND COALESCE(e.is_deleted, false) = false
          AND EXTRACT(MONTH FROM e.dob) = EXTRACT(MONTH FROM CURRENT_DATE)
          AND EXTRACT(DAY FROM e.dob) = EXTRACT(DAY FROM CURRENT_DATE)
        ON CONFLICT (viewer_employee_id, birthday_employee_id, birthday_date)
        DO UPDATE SET read = true, read_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        RETURNING birthday_employee_id
      `,
      [viewerId, birthdayEmployeeId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: 'Today\'s birthday notification was not found.' });
    }
    return res.json({ success: true, data: { employeeId: String(birthdayEmployeeId), read: true } });
  } catch (err) {
    return next(err);
  }
};

exports.markAllBirthdaysRead = async (req, res, next) => {
  try {
    const viewerId = Number(req.user?.id);
    const birthdayEmployeeIds = Array.isArray(req.body?.employeeIds)
      ? req.body.employeeIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id))
      : [];

    if (!Number.isInteger(viewerId)) {
      return res.status(400).json({ success: false, message: 'Valid viewer employee ID is required.' });
    }
    if (!birthdayEmployeeIds.length) {
      return res.json({ success: true, data: { updated: 0 } });
    }

    await query(
      `
        INSERT INTO hcm.birthday_notification_reads
          (viewer_employee_id, birthday_employee_id, birthday_date, read, read_at, updated_at)
        SELECT $1, e.id, CURRENT_DATE, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM hcm.employees e
        WHERE e.id = ANY($2::int[])
          AND e.dob IS NOT NULL
          AND e.is_active = true
          AND COALESCE(e.is_deleted, false) = false
          AND EXTRACT(MONTH FROM e.dob) = EXTRACT(MONTH FROM CURRENT_DATE)
          AND EXTRACT(DAY FROM e.dob) = EXTRACT(DAY FROM CURRENT_DATE)
        ON CONFLICT (viewer_employee_id, birthday_employee_id, birthday_date)
        DO UPDATE SET read = true, read_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      `,
      [viewerId, birthdayEmployeeIds]
    );
    return res.json({ success: true, data: { updated: birthdayEmployeeIds.length } });
  } catch (err) {
    return next(err);
  }
};

// Update an employee profile.
exports.updateProfile = async (req, res, next) => {
  try {
    const userId = req.user?.id || 15002;

    const {
      bio,
      location,
      roleTitle,
      interests,
      coverUrl,
      avatarUrl,
    } = req.body;

    await query(
      `
        INSERT INTO hcm.user_profiles (
          employee_id,
          bio,
          location,
          role_title,
          interests,
          cover_url,
          avatar_url,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        ON CONFLICT (employee_id) DO UPDATE SET
          bio = COALESCE(EXCLUDED.bio, hcm.user_profiles.bio),
          location = COALESCE(EXCLUDED.location, hcm.user_profiles.location),
          role_title = COALESCE(EXCLUDED.role_title, hcm.user_profiles.role_title),
          interests = COALESCE(EXCLUDED.interests, hcm.user_profiles.interests),
          cover_url = COALESCE(EXCLUDED.cover_url, hcm.user_profiles.cover_url),
          avatar_url = COALESCE(EXCLUDED.avatar_url, hcm.user_profiles.avatar_url),
          updated_at = CURRENT_TIMESTAMP
      `,
      [
        userId,
        bio,
        location,
        roleTitle,
        JSON.stringify(interests || []),
        coverUrl,
        avatarUrl,
      ]
    );

    await redis.del('hrobit:employees:list:v4');
    await redis.del('hrobit:employees:list:v3');
    await redis.del('hrobit:employees:list');

    return res.json({
      success: true,
      message: 'Profile updated successfully',
    });
  } catch (err) {
    return next(err);
  }
};

// Fetch upcoming birthdays and work anniversaries.
exports.getCelebrations = async (req, res, next) => {
  try {
    const cached = await redis.get('hrobit:celebrations');

    if (cached) {
      return res.json({
        success: true,
        data: JSON.parse(cached),
      });
    }

    const result = await query(`
      SELECT
        e.id,
        e.first_name,
        e.last_name,
        e.dob,
        e.join_date,
        d.department_name,
        des.designation_name
      FROM hcm.employees e
      LEFT JOIN hcm.departments d
        ON e.department_id = d.id
      LEFT JOIN hcm.designations des
        ON e.designation_id = des.id
      WHERE e.dob IS NOT NULL
        AND e.is_active = true
        AND e.is_deleted = false
      LIMIT 200
    `);

    const today = new Date();
    const celebrations = [];

    for (const row of result.rows) {
      if (!row.dob) continue;

      const name =
        `${row.first_name || ''} ${row.last_name || ''}`.trim();

      const dobText = dateOnly(row.dob);
      if (!dobText) continue;

      const [, monthText, dayText] =
        dobText.match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];

      if (!monthText || !dayText) continue;

      const dobMonth = Number(monthText) - 1;
      const dobDay = Number(dayText);

      const todayStart = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      );

      let nextBirthday = new Date(
        today.getFullYear(),
        dobMonth,
        dobDay
      );

      if (nextBirthday < todayStart) {
        nextBirthday = new Date(
          today.getFullYear() + 1,
          dobMonth,
          dobDay
        );
      }

      const diffDays = Math.round(
        (nextBirthday - todayStart) / (1000 * 60 * 60 * 24)
      );

      if (diffDays >= 0 && diffDays <= 45) {
        const monthName = nextBirthday.toLocaleString('en-US', {
          month: 'short',
        });

        celebrations.push({
          id: String(row.id),
          name,
          role: row.designation_name || 'Team Member',
          team: row.department_name || 'Engineering',
          birthday: dobText,
          dateLabel:
            diffDays === 0
              ? 'Today'
              : diffDays === 1
                ? 'Tomorrow'
                : `${monthName} ${dobDay}`,
          daysUntil: diffDays,
          initials: name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0])
            .join('')
            .toUpperCase(),
          color: COLORS[celebrations.length % COLORS.length],
        });
      }
    }

    celebrations.sort((a, b) => a.daysUntil - b.daysUntil);

    const topCelebrations = celebrations.slice(0, 10);

    await redis.set('hrobit:celebrations', topCelebrations, 300);

    return res.json({
      success: true,
      data: topCelebrations,
    });
  } catch (err) {
    return next(err);
  }
};

// Fetch employee contacts.
exports.getHRContacts = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT
        e.id,
        e.employee_code,
        e.first_name,
        e.last_name,
        e.official_email,
        e.phone,
        d.department_name,
        des.designation_name,
        e.profile_picture_url
      FROM hcm.employees e
      LEFT JOIN hcm.departments d
        ON e.department_id = d.id
      LEFT JOIN hcm.designations des
        ON e.designation_id = des.id
      WHERE e.is_active = true
        AND COALESCE(e.is_deleted, false) = false
      ORDER BY e.first_name, e.last_name
    `);

    const contacts = result.rows.map((row, index) => {
      const name =
        `${row.first_name || ''} ${row.last_name || ''}`.trim();

      const initials = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase();

      let focus =
        'General employee support, workplace inquiries and HR advisement';

      if (
        row.designation_name?.toLowerCase().includes('recruitment') ||
        row.department_name?.toLowerCase().includes('recruitment')
      ) {
        focus =
          'Talent acquisition, career opportunities and hiring drives';
      } else if (
        row.designation_name?.toLowerCase().includes('benefit')
      ) {
        focus =
          'Health insurance, employee medical allowances and wellness benefits';
      } else if (
        row.designation_name?.toLowerCase().includes('lead') ||
        row.designation_name?.toLowerCase().includes('manager')
      ) {
        focus =
          'People operations, strategic HR guidance and team escalations';
      }

      return {
        id: `hr-${row.id}`,
        db_id: row.id,
        name,
        team: row.department_name || 'People & Culture',
        role: row.designation_name || 'HR Specialist',
        focus,
        email:
          row.official_email ||
          `${row.employee_code?.toLowerCase() || 'hr'}@simplify3x.com`,
        phone: row.phone || '+91 80 4000 1200',
        extension: `Ext. ${4000 + (index * 17) % 900}`,
        location: 'Bengaluru',
        initials,
        color: COLORS[index % COLORS.length],
        avatar: row.profile_picture_url || null,
        cover:
          'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=800&q=85',
      };
    });

    return res.json({
      success: true,
      data: contacts,
    });
  } catch (err) {
    return next(err);
  }
};