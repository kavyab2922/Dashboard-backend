const { query } = require('../config/db');

const logger = require('../config/logger');
const { isGrantedHrAdmin } = require('../middleware/auth');

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function birthDate(user) {
  if (!user || typeof user !== 'object') return null;

  for (const [key, value] of Object.entries(user)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if ((normalizedKey === 'dob' || normalizedKey.includes('dateofbirth') || normalizedKey.includes('birthdate') || normalizedKey.includes('birth') || normalizedKey.includes('dob')) && value) {
      const normalizedValue = dateOnly(value);
      if (normalizedValue) return normalizedValue;
    }
  }

  for (const value of Object.values(user)) {
    if (value && typeof value === 'object') {
      const nested = birthDate(value);
      if (nested) return nested;
    }
  }
  return null;
}

function joiningDate(user) {
  if (!user || typeof user !== 'object') return null;

  const dateKeys = ['doj', 'joindate', 'joiningdate', 'dateofjoin', 'dateofjoining', 'datejoined', 'onboardingdate', 'hiredate', 'employmentstartdate', 'startdate'];
  for (const [key, value] of Object.entries(user)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (value && dateKeys.some((dateKey) => normalizedKey === dateKey || normalizedKey.includes(dateKey))) {
      const normalizedValue = dateOnly(value);
      if (normalizedValue) return normalizedValue;
    }
  }

  for (const value of Object.values(user)) {
    if (value && typeof value === 'object') {
      const nested = joiningDate(value);
      if (nested) return nested;
    }
  }
  return null;
}

function locationValue(user) {
  if (!user || typeof user !== 'object') return null;
  const locationKeys = ['location', 'workLocation', 'work_location', 'officeLocation', 'office_location', 'locationName', 'location_name', 'city'];
  for (const key of locationKeys) {
    if (typeof user[key] === 'string' && user[key].trim()) return user[key].trim();
  }
  for (const value of Object.values(user)) {
    if (value && typeof value === 'object') {
      const nested = locationValue(value);
      if (nested) return nested;
    }
  }
  return null;
}

function normalizeAssetUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    if (url.includes('.s3.') && url.includes('amazonaws.com')) {
      const parsed = new URL(url);
      const pathname = parsed.pathname.replace(/^\/+/, '');
      const filename = pathname.startsWith('uploads/') ? pathname.slice('uploads/'.length) : pathname;
      return `/uploads/${filename}`;
    }
  } catch {
    // ignore
  }
  return url;
}

function profileFields(user) {
  const rawRole = [user?.role, user?.userRole, user?.profile, user?.title].find((value) => typeof value === 'string' && value.trim());
  const roleParts = rawRole?.split(/\s*[·|]\s*/).map((part) => part.trim()).filter(Boolean) || [];
  const explicitType = user?.employmentType || user?.employment_type || user?.employeeType || user?.employee_type || user?.workerType || user?.worker_type || user?.userType || user?.user_type || user?.employmentCategory || user?.employment_category || user?.contractType || user?.contract_type;
  const explicitTitle = user?.designation || user?.designationName || user?.designation_name || user?.jobTitle || user?.job_title || user?.position || user?.positionTitle || user?.roleTitle;
  const compoundTitle = roleParts.slice(1).join(' · ');
  return {
    employmentType: explicitType || roleParts[0] || null,
    jobTitle: compoundTitle || explicitTitle || (rawRole && !/^(employee|hr admin)$/i.test(rawRole) ? rawRole : null),
  };
}

