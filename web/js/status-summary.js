// Components use -1 (unknown), 0 (normal), 1 (warning), 2 (failure).
export function statusSummary(components, counts, unavailable = '') {
  const worst = Math.max(-1, ...components.map((c) => c.level));
  const names = (level) => components.filter((c) => c.level === level).map((c) => c.name).join(', ');
  const parts = [];
  if (counts?.fail) parts.push(`${counts.fail} check${counts.fail === 1 ? '' : 's'} failing`);
  if (counts?.warn) parts.push(`${counts.warn} warning${counts.warn === 1 ? '' : 's'}`);
  const checksAttention = parts.length > 0;
  let text = parts.join(', ');
  const componentText = unavailable || (worst < 0 ? 'Waiting for the first samples…'
    : worst ? `${worst === 2 ? 'Attention needed' : 'Degraded'}: ${names(worst)}`
      : `All components normal${components.some((c) => c.level < 0) ? ` · no data: ${names(-1)}` : ''}`);
  if (!text || worst > 0 || unavailable || worst < 0) text += `${text ? ' · ' : ''}${componentText}`;
  if (!counts) text += ' · Checks unavailable or loading';
  else if (counts.unknown) text += ` · ${counts.unknown} checks not checked`;
  const level = Math.max(unavailable ? -1 : worst, counts?.fail ? 2 : counts?.warn ? 1 : -1);
  return { text, level: ['none', 'ok', 'warn', 'err'][level + 1], checksAttention };
}
