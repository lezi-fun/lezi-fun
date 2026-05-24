#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const USER = process.env.GITHUB_USER || 'lezi-fun';
const OUT_DIR = path.resolve('profile');
const API_BASE = 'https://api.github.com';
const USER_AGENT = 'lezi-fun-profile-cards';

const palette = ['#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#14b8a6'];

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const [user, repos, contributionsHtml] = await Promise.all([
    fetchJson(`${API_BASE}/users/${USER}`, headers),
    fetchAllRepos(headers),
    fetchText(`https://github.com/users/${USER}/contributions`, headers),
  ]);

  const sourceRepos = repos.filter((repo) => !repo.fork && !repo.archived);
  const languageTotals = await collectLanguages(sourceRepos, headers);
  const contributions = parseContributionDays(contributionsHtml);
  const contributionStats = summarizeContributions(contributions);
  const stars = sourceRepos.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);
  const topLanguages = buildTopLanguages(languageTotals, 6);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'stats.svg'), buildStatsSvg({
    user,
    stars,
    contributionStats,
  }), 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'top-langs.svg'), buildLanguagesSvg({
    user,
    repos: sourceRepos,
    topLanguages,
  }), 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'streak.svg'), buildStreakSvg({
    contributions,
    contributionStats,
  }), 'utf8');
}

async function fetchAllRepos(headers) {
  const repos = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await fetchJson(
      `${API_BASE}/users/${USER}/repos?per_page=100&page=${page}&sort=updated&direction=desc`,
      headers,
    );
    repos.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return repos;
}