// Builds the session user (the JWT payload) for a signed-in employee. `claims`
// are the verified ID-token claims when the sign-in came through Microsoft SSO.
async function buildSessionUser(email, claims = {}) {
  const userIdentifier = String(email || '').trim().toLowerCase();
  const result = await query(
    `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.official_email, e.personal_email,
            e.dob::date AS dob, e.join_date::date AS join_date,
            to_jsonb(e) AS employee_data,
            d.department_name, des.designation_name, o.organization_name, e.organization_id
     FROM hcm.employees e
     LEFT JOIN hcm.departments d ON e.department_id = d.id
     LEFT JOIN hcm.designations des ON e.designation_id = des.id
     LEFT JOIN hcm.organizations o ON e.organization_id = o.id
     WHERE LOWER(e.official_email) = $1
     LIMIT 1`,
    [userIdentifier]
  );

  const isGrantedAdmin = isGrantedHrAdmin(userIdentifier);
  const isSrinagaraj = userIdentifier.includes('srinagaraj.p@simplify3x.com') || userIdentifier.includes('srinagaraj');
  const resolvedEmploymentType = isSrinagaraj ? 'Intern' : 'Employee';
  const resolvedJobTitle = isSrinagaraj ? 'Software Engineer (Intern)' : (claims.jobTitle || 'Employee');

  if (result.rows.length > 0) {
    const row = result.rows[0];
    const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || claims.name || 'Employee';
    return {
      id: row.id,
      employee_code: row.employee_code,
      name,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.official_email || row.personal_email,
      official_email: row.official_email,
      department: row.department_name || 'General',
      designation: resolvedJobTitle !== 'Employee' ? resolvedJobTitle : (row.designation_name || 'Associate'),
      jobTitle: resolvedJobTitle !== 'Employee' ? resolvedJobTitle : (row.designation_name || 'Associate'),
      organization_name: row.organization_name,
      organization_id: row.organization_id,
      dob: dateOnly(row.dob) || birthDate(row.employee_data),
      birthday: dateOnly(row.dob) || birthDate(row.employee_data),
      joined: dateOnly(row.join_date) || joiningDate(row.employee_data),
      employmentType: resolvedEmploymentType,
      employmentStatus: null,
      role: isGrantedAdmin ? 'HR Admin' : 'Employee',
      access_role: isGrantedAdmin ? 'HR Admin' : 'Employee',
    };
  }

  // Microsoft can verify an employee before the local profile has been
  // provisioned in the reporting database.
  const fallbackName = claims.name || userIdentifier.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  return {
    id: `keycloak:${userIdentifier}`,
    employee_code: userIdentifier,
    name: fallbackName,
    first_name: claims.given_name,
    last_name: claims.family_name,
    email: userIdentifier,
    official_email: userIdentifier,
    role: isGrantedAdmin ? 'HR Admin' : 'Employee',
    access_role: isGrantedAdmin ? 'HR Admin' : 'Employee',
    department: 'General',
    designation: resolvedJobTitle,
    jobTitle: resolvedJobTitle,
    employmentType: resolvedEmploymentType,
    employmentStatus: null,
    dob: isSrinagaraj ? '2006-03-13' : null,
    birthday: isSrinagaraj ? '2006-03-13' : null,
    joined: null,
    team: 'General',
  };
}

exports.buildSessionUser = buildSessionUser;

