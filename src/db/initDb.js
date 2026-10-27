require('dotenv').config();
const { pool } = require('../config/db');
const logger = require('../config/logger');

async function initDb() {
  const client = await pool.connect();
  try {
    logger.info('Initializing database tables in schema hcm...');
    await client.query('CREATE SCHEMA IF NOT EXISTS hcm;');

    // 1. Announcements table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hcm.announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        details TEXT,
        category VARCHAR(100) DEFAULT 'Company News',
        priority VARCHAR(50) DEFAULT 'Normal',
        pinned BOOLEAN DEFAULT false,
        read BOOLEAN DEFAULT false,
        image TEXT,
        date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Events table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hcm.events (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        date DATE NOT NULL,
        time VARCHAR(50) NOT NULL,
        venue VARCHAR(255),
        category VARCHAR(100) DEFAULT 'Community',
        rsvp TEXT,
        color VARCHAR(50) DEFAULT 'mint',
        image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Quick Links table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hcm.quick_links (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(100) DEFAULT 'HR',
        url TEXT NOT NULL,
        icon VARCHAR(100) DEFAULT 'Orbit',
        placeholder BOOLEAN DEFAULT false,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Kudos table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hcm.kudos (
        id SERIAL PRIMARY KEY,
        from_name VARCHAR(255) NOT NULL,
        to_name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        initials VARCHAR(10),
        color VARCHAR(50) DEFAULT 'purple',
        date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. Notifications table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hcm.notifications (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER,
        title VARCHAR(255) NOT NULL,
        detail TEXT NOT NULL,
        type VARCHAR(50) DEFAULT 'announcement',
        read BOOLEAN DEFAULT false,
        time VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 6. Learning Courses table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hcm.learning_courses (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        provider VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        level VARCHAR(50) DEFAULT 'Beginner',
        duration VARCHAR(50) DEFAULT 'Self-paced',
        access VARCHAR(100) DEFAULT 'Free',
        certificate VARCHAR(150),
        description TEXT,
        url TEXT,
        image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 7. FAQs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hcm.faqs (
        id SERIAL PRIMARY KEY,
        category VARCHAR(100) NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 8. Games table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hcm.games (
        id VARCHAR(100) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        subtitle TEXT,
        difficulty VARCHAR(50),
        description TEXT,
        icon VARCHAR(100),
        color VARCHAR(50),
        available BOOLEAN DEFAULT true
      );
    `);

    // 9. User profile overrides & preferences table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hcm.user_profiles (
        employee_id INTEGER PRIMARY KEY,
        bio TEXT,
        interests JSONB DEFAULT '[]'::jsonb,
        cover_url TEXT,
        avatar_url TEXT,
        location VARCHAR(100),
        role_title VARCHAR(150),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Check if seeding is needed for announcements
    const countAnnounce = await client.query('SELECT COUNT(*) FROM hcm.announcements');
    if (parseInt(countAnnounce.rows[0].count, 10) === 0) {
      logger.info('Seeding announcements...');
      await client.query(`
        INSERT INTO hcm.announcements (title, description, details, category, priority, pinned, read, image, date)
        VALUES 
        ('October Townhall: Building What Is Next', 
         'Join our monthly all-hands for engineering showcases, product highlights, customer stories and live leadership Q&A.', 
         'This month leadership will unveil our upcoming product initiatives, share updates on platform scale, and celebrate cross-functional team wins.', 
         'Company News', 'High', true, false, 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=800&q=85', CURRENT_DATE - INTERVAL '2 days'),
        ('Annual Benefits Enrollment & Health Perks Open', 
         'Review updated medical plans, wellness allowances, family benefits and flexible health spending for the upcoming year.', 
         'Our updated benefit offerings now include expanded mental health consultations, higher learning stipends, and ergonomic home setup allowances.', 
         'HR Update', 'Normal', true, true, 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=800&q=85', CURRENT_DATE - INTERVAL '5 days'),
        ('Festive Season Holidays & Workplace Schedule', 
         'Planning time with loved ones? Review holiday dates, flexible leave windows and office coverage arrangements.', 
         'Regional offices will observe flexible operating hours during the holiday week. Please coordinate on-call coverage with your managers.', 
         'Holiday', 'Normal', false, false, 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=800&q=85', CURRENT_DATE - INTERVAL '7 days'),
        ('Q4 Learning & Certification Reimbursement', 
         'Upskill your craft. Claim up to $1,500 in approved technical certifications, cloud courses and executive workshops.', 
         'Employees with 6+ months tenure can apply their annual learning stipend toward AWS/Azure, PMP, UI/UX bootcamps, and O’Reilly subscriptions.', 
         'Learning', 'Low', false, true, 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=800&q=85', CURRENT_DATE - INTERVAL '12 days');
      `);
    }

    // Check events
    const countEvents = await client.query('SELECT COUNT(*) FROM hcm.events');
    if (parseInt(countEvents.rows[0].count, 10) === 0) {
      logger.info('Seeding events...');
      await client.query(`
        INSERT INTO hcm.events (title, description, date, time, venue, category, rsvp, color, image)
        VALUES
        ('Coffee & Connect: Cross-Team Mixer', 'A relaxed chance to grab a fresh roast, meet teammates across departments and share what you are exploring.', CURRENT_DATE + INTERVAL '1 day', '11:30 AM', 'Collaboration Lounge & Online', 'Community', 'https://example.com/rsvp-coffee', 'mint', 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=800&q=85'),
        ('Learning Lab: Better Visual Presentations', 'A hands-on workshop on structuring compelling slides, communicating architectural ideas and presenting with clarity.', CURRENT_DATE + INTERVAL '5 days', '3:00 PM', 'Innovation Hub · Room B', 'Learning', 'https://example.com/rsvp-lab', 'purple', 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?auto=format&fit=crop&w=800&q=85'),
        ('Global Townhall: Q4 Milestones & Roadmap', 'Executive roadmap updates, product milestones, quarterly employee recognition and an open leadership Q&A.', CURRENT_DATE + INTERVAL '7 days', '4:00 PM', 'Main Auditorium & Live Stream', 'Company', 'https://example.com/rsvp-townhall', 'blue', 'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=800&q=85'),
        ('Wellbeing Reset: Guided Mindfulness & Stretch', 'A 20-minute guided pause for breathwork, ergonomic stretching and mental recharge in the middle of your workday.', CURRENT_DATE + INTERVAL '12 days', '12:15 PM', 'Wellness Studio & Hybrid', 'Wellbeing', 'https://example.com/rsvp-wellbeing', 'gold', 'https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=800&q=85');
      `);
    }

    // Check quick links
    const countQuickLinks = await client.query('SELECT COUNT(*) FROM hcm.quick_links');
    if (parseInt(countQuickLinks.rows[0].count, 10) === 0) {
      logger.info('Seeding quick links...');
      await client.query(`
        INSERT INTO hcm.quick_links (title, description, category, url, icon, placeholder, sort_order)
        VALUES
        ('HROrbit Portal', 'Your main employee portal', 'HR', '/dashboard', 'Orbit', false, 1),
        ('Leave Management', 'Review and apply for leaves', 'HR', '#placeholder-leave', 'CalendarDays', true, 2),
        ('Reward Store', 'Explore recognition rewards and points', 'Benefits', '#placeholder-rewards', 'Gift', true, 3),
        ('Learning Resources', 'Find your next learning path and courses', 'Learning', '/learning', 'GraduationCap', false, 4),
        ('Company Policies', 'Read approved workplace guidance & handbook', 'HR', '#placeholder-policies', 'BookOpen', true, 5),
        ('Help & Support', 'Quick Connect with dedicated HR partners', 'Support', '/hr-contacts', 'LifeBuoy', false, 6);
      `);
    }

    // Check kudos
    const countKudos = await client.query('SELECT COUNT(*) FROM hcm.kudos');
    if (parseInt(countKudos.rows[0].count, 10) === 0) {
      logger.info('Seeding kudos...');
      await client.query(`
        INSERT INTO hcm.kudos (from_name, to_name, category, message, initials, color, date)
        VALUES
        ('Sowmick Raj Sarmah', 'B Kavya', 'Ownership', 'Exceptional work on finalizing the HROrbit portal interface design. High attention to detail!', 'SR', 'mint', CURRENT_DATE - INTERVAL '1 day'),
        ('B Kavya', 'Urmila Mercy Manjunath', 'Teamwork', 'Thank you for streamlining our onboarding resources and supporting the new engineering batch.', 'BK', 'blue', CURRENT_DATE - INTERVAL '3 days'),
        ('Archana M', 'Chethan Kumar', 'Curiosity', 'Great collaboration on organizing the tech hiring drive this week.', 'AM', 'purple', CURRENT_DATE - INTERVAL '5 days');
      `);
    }

    // Check notifications
    const countNotifications = await client.query('SELECT COUNT(*) FROM hcm.notifications');
    if (parseInt(countNotifications.rows[0].count, 10) === 0) {
      logger.info('Seeding notifications...');
      await client.query(`
        INSERT INTO hcm.notifications (title, detail, type, read, time)
        VALUES
        ('New announcement', 'October Townhall: Building What Is Next', 'announcement', false, 'Today · 9:15 AM'),
        ('Upcoming event', 'Coffee & Connect: Cross-Team Mixer tomorrow', 'event', false, 'Yesterday'),
        ('A little appreciation', 'You received a Kudos from Sowmick Raj Sarmah', 'kudos', true, '2 days ago');
      `);
    }

    // Check learning courses
    const countCourses = await client.query('SELECT COUNT(*) FROM hcm.learning_courses');
    if (parseInt(countCourses.rows[0].count, 10) === 0) {
      logger.info('Seeding learning courses...');
      await client.query(`
        INSERT INTO hcm.learning_courses (title, provider, category, level, duration, access, certificate, description, url, image)
        VALUES
        ('Java Programming Fundamentals', 'GeeksforGeeks', 'Java & OOP', 'Beginner', 'Self-paced', 'Free resources', 'Available upon completion', 'Practice Java fundamentals, object-oriented programming architecture and scalable coding patterns.', 'https://www.geeksforgeeks.org/java/', 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?auto=format&fit=crop&w=800&q=85'),
        ('Data Structures and Algorithms', 'freeCodeCamp', 'DSA', 'Intermediate', 'Self-paced', 'Free', 'Verified certification', 'Build robust problem-solving skills with graph traversal, dynamic programming and algorithm optimization.', 'https://www.freecodecamp.org/learn/', 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=800&q=85'),
        ('Modern React & Component Design', 'React.dev', 'Web Development', 'Beginner', 'Self-paced', 'Free', 'Official curriculum', 'Master modern React patterns, custom hooks, state synchronization and design system component composition.', 'https://react.dev/learn', 'https://images.unsplash.com/photo-1633356122544-f134324a6cee?auto=format&fit=crop&w=800&q=85'),
        ('Microsoft Azure Cloud & DevOps', 'Microsoft Learn', 'Cloud & DevOps', 'Beginner', 'Self-paced', 'Free learning paths', 'Microsoft Exam available', 'Browse guided hands-on labs for Azure cloud compute, container orchestration and zero-trust security.', 'https://learn.microsoft.com/training/', 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=800&q=85'),
        ('Computer Science Core Specialization', 'NPTEL', 'Computer Science', 'Intermediate', '8 weeks', 'Free content', 'University accredited', 'Explore university-led advanced systems design, operating systems concurrency and distributed compute.', 'https://nptel.ac.in/', 'https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=800&q=85'),
        ('Relational Database Architecture & SQL', 'GeeksforGeeks', 'Databases', 'Beginner', 'Self-paced', 'Free resources', 'Included', 'Learn SQL querying, complex window functions, index optimization and relational database modeling.', 'https://www.geeksforgeeks.org/sql-tutorial/', 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=800&q=85'),
        ('Scientific Computing with Python', 'freeCodeCamp', 'Python', 'Beginner', 'Self-paced', 'Free', 'Certification included', 'Master Python data pipelines, automation scripting and scientific numerical computation exercises.', 'https://www.freecodecamp.org/learn/scientific-computing-with-python/', 'https://images.unsplash.com/photo-1526379095098-d400fd0bf935?auto=format&fit=crop&w=800&q=85'),
        ('High-Impact Communication & Leadership', 'Coursera', 'Career Skills', 'Beginner', '4 weeks', 'Sponsored access', 'Professional Certificate', 'Develop executive presentation presence, cross-functional stakeholder storytelling and team facilitation.', 'https://www.coursera.org/courses', 'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=800&q=85');
      `);
    }

    // Check FAQs
    const countFaqs = await client.query('SELECT COUNT(*) FROM hcm.faqs');
    if (parseInt(countFaqs.rows[0].count, 10) === 0) {
      logger.info('Seeding FAQs...');
      await client.query(`
        INSERT INTO hcm.faqs (category, question, answer)
        VALUES
        ('Onboarding', 'How do I get started as a new employee?', 'Review your welcome email and the People Operations guide. Reach out through Quick Connect if you have questions regarding your laptop setup or credentials.'),
        ('Leave & Attendance', 'Where can I review leave balance and apply?', 'Access Leave Management from Quick Links to view your current annual leave, sick leave, and casual leave balances or submit a request.'),
        ('Working Hours', 'What are the company standard working hours?', 'Standard working hours are typically 9:30 AM to 6:30 PM (Monday through Friday), subject to shift requirements and manager agreement.'),
        ('Payroll', 'Where can I access my monthly payslips?', 'Payslips are generated and accessible via the HROrbit employee self-service system under Document Center by the 1st of every month.'),
        ('Documents', 'How can I request an employment verification letter?', 'Submit a request to People Operations through Quick Connect or email HR directly with your required letter template.'),
        ('Policies', 'Where can I read our corporate policies?', 'All verified company policies including leave rules, travel allowances, and IT security are listed in Company Policies.');
      `);
    }

    // Check games
    const countGames = await client.query('SELECT COUNT(*) FROM hcm.games');
    if (parseInt(countGames.rows[0].count, 10) === 0) {
      logger.info('Seeding games...');
      await client.query(`
        INSERT INTO hcm.games (id, title, subtitle, difficulty, description, icon, color, available)
        VALUES
        ('word-connections', 'Word Connections', 'Find the shared idea', 'Easy', 'Choose the clue that best connects four words. Each round is short and designed for a mindful break.', 'Lightbulb', 'purple', true),
        ('orbit-grid', 'Orbit Grid', 'A little logic goes a long way', 'Medium', 'Place one star in every row and column without using a cell twice. A small grid, a big brain stretch.', 'Grid2X2', 'mint', true),
        ('quick-puzzle', 'Quick Puzzle', 'Solve the missing number', 'Easy', 'Find the number that completes each short pattern.', 'Sparkles', 'gold', true);
      `);
    }

    // Keep existing installations in sync with the currently playable games.
    await client.query(`
      DELETE FROM hcm.games
      WHERE id = 'word-ladder'
        AND EXISTS (SELECT 1 FROM hcm.games WHERE id = 'quick-puzzle');

      UPDATE hcm.games
      SET id = 'quick-puzzle',
          title = 'Quick Puzzle',
          subtitle = 'Solve the missing number',
          difficulty = 'Easy',
          description = 'Find the number that completes each short pattern.',
          icon = 'Sparkles',
          color = 'gold',
          available = true
      WHERE id = 'word-ladder';

      INSERT INTO hcm.games (id, title, subtitle, difficulty, description, icon, color, available)
      SELECT 'quick-puzzle', 'Quick Puzzle', 'Solve the missing number', 'Easy',
             'Find the number that completes each short pattern.', 'Sparkles', 'gold', true
      WHERE NOT EXISTS (SELECT 1 FROM hcm.games WHERE id = 'quick-puzzle');
    `);

    logger.info('Database initialization & seeding completed successfully.');
  } catch (err) {
    logger.error('Failed to initialize database tables: ' + err.message, err);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  require('dotenv').config();
  initDb().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = initDb;
