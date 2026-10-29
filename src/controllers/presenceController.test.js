const test = require('node:test');
const assert = require('node:assert/strict');
const { toStatus, getPresence, heartbeat, teamsAccountEmail } = require('./presenceController');

test('plus-alias directory emails map to the plain Teams account', () => {
  assert.equal(teamsAccountEmail('karthik.m+1@simplify3x.com'), 'karthik.m@simplify3x.com');
  assert.equal(teamsAccountEmail('aswani.m+tes0001@simplify3x.com'), 'aswani.m@simplify3x.com');
  assert.equal(teamsAccountEmail('ganesh.r@simplify3x.com'), 'ganesh.r@simplify3x.com');
});

test('available Teams users are online (green)', () => {
  assert.deepEqual(toStatus({ availability: 'Available', activity: 'Available' }), { status: 'online', label: 'Available' });
  assert.equal(toStatus({ availability: 'AvailableIdle', activity: 'Available' }).status, 'online');
});

test('calls, meetings and do-not-disturb are busy (red)', () => {
  assert.deepEqual(toStatus({ availability: 'Busy', activity: 'InACall' }), { status: 'busy', label: 'In a call' });
  assert.deepEqual(toStatus({ availability: 'Busy', activity: 'InAMeeting' }), { status: 'busy', label: 'In a meeting' });
  assert.deepEqual(toStatus({ availability: 'DoNotDisturb', activity: 'Presenting' }), { status: 'busy', label: 'Presenting' });
  assert.deepEqual(toStatus({ availability: 'Busy', activity: 'Busy' }), { status: 'busy', label: 'Busy' });
});

test('away, offline and unknown are offline (light brown)', () => {
  assert.deepEqual(toStatus({ availability: 'Away', activity: 'Away' }), { status: 'offline', label: 'Away' });
  assert.deepEqual(toStatus({ availability: 'BeRightBack', activity: 'BeRightBack' }), { status: 'offline', label: 'Be right back' });
  assert.deepEqual(toStatus({ availability: 'Offline', activity: 'OffWork' }), { status: 'offline', label: 'Off work' });
  assert.deepEqual(toStatus({ availability: 'PresenceUnknown', activity: 'PresenceUnknown' }), { status: 'offline', label: 'Offline' });
});

const lookup = async (viewer, emails) => {
  let body;
  await getPresence({ user: { email: viewer }, body: { emails } }, { json(payload) { body = payload; } });
  return body;
};

test('without Teams, people active in HR Orbit are online and others offline', async () => {
  heartbeat({ user: { email: 'Active@Simplify3x.com' } }, { json() {} });
  const body = await lookup('viewer@simplify3x.com', ['active@simplify3x.com', 'away@simplify3x.com']);
  assert.equal(body.teamsConfigured, false);
  assert.equal(body.data['active@simplify3x.com'].status, 'online');
  assert.equal(body.data['away@simplify3x.com'].status, 'offline');
});

test('malformed directory emails are skipped instead of failing the lookup', async () => {
  const body = await lookup('viewer@simplify3x.com', ['good@simplify3x.com', 'arshit@g,ail.dsdscom', '[object object]']);
  assert.deepEqual(Object.keys(body.data), ['good@simplify3x.com']);
  assert.equal(body.data['good@simplify3x.com'].status, 'offline');
});

test('the person viewing the page counts as active', async () => {
  const body = await lookup('Me@Simplify3x.com', ['me@simplify3x.com']);
  assert.equal(body.data['me@simplify3x.com'].status, 'online');
});