exports.getMe = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.user?.employee_id || req.user?.employeeId || null;
    const identity = String(req.user?.email || req.user?.official_email || req.user?.employee_code || req.user?.employeeCode || req.user?.name || userId || '').trim().toLowerCase();
    if (!userId && !identity) {
      return res.status(401).json({ success: false, message: 'Authenticated employee is missing' });
    }
    const isGrantedAdmin = isGrantedHrAdmin(identity);
    const isSyntheticUser = String(userId).startsWith('keycloak:');
    const result = await query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.official_email, e.personal_email,
              e.phone, e.dob::date AS dob, e.join_date::date AS join_date, e.profile_picture_url,
              to_jsonb(e) AS employee_data,
              d.department_name, des.designation_name, o.organization_name,
              p.bio, p.interests, p.cover_url, p.avatar_url, p.location AS custom_location, p.role_title AS custom_role
       FROM hcm.employees e
       LEFT JOIN hcm.departments d ON e.department_id = d.id
       LEFT JOIN hcm.designations des ON e.designation_id = des.id
       LEFT JOIN hcm.organizations o ON e.organization_id = o.id
       LEFT JOIN hcm.user_profiles p ON e.id = p.employee_id
       WHERE ($1::text !~ '^keycloak:' AND e.id::text = $1)
          OR LOWER(e.official_email) = $2
          OR LOWER(e.personal_email) = $2
          OR LOWER(e.employee_code) = LOWER($3)
       LIMIT 1`,
      [String(userId), identity, String(req.user?.employee_code || '')]
    );

    if (result.rows.length === 0) {
      // Keep authenticated users signed in while their local profile is being
      // provisioned, but still normalize the profile from the HROrbit identity.
      const identity = String(req.user?.email || req.user?.official_email || req.user?.name || userId).toLowerCase();
      const profile = profileFields(req.user);
      const isSrinagaraj = identity.includes('srinagaraj.p@simplify3x.com') || identity.includes('srinagaraj');
      return res.json({
        success: true,
        user: {
          id: req.user?.id,
          employee_code: req.user?.employee_code || req.user?.employeeCode || req.user?.employee_id || req.user?.employeeId,
          name: req.user?.name,
          first_name: req.user?.first_name,
          last_name: req.user?.last_name,
          email: req.user?.email || req.user?.official_email,
          official_email: req.user?.official_email,
          dob: birthDate(req.user) || (isSrinagaraj ? '2006-03-13' : null),
          birthday: birthDate(req.user) || (isSrinagaraj ? '2006-03-13' : null),
          joined: req.user?.joined || req.user?.join_date || req.user?.joiningDate || joiningDate(req.user) || null,
          location: req.user?.location || locationValue(req.user) || null,
          team: req.user?.team || req.user?.department || 'General',
          role: isGrantedAdmin ? 'HR Admin' : 'Employee',
          access_role: isGrantedAdmin ? 'HR Admin' : 'Employee',
          employmentType: isSrinagaraj ? 'Intern' : (profile.employmentType || 'Employee'),
          jobTitle: isSrinagaraj ? 'Software Engineer (Intern)' : (profile.jobTitle || 'Employee'),
          designation: isSrinagaraj ? 'Software Engineer (Intern)' : (profile.jobTitle || 'Employee'),
          department: req.user?.department || 'General',
          avatar: normalizeAssetUrl(req.user?.avatar || req.user?.avatar_url || req.user?.profile_picture_url || req.user?.profilePictureUrl || req.user?.profilePicture || req.user?.photoUrl || req.user?.photo || null),
          cover: normalizeAssetUrl(req.user?.cover || req.user?.cover_url || req.user?.coverUrl || null),
        },
      });
    }

    const row = result.rows[0];
    const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Employee';
    const initials = name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
    const isSrinagaraj = identity.includes('srinagaraj.p@simplify3x.com') || identity.includes('srinagaraj');

    const user = {
      id: row.id,
      employee_code: row.employee_code,
      name,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.official_email || row.personal_email,
      official_email: row.official_email,
      personal_email: row.personal_email,
      phone: row.phone || '+91 80507 69822',
      dob: dateOnly(row.dob) || birthDate(row.employee_data) || birthDate(req.user) || (isSrinagaraj ? '2006-03-13' : null),
      birthday: dateOnly(row.dob) || birthDate(row.employee_data) || birthDate(req.user) || (isSrinagaraj ? '2006-03-13' : null),
      joined: dateOnly(row.join_date) || joiningDate(row.employee_data) || req.user?.joined || req.user?.join_date || req.user?.joiningDate || req.user?.joining_date || joiningDate(req.user) || null,
      role: isGrantedAdmin ? 'HR Admin' : 'Employee',
      access_role: isGrantedAdmin ? 'HR Admin' : 'Employee',
      jobTitle: isSrinagaraj ? 'Software Engineer (Intern)' : (req.user?.jobTitle || req.user?.job_title || req.user?.designation || req.user?.designationName || req.user?.designation_name || row.custom_role || row.designation_name || 'Employee'),
      designation: isSrinagaraj ? 'Software Engineer (Intern)' : (req.user?.designation || req.user?.designationName || req.user?.designation_name || row.designation_name || null),
      employmentType: isSrinagaraj ? 'Intern' : (req.user?.employmentType || req.user?.employment_type || req.user?.employeeType || req.user?.employee_type || req.user?.workerType || req.user?.worker_type || 'Employee'),
      employmentStatus: req.user?.employmentStatus || req.user?.employment_status || req.user?.employeeStatus || req.user?.employee_status || null,
      team: row.department_name || 'Development',
      organization: row.organization_name || 'Simplify3x',
      location: row.custom_location || 'Bengaluru, India',
      bio: row.bio || 'Passionate about crafting intuitive, scalable enterprise interfaces and high-performance applications.',
      interests: row.interests || ['Design Systems', 'React & TypeScript', 'PostgreSQL', 'User Experience', 'Cloud'],
      initials,
      color: 'blue',
      avatar: normalizeAssetUrl(row.avatar_url || row.profile_picture_url) || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&h=400&q=85',
      cover: normalizeAssetUrl(row.cover_url) || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&h=400&q=85',
    };

    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
};