async function collectLanguages(repos, headers) {
  const totals = new Map();
  for (const repo of repos) {
    const languages = await fetchJson(repo.languages_url, headers);
    for (const [language, bytes] of Object.entries(languages)) {
      const current = totals.get(language) || 0;
      totals.set(language, current + Number(bytes || 0));
    }
  }
  return totals;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchText(url, headers) {
  const res = await fetch(url, { headers: { ...headers, Accept: 'text/html' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function parseContributionDays(html) {
  const days = [];
  const re = /<td[^>]*data-date="([^"]+)"[^>]*data-level="(\d+)"[^>]*><\/td>\s*<tool-tip[^>]*>([\s\S]*?)<\/tool-tip>/g;
  let match;
  while ((match = re.exec(html))) {
    const count = parseContributionTooltip(match[3]);
    days.push({
      date: match[1],
      level: Number(match[2]),
      count,
    });
  }

  if (!days.length) {
    throw new Error('No contribution days found in GitHub contributions HTML.');
  }

  return days.sort((a, b) => a.date.localeCompare(b.date));
}

function parseContributionTooltip(text) {
  const normalized = decodeHtmlEntities(text.trim());
  if (/^No contributions on /.test(normalized)) {
    return 0;
  }

  const match = normalized.match(/^(\d+)\s+contributions?\s+on\s+/i);
  if (!match) {
    return 0;
  }

  return Number(match[1]);
}

function summarizeContributions(days) {
  let current = 0;
  let longest = 0;
  let run = 0;
  let total = 0;
  let activeDays = 0;

  for (const day of days) {
    total += day.count;
    if (day.count > 0) {
      activeDays += 1;
    }
    if (day.count > 0) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }

  let currentIndex = days.length - 1;
  const todayUtc = toDateString(new Date());

  if (
    currentIndex >= 0 &&
    days[currentIndex].date === todayUtc &&
    days[currentIndex].count === 0
  ) {
    currentIndex -= 1;
  }

  for (let index = currentIndex; index >= 0; index -= 1) {
    if (days[index].count <= 0) {
      break;
    }
    current += 1;
  }

  return { current, longest, total, activeDays };
}

function buildTopLanguages(languageTotals, maxEntries) {
  const sorted = [...languageTotals.entries()]
    .sort((a, b) => b[1] - a[1]);
  const totalBytes = sorted.reduce((sum, [, bytes]) => sum + bytes, 0);
  const top = sorted.slice(0, Math.max(0, maxEntries - 1));
  const otherBytes = sorted.slice(maxEntries - 1).reduce((sum, [, bytes]) => sum + bytes, 0);

  if (otherBytes > 0) {
    top.push(['Other', otherBytes]);
  }

  return top.map(([language, bytes], index) => ({
    language,
    bytes,
    color: palette[index % palette.length],
    percentage: totalBytes > 0 ? bytes / totalBytes : 0,
  }));
}

function buildStatsSvg({ user, stars, contributionStats }) {
  const width = 760;
  const height = 240;
  const createdYear = new Date(user.created_at).getUTCFullYear();
  const bigTitle = formatNumber(user.public_repos);

  return svgFrame(width, height, `
    <text x="28" y="42" class="title">GitHub Stats / 数据</text>
    <text x="28" y="66" class="subtitle">Self-hosted in this repository, refreshed by GitHub Actions.</text>

    <g transform="translate(28, 92)">
      <rect x="0" y="0" width="210" height="118" rx="18" class="panel" />
      <text x="20" y="48" class="hero">${bigTitle}</text>
      <text x="20" y="74" class="panel-title">public repos</text>
      <text x="20" y="100" class="panel-text">${formatNumber(stars)} stars · ${formatNumber(contributionStats.total)} contributions / year</text>
      <text x="20" y="122" class="panel-text">Since ${createdYear}</text>

      ${metricTile(230, 0, 150, 54, 'Followers', formatNumber(user.followers))}
      ${metricTile(390, 0, 150, 54, 'Following', formatNumber(user.following))}
      ${metricTile(550, 0, 150, 54, 'Current streak', formatDays(contributionStats.current))}

      ${metricTile(230, 64, 150, 54, 'Public gists', formatNumber(user.public_gists))}
      ${metricTile(390, 64, 150, 54, 'Longest streak', formatDays(contributionStats.longest))}
      ${metricTile(550, 64, 150, 54, 'Active days', formatNumber(contributionStats.activeDays))}
    </g>
  `);
}

function buildLanguagesSvg({ repos, topLanguages }) {
  const width = 760;
  const rowHeight = 30;
  const height = 116 + topLanguages.length * rowHeight;
  const totalRepos = repos.length;
  const totalBytes = topLanguages.reduce((sum, item) => sum + item.bytes, 0);

  return svgFrame(width, height, `
    <text x="28" y="42" class="title">Top Languages / 语言分布</text>
    <text x="28" y="66" class="subtitle">Aggregated from your public non-fork repositories.</text>

    <g transform="translate(28, 90)">
      ${topLanguages.map((item, index) => languageRow(item, index, topLanguages.length, totalBytes)).join('')}
    </g>

    <text x="28" y="${height - 20}" class="footer">Scanned ${formatNumber(totalRepos)} public repositories.</text>
  `);
}

function buildStreakSvg({ contributions, contributionStats }) {
  const width = 760;
  const outerX = 28;
  const outerY = 86;
  const chartY = 74;
  const cell = 10;
  const gap = 2;
  const rows = 7;
  const weeks = Math.ceil(contributions.length / rows);
  const gridWidth = weeks * (cell + gap) - gap;
  const gridHeight = rows * (cell + gap) - gap;
  const endDate = parseUtcDate(contributions[contributions.length - 1].date);
  const startDate = alignSunday(addDaysUtc(endDate, -weeks * 7 + 1));
  const lookup = new Map(contributions.map((day) => [day.date, day]));
  const height = outerY + chartY + gridHeight + 36;
  const legendX = Math.max(0, gridWidth - 124);
  const legendY = chartY - 24;

  return svgFrame(width, height, `
    <text x="28" y="42" class="title">Streak / 连续贡献</text>
    <text x="28" y="66" class="subtitle">Built from GitHub's public contributions calendar.</text>

    <g transform="translate(${outerX}, ${outerY})">
      ${metricTile(0, 0, 140, 54, 'Current streak', formatDays(contributionStats.current))}
      ${metricTile(150, 0, 140, 54, 'Longest streak', formatDays(contributionStats.longest))}
      ${metricTile(300, 0, 140, 54, 'Total', formatNumber(contributionStats.total))}

      <g transform="translate(0, ${chartY})">
        ${renderHeatmap(startDate, weeks, rows, cell, gap, lookup).join('')}
      </g>

      <g transform="translate(${legendX}, ${legendY})">
        ${legendSwatch(0, 0, '#0f172a', '0')}
        ${legendSwatch(24, 0, '#0f3d4a', '1')}
        ${legendSwatch(48, 0, '#116d7c', '2')}
        ${legendSwatch(72, 0, '#1ca6b8', '3')}
        ${legendSwatch(96, 0, '#5eead4', '4+')}
      </g>
    </g>
  `);
}

function metricTile(x, y, width, height, label, value) {
  return `
    <g transform="translate(${x}, ${y})">
      <rect x="0" y="0" width="${width}" height="${height}" rx="16" class="tile" />
      <text x="14" y="22" class="tile-label">${escapeXml(label)}</text>
      <text x="14" y="40" class="tile-value">${escapeXml(value)}</text>
    </g>
  `;
}

function languageRow(item, index, total, totalBytes) {
  const rowY = index * 30;
  const barX = 184;
  const barWidth = 412;
  const barHeight = 12;
  const percent = totalBytes > 0 ? item.percentage * 100 : 0;
  const fillWidth = Math.max(6, Math.round(barWidth * item.percentage));
  const maxLabelLength = 16;
  const languageLabel = item.language.length > maxLabelLength
    ? `${item.language.slice(0, maxLabelLength - 1)}…`
    : item.language;

  return `
    <g transform="translate(0, ${rowY})">
      <text x="0" y="14" class="lang-name">${escapeXml(languageLabel)}</text>
      <rect x="${barX}" y="4" width="${barWidth}" height="${barHeight}" rx="6" class="track" />
      <rect x="${barX}" y="4" width="${fillWidth}" height="${barHeight}" rx="6" fill="${item.color}" />
      <text x="${barX + barWidth + 14}" y="14" class="lang-meta">${percent.toFixed(1)}%</text>
      <text x="${barX + barWidth + 92}" y="14" class="lang-bytes">${compactNumber(item.bytes)}</text>
    </g>
  `;
}

function renderHeatmap(startDate, weeks, rows, cell, gap, lookup) {
  const parts = [];
  const paletteByLevel = ['#0f172a', '#0f3d4a', '#116d7c', '#1ca6b8', '#5eead4'];

  for (let week = 0; week < weeks; week += 1) {
    for (let weekday = 0; weekday < rows; weekday += 1) {
      const date = addDaysUtc(startDate, week * 7 + weekday);
      const key = toDateString(date);
      const day = lookup.get(key);
      const level = day ? Math.min(4, day.level) : 0;
      const x = week * (cell + gap);
      const y = weekday * (cell + gap);
      parts.push(`
        <rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${paletteByLevel[level]}" />
      `);
    }
  }

  return parts;
}

function legendSwatch(x, y, fill, label) {
  return `
    <g transform="translate(${x}, ${y})">
      <rect x="0" y="0" width="12" height="12" rx="3" fill="${fill}" />
      <text x="16" y="10" class="legend">${escapeXml(label)}</text>
    </g>
  `;
}

function svgFrame(width, height, content) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="profile card">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#07111f" />
      <stop offset="60%" stop-color="#0b1220" />
      <stop offset="100%" stop-color="#050814" />
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#5eead4" />
      <stop offset="100%" stop-color="#8b5cf6" />
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#020617" flood-opacity="0.55" />
    </filter>
    <style>
      .title { fill: #f8fafc; font: 700 22px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .subtitle { fill: #94a3b8; font: 500 12px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .hero { fill: #f8fafc; font: 800 44px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .panel-title { fill: #cbd5e1; font: 600 14px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; text-transform: uppercase; letter-spacing: 0.08em; }
      .panel-text { fill: #94a3b8; font: 500 12px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .tile-label { fill: #94a3b8; font: 600 11px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; text-transform: uppercase; letter-spacing: 0.08em; }
      .tile-value { fill: #f8fafc; font: 700 18px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .lang-name { fill: #e2e8f0; font: 600 13px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .lang-meta { fill: #cbd5e1; font: 600 12px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .lang-bytes { fill: #94a3b8; font: 500 11px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .legend { fill: #94a3b8; font: 500 11px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .footer { fill: #64748b; font: 500 11px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
      .panel, .tile, .track { fill: rgba(15, 23, 42, 0.75); stroke: rgba(148, 163, 184, 0.14); stroke-width: 1; }
    </style>
  </defs>
  <rect width="100%" height="100%" rx="22" fill="url(#bg)" filter="url(#shadow)" />
  <rect x="0" y="0" width="${width}" height="5" rx="22" fill="url(#accent)" />
  ${content}
</svg>`;
}

function decodeHtmlEntities(text) {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function compactNumber(value) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatDays(value) {
  return `${formatNumber(value)} ${value === 1 ? 'day' : 'days'}`;
}

function parseUtcDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysUtc(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function alignSunday(date) {
  const clone = new Date(date);
  const day = clone.getUTCDay();
  clone.setUTCDate(clone.getUTCDate() - day);
  return clone;
}

process.on('unhandledRejection', (error) => {
  console.error(error);
  process.exitCode = 1;
});

await main();
