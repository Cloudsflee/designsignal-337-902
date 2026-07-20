import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
const studyProfileCompose = await readFile(new URL('../compose.study-profile.yaml', import.meta.url), 'utf8');
const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf8');

function serviceBlock(name, nextSection) {
  const end = nextSection ? `(?=^  ${nextSection}:)` : '(?=^volumes:)';
  const match = compose.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?${end}`, 'm'));
  assert.ok(match, `missing ${name} service`);
  return match[0];
}

const dashboard = serviceBlock('dashboard', 'scheduler');
const scheduler = serviceBlock('scheduler');

test('base Compose keeps the no-profile default without forwarding host paths', () => {
  assert.doesNotMatch(compose, /DESIGNSIGNAL_STUDY_PROFILE_(?:FILE|HOST_FILE)/);
  assert.doesNotMatch(compose, /designsignal_study_profile/);
});

test('optional profile override requires one host file and exposes a fixed read-only secret', () => {
  assert.match(studyProfileCompose, /^services:\n  scheduler:\n/m);
  assert.doesNotMatch(studyProfileCompose, /^  dashboard:$/m);
  assert.match(studyProfileCompose, /^      DESIGNSIGNAL_STUDY_PROFILE_FILE: \/run\/secrets\/designsignal_study_profile$/m);
  assert.match(studyProfileCompose, /^    secrets:\n      - source: designsignal_study_profile\n        target: designsignal_study_profile\n        mode: 0444$/m);
  assert.match(studyProfileCompose, /^secrets:\n  designsignal_study_profile:\n    file: "\$\{DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE:\?[^}]+\}"$/m);
  assert.equal([...studyProfileCompose.matchAll(/^      - source: designsignal_study_profile$/gm)].length, 1);
  assert.equal([...studyProfileCompose.matchAll(/^    file: /gm)].length, 1);
  assert.match(envExample, /^DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE=$/m);
  assert.doesNotMatch(envExample, /^DESIGNSIGNAL_STUDY_PROFILE_FILE=/m);
});

test('optional profile override contains no profile data or production identity changes', () => {
  assert.doesNotMatch(studyProfileCompose, /directions|weaknesses|dailyMinutes|\{\s*"/);
  assert.doesNotMatch(studyProfileCompose, /^name:|image:|container_name:|volumes:|designsignal-data|\/data(?:$|:)/m);
  assert.doesNotMatch(studyProfileCompose, /\.\.\/|:\/run\/secrets|:\/protected|:\/home|[A-Za-z]:\\/);
});

test('Compose mounts only the selected host Codex file as the scheduler secret', () => {
  assert.match(compose, /^secrets:\n  codex_config:\n    file: "\$\{DESIGNSIGNAL_CODEX_CONFIG_FILE:-\$\{USERPROFILE\}\/\.codex\/config\.toml\}"$/m);
  assert.match(scheduler, /^      CODEX_CONFIG_FILE: \/run\/secrets\/codex_config$/m);
  assert.match(scheduler, /^    secrets:\n      - source: codex_config\n        target: codex_config\n        mode: 0444$/m);
  assert.doesNotMatch(dashboard, /codex_config|CODEX_CONFIG_FILE/);
  assert.doesNotMatch(compose, /CODEX_HOME|experimental_bearer_token|model_providers/);
});

test('Compose leaves OpenAI selection unset and passes optional source settings through', () => {
  for (const name of [
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
    'OPENAI_API_KEY',
    'OPENALEX_API_KEY',
    'OPENALEX_MAILTO',
    'DESIGNSIGNAL_RSSHUB_FEEDS',
    'DESIGNSIGNAL_RSSHUB_WECHAT_FEEDS',
    'DESIGNSIGNAL_RSSHUB_ZHIHU_FEEDS'
  ]) assert.match(scheduler, new RegExp(`^      ${name}:$`, 'm'), `${name} must be a host passthrough`);
  assert.doesNotMatch(compose, /api\.openai\.com|sk-[A-Za-z0-9_-]+|OPENAI_(?:BASE_URL|MODEL|API_KEY):[ \t]+\S/);
});

test('Compose fixes identities, shares one image and data volume, and publishes locally', () => {
  assert.match(compose, /^name: designsignal$/m);
  assert.match(dashboard, /^    container_name: designsignal-dashboard$/m);
  assert.match(scheduler, /^    container_name: designsignal-scheduler$/m);
  const images = [...compose.matchAll(/^    image: (\S+)$/gm)].map(match => match[1]);
  assert.deepEqual(images, ['designsignal-337-902:1.0.0', 'designsignal-337-902:1.0.0']);
  for (const block of [dashboard, scheduler]) assert.match(block, /^      - designsignal-data:\/data$/m);
  assert.match(compose, /^  designsignal-data:\n    name: designsignal-data$/m);
  assert.match(dashboard, /^      - "127\.0\.0\.1:3379:3379"$/m);
  assert.doesNotMatch(compose, /^\s+- "(?:0\.0\.0\.0)?:?3379:3379"$/m);
});

test('both Compose services retain production runtime hardening and health checks', () => {
  for (const [name, block] of [['dashboard', dashboard], ['scheduler', scheduler]]) {
    assert.match(block, /^    restart: unless-stopped$/m, `${name} restart policy`);
    assert.match(block, /^    read_only: true$/m, `${name} read-only root`);
    assert.match(block, /^      - \/tmp:rw,noexec,nosuid,size=64m,mode=1777$/m, `${name} tmpfs`);
    assert.match(block, /^      - no-new-privileges:true$/m, `${name} no-new-privileges`);
    assert.match(block, /^    cap_drop:\n      - ALL$/m, `${name} dropped capabilities`);
    assert.match(block, /^    healthcheck:$/m, `${name} health check`);
  }
  assert.match(dashboard, /\/healthz/);
  assert.match(scheduler, /\/proc\/1\/cmdline[\s\S]*schedule/);
});
