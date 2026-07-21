import path from 'node:path';
import { ROOT } from './config.mjs';
import { readJson, sha256 } from './util.mjs';

export async function loadExamEvidence() {
  const evidence = await readJson(path.join(ROOT, 'config/exam-evidence.json'));
  const canonical = JSON.stringify({ ...evidence, documentSha256: undefined });
  return { ...evidence, documentSha256: sha256(canonical) };
}
