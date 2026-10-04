// the UI meter is intentionally lightweight; the real hard stop lives in key-encryption.ts

export type PassphraseStrength = {
  /** 0-4, matching the meter's four segments. */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
};

const COMMON = new Set([
  'password', 'passphrase', 'letmein', 'welcome', 'qwerty', 'iloveyou',
  '12345678', '123456789', 'password1', 'abc12345', 'football', 'baseball',
  'monkey123', 'dragon123', 'sunshine', 'princess', 'admin123',
]);

export function estimatePassphraseStrength(passphrase: string): PassphraseStrength {
  const pass = passphrase ?? '';
  if (pass.length === 0) return { score: 0, label: 'Enter a passphrase' };

  const normalized = pass.toLowerCase();
  if (COMMON.has(normalized)) return { score: 0, label: 'Too common' };

  // A single repeated character ("aaaaaaaaaa") passes a naive length check.
  if (new Set(pass).size <= 2) return { score: 0, label: 'Too repetitive' };

  let points = 0;
  if (pass.length >= 8) points++;
  if (pass.length >= 12) points++;
  if (pass.length >= 16) points++;
  // Length dominates, but character variety still helps against a dictionary run.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(pass)).length;
  if (classes >= 3) points++;
  // Multi-word passphrases are the pattern we actually want to encourage.
  if (/\s|[-_.]/.test(pass.trim()) && pass.trim().length >= 12) points++;

  const score = Math.max(0, Math.min(4, points)) as PassphraseStrength['score'];
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score, label: labels[score]! };
}
