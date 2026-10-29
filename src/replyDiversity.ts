// Only compare the opening, never another viewer's facts or a phrase in the body.
export function replyOpening(text: string, nickname = ''): string {
  let opening = text.trim();
  if (nickname) opening = opening.split(nickname).join('观众');
  return opening.replace(/[\r\n]+/g, ' ').slice(0, 48);
}

function openingKeys(text: string): string[] {
  const opening = text.normalize('NFKC').toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '').replace(/^观众[，,、：:\s]*/, '');
  const normalized = opening.replace(/[^\p{L}\p{N}]/gu, '');
  if (!normalized) return [];
  const keys: string[] = [];
  // Variants of the same exclamation still sound like a repeated opening.
  const filler = normalized.match(/^(?:[哎唉诶欸][呀哟呦]?|哇[哦噢]?|哈{2,}|嘿{2,}|嗯[嗯哼]|好[的呀啊哇]|没问题)/u)?.[0];
  if (filler) keys.push(`语气词:${/^[哎唉诶欸]/u.test(filler) ? '哎呀' : /^哇/u.test(filler) ? '哇' : /^哈/u.test(filler) ? '哈哈' : /^嘿/u.test(filler) ? '嘿嘿' : /^嗯/u.test(filler) ? '嗯' : /^好/u.test(filler) ? '好的' : filler}`);
  const phrase = opening.split(/[，,。.!！?？；;：:…]/u)[0].replace(/[^\p{L}\p{N}]/gu, '');
  if (phrase.length >= 4) keys.push(`句式:${normalized.slice(0, 4)}`);
  else if (phrase.length >= 2) keys.push(`短开场:${phrase}`);
  return keys;
}

export function repeatedOpening(text: string, nickname: string, recentOpenings: string[]): string | undefined {
  const current = openingKeys(replyOpening(text, nickname));
  return recentOpenings.find(previous => openingKeys(previous).some(key => current.includes(key)));
}
