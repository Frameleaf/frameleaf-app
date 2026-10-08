#!/usr/bin/env node
// ponytail: single self-check for the video series. Parses every episode file,
// verifies logo intro/outro beats, estimates VO duration, and writes manifest.csv.
// Run: node docs/video-series/check-episodes.mjs   (exit 1 on any failure)
//      --write-vo regenerates voiceover/<ID>.txt from each episode's clean VO first.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const episodesDir = join(root, 'episodes');
const voDir = join(root, 'voiceover');
const WPM = 150; // conversational narration pace
const LOGO_SECONDS = 6; // 3 s intro + 3 s outro
const MAX_SECONDS = 180;
const writeVo = process.argv.includes('--write-vo');
if (writeVo) mkdirSync(voDir, { recursive: true });

const field = (md, name) => (md.match(new RegExp(`^\\| ${name} \\| (.+?) \\|$`, 'm')) || [])[1]?.trim();
const section = (md, heading) => {
  const m = md.match(new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |\\s*$(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
};
const words = (s) => s.replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean).length;
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

const SERIES = ['MKT', 'START', 'LIB', 'AI', 'PRIV', 'CARE', 'EDIT', 'MOBILE', 'OPS', 'CLOUD']; // watch order
const order = (f) => { const [p, n] = f.split('-'); return [SERIES.indexOf(p), Number(n)]; };
const files = readdirSync(episodesDir).filter((f) => f.endsWith('.md')).sort((a, b) => { const [x, y] = [order(a), order(b)]; return x[0] - y[0] || x[1] - y[1]; });
const master = ['# Frameleaf video series: voice-over master', '', 'Every episode narration in watch order. Cues: [pause] one second, [beat] half a second.', ''];
const rows = [];
const errors = [];
for (const f of files) {
  const md = readFileSync(join(episodesDir, f), 'utf8');
  const id = f.replace(/\.md$/, '').split('-').slice(0, 2).join('-');
  const title = (md.match(/^# (.+)$/m) || [])[1] || '(untitled)';
  const storyboard = section(md, 'Storyboard');
  const vo = section(md, 'Voice-over \\(clean\\)');
  const beats = storyboard.split('\n').filter((l) => /^\| \d+ \|/.test(l));
  if (!beats.length) errors.push(`${f}: no storyboard rows`);
  if (beats.length && !/LOGO INTRO/.test(beats[0])) errors.push(`${f}: first beat is not LOGO INTRO`);
  if (beats.length && !/LOGO OUTRO/.test(beats.at(-1))) errors.push(`${f}: last beat is not LOGO OUTRO`);
  if (!vo) errors.push(`${f}: missing "## Voice-over (clean)" section`);
  const w = words(vo);
  const est = Math.round((w / WPM) * 60 + LOGO_SECONDS);
  if (est > MAX_SECONDS) errors.push(`${f}: estimated ${mmss(est)} exceeds 3:00 (${w} words)`);
  const voFile = join(voDir, `${id}.txt`);
  if (writeVo) writeFileSync(voFile, `${id} · ${title.replace(/^\S+ · /, '')}\nTarget ${field(md, 'Target length')} · ${w} words · read at 150 wpm. Cues: [pause] one second, [beat] half a second.\n---\n${vo}\n`);
  if (!existsSync(voFile)) errors.push(`${f}: missing voiceover/${id}.txt`);
  else if (words(readFileSync(voFile, 'utf8').split('\n---\n').at(-1) || '') !== w)
    errors.push(`${f}: voiceover/${id}.txt word count differs from episode VO`);
  rows.push({ id, title, series: field(md, 'Series'), type: field(md, 'Type'), target: field(md, 'Target length'), words: w, est: mmss(est), file: `episodes/${f}` });
  master.push(`## ${title}`, '', `Target ${field(md, 'Target length')} · ${w} words · ${field(md, 'Type')}`, '', vo, '');
}
writeFileSync(join(root, 'VOICEOVER-MASTER.md'), master.join('\n'));
const csv = ['id,title,series,type,target_length,vo_words,estimated_length,file']
  .concat(rows.map((r) => [r.id, r.title, r.series, r.type, r.target, r.words, r.est, r.file].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')))
  .join('\n');
writeFileSync(join(root, 'manifest.csv'), csv + '\n');
console.log(`${rows.length} episodes, ${rows.reduce((a, r) => a + r.words, 0)} VO words, manifest.csv and VOICEOVER-MASTER.md written`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
