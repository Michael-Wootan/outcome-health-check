#!/usr/bin/env node
'use strict';
/**
 * outcome-health-check.js: is each automation achieving its goal?
 *
 * A status monitor answers "did each workflow exit 0?". This answers
 * "is each automation achieving its goal?", from ground truth rather than
 * self-reported log lines:
 *
 *   Content     -> articles actually published on Shopify in the window
 *   Outreach    -> pitches sent / replies / assets auto-sent (outreach log +
 *                  reply log) and whether those assets produced a live
 *                  backlink (Ahrefs), plus DR / referring-domain trend
 *   Journalist  -> digests that arrived in the mailbox vs digests the bot saw
 *   requests       vs pitches sent (catches the "running but deaf" failure)
 *   Indexing    -> indexed / not-indexed from the indexing state file
 *   Directories -> listed count from the directory status file
 *   Workflows   -> last run conclusion + age for every workflow in every repo
 *   Business    -> Shopify gross, refunds, open unfulfilled orders, fraud
 *                  review tags, abandoned checkouts
 *
 * Each area gets a deterministic verdict (ACHIEVING / RUNNING-NOT-ACHIEVING /
 * NOT-RUNNING / DORMANT). Claude then writes a short narrative + top-5 action
 * list from the evidence JSON. Everything is saved under reports/health-checks/
 * (markdown + JSON snapshot, so the next run can show deltas) and emailed.
 *
 * Usage:
 *   node src/outcome-health-check.js                # window = WINDOW_DAYS (default 15)
 *   node src/outcome-health-check.js --no-email     # build + save, don't send
 *   WINDOW_DAYS=30 node src/outcome-health-check.js
 *
 * Every data source is wrapped in try/catch: a missing secret or a dead API
 * becomes a "NOT AUDITABLE" row, never a crashed report.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true, quiet: true });
const fs = require('fs');
const path = require('path');
const Imap = require('imap');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');

const ROOT = path.join(__dirname, '..');
const NO_EMAIL = process.argv.includes('--no-email');
const WINDOW_DAYS = parseInt(process.env.WINDOW_DAYS || '15', 10);
const NOW = new Date();
const WINDOW_START = new Date(NOW.getTime() - WINDOW_DAYS * 86400000);
const DATE = NOW.toISOString().slice(0, 10);

const REPO = process.env.MONITOR_REPO || process.env.GITHUB_REPOSITORY;
// Other repos to audit: comma-separated owner/name list, read with EXTRA_REPOS_TOKEN
const EXTRA_REPOS = (process.env.EXTRA_REPOS || '').split(',').map(r => r.trim()).filter(Boolean)
  .map(repo => ({ repo, token: process.env.EXTRA_REPOS_TOKEN }));
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const AHREFS_TOKEN = process.env.AHREFS_API_TOKEN;
const SITE = process.env.SITE_DOMAIN;
const COMPANY = process.env.COMPANY_NAME || 'Acme Supply Co.';
const BUSINESS_DESCRIPTION = process.env.BUSINESS_DESCRIPTION || 'an e-commerce and B2B wholesale business';
// Order tags that mean a fraud tool is holding the order for review
const FRAUD_TAG_RE = new RegExp(process.env.FRAUD_REVIEW_TAG_PATTERN || 'nofraud_(error|review)', 'i');
// In extra repos, workflows matching this are manual-only and never count as stale
const MANUAL_ONLY_RE = new RegExp(process.env.MANUAL_ONLY_PATTERN || 'deploy|backfill|eval');
// Target publishing rate for the content verdict
const ARTICLES_PER_DAY_TARGET = parseFloat(process.env.ARTICLES_PER_DAY_TARGET || '4');
// Folder holding the other automations' state files
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, '..', 'state');
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const EMAIL_TO = process.env.EMAIL_NOTIFY || GMAIL_USER;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const HARO_MAILBOX = process.env.HARO_MAILBOX || '[Gmail]/All Mail';
const HARO_SENDERS = ['haro@helpareporter.com', 'noreply@helpareporter.com', 'queries@helpareporter.com',
  'hello@sourceofsources.com', 'peter@sourceofsources.com', 'no-reply@qwoted.com', 'noreply@qwoted.com'];

const REPORT_DIR = path.join(ROOT, 'reports', 'health-checks');
const SNAPSHOT_FILE = path.join(REPORT_DIR, 'latest.json');

const inWindow = (ts) => ts && new Date(ts) >= WINDOW_START;
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8')); } catch { return fallback; } };
const readState = (name, fallback) => readJson(path.join(STATE_DIR, name), fallback);
const fmtMoney = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a');
const daysAgo = (ts) => ts ? Math.round((NOW - new Date(ts)) / 86400000) : null;

// ── API clients ─────────────────────────────────────────────────────────────
async function gh(endpoint, token = GITHUB_TOKEN, repo = REPO) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com/repos/${repo}${endpoint}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${endpoint}`);
  return res.json();
}
async function shopify(pathname) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/${pathname}`, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
  if (!res.ok) throw new Error(`Shopify ${res.status} ${pathname.split('?')[0]}`);
  return res.json();
}
async function shopifyAll(pathname, key) {
  // Follows Link: rel="next" pagination (cursor-based) up to 20 pages.
  let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/${pathname}`;
  const out = [];
  for (let i = 0; i < 20 && url; i++) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
    if (!res.ok) throw new Error(`Shopify ${res.status} ${pathname.split('?')[0]}`);
    const data = await res.json();
    out.push(...(data[key] || []));
    const link = res.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return out;
}
async function ahrefs(endpoint, params) {
  const url = new URL(`https://api.ahrefs.com/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AHREFS_TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Ahrefs ${res.status} ${endpoint}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── Collectors (each returns a section object; never throws) ────────────────
const sections = {};
const errors = [];
async function collect(name, fn) {
  try { sections[name] = await fn(); }
  catch (e) { errors.push(`${name}: ${e.message}`); sections[name] = { verdict: 'NOT AUDITABLE', note: e.message }; }
}

async function blogSection() {
  if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_ADMIN_TOKEN missing');
  const { blogs } = await shopify('blogs.json?fields=id,handle,title');
  const perBlog = {};
  let total = 0;
  for (const b of blogs) {
    const arts = await shopifyAll(`blogs/${b.id}/articles.json?limit=250&published_status=published&published_at_min=${WINDOW_START.toISOString()}&fields=id,published_at`, 'articles');
    perBlog[b.handle] = arts.length;
    total += arts.length;
  }
  const perDay = total / WINDOW_DAYS;
  return {
    verdict: perDay >= ARTICLES_PER_DAY_TARGET * 0.75 ? 'ACHIEVING' : perDay > 0 ? 'RUNNING-NOT-ACHIEVING' : 'NOT-RUNNING',
    published: total, perDay: +perDay.toFixed(2), target: ARTICLES_PER_DAY_TARGET, perBlog,
    evidence: `${total} articles published in ${WINDOW_DAYS}d (${perDay.toFixed(1)}/day vs target ${ARTICLES_PER_DAY_TARGET})`,
  };
}

async function outreachSection() {
  const log = readState('outreach-log.json', {});
  const entries = Object.values(log).filter(v => v && typeof v === 'object');
  const sent = entries.filter(e => inWindow(e.lastSent)).length;
  const followUps = entries.filter(e => inWindow(e.follow1Date) || inWindow(e.follow2Date)).length;
  const remaining = entries.filter(e => !e.status && !e.noEmail).length;
  const replyLog = readState('reply-handler-log.json', {});
  const replies = Object.values(replyLog).filter(r => r && inWindow(r.ts));
  const byClass = {};
  for (const r of replies) byClass[r.class || 'unclassified'] = (byClass[r.class || 'unclassified'] || 0) + 1;
  const articlesSent = Object.values(replyLog).filter(r => r && r.articleSent);
  const articlesSentWindow = articlesSent.filter(r => inWindow(r.ts)).length;

  // Did any auto-sent article turn into a live link? Check Ahrefs for a
  // backlink from each article-sent domain (cheap: 1 row per domain).
  const placed = [];
  const unverified = [];
  if (AHREFS_TOKEN) {
    const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|icloud|aol|proton(mail)?|live|msn|me)\.com$|^protonmail\.ch$/i;
    const domains = [...new Set(articlesSent.map(r => r.domain).filter(d => d && !FREE_MAIL.test(d)))].slice(-25);
    for (const domain of domains) {
      try {
        const d = await ahrefs('site-explorer/all-backlinks', {
          target: SITE, mode: 'subdomains', limit: 1, history: 'live', aggregation: '1_per_domain',
          select: 'url_from,first_seen_link',
          where: { field: 'root_name_source', is: ['eq', domain] },
        });
        if ((d.backlinks || []).length) placed.push({ domain, url: d.backlinks[0].url_from, firstSeen: d.backlinks[0].first_seen_link });
      } catch (e) { unverified.push(`${domain}: ${e.message.slice(0, 80)}`); }
    }
  }
  let dr = null, refdomains = null, drHistory = [];
  if (AHREFS_TOKEN) {
    try { dr = (await ahrefs('site-explorer/domain-rating', { target: SITE, date: DATE })).domain_rating?.domain_rating ?? null; } catch (e) { errors.push(`ahrefs DR: ${e.message}`); }
    try { refdomains = (await ahrefs('site-explorer/backlinks-stats', { target: SITE, mode: 'domain', date: DATE })).metrics?.live_refdomains ?? null; } catch (e) { errors.push(`ahrefs refdomains: ${e.message}`); }
    try {
      const h = await ahrefs('site-explorer/domain-rating-history', { target: SITE, date_from: WINDOW_START.toISOString().slice(0, 10), date_to: DATE, history_grouping: 'daily' });
      drHistory = (h.history || []).map(x => ({ date: x.date, dr: x.domain_rating }));
    } catch { /* optional */ }
  }
  const verdict = placed.length > 0 ? 'ACHIEVING' : sent > 0 ? 'RUNNING-NOT-ACHIEVING' : 'NOT-RUNNING';
  return {
    verdict, sent, followUps, poolRemaining: remaining, repliesClassified: replies.length, byClass,
    articlesSentTotal: articlesSent.length, articlesSentWindow, linksPlaced: placed, linksUnverified: unverified,
    dr, refdomains, drStart: drHistory[0]?.dr ?? null,
    evidence: `${sent} pitches, ${followUps} follow-ups, ${replies.length} replies classified, ${articlesSentWindow} assets auto-sent in ${WINDOW_DAYS}d; ${placed.length} confirmed live links from ${articlesSent.length} articles ever sent; DR ${dr ?? '?'}, ${refdomains ?? '?'} referring domains; ${remaining} targets left in pool`,
  };
}

function countGmailDigests() {
  return new Promise((resolve) => {
    if (!GMAIL_PASS) return resolve({ count: null, note: 'GMAIL_APP_PASSWORD missing' });
    const imap = new Imap({ user: GMAIL_USER, password: GMAIL_PASS, host: 'imap.gmail.com', port: 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 20000 });
    const finish = (v) => { try { imap.end(); } catch {} resolve(v); };
    imap.once('ready', () => {
      imap.openBox(HARO_MAILBOX, true, async (err) => {
        if (err) return finish({ count: null, note: `openBox ${HARO_MAILBOX}: ${err.message}` });
        const since = WINDOW_START.toISOString().slice(0, 10);
        const uids = new Set();
        for (const s of HARO_SENDERS) {
          await new Promise(r => imap.search([['SINCE', since], ['FROM', s]], (e, res) => { (res || []).forEach(u => uids.add(u)); r(); }));
        }
        finish({ count: uids.size });
      });
    });
    imap.once('error', (e) => finish({ count: null, note: e.message }));
    imap.connect();
  });
}

async function haroSection() {
  const log = readState('journalist-log.json', {});
  const runs = (log._runs || []).filter(r => inWindow(r.ts));
  const seen = runs.reduce((a, r) => a + Object.values(r.emailsSeen || {}).reduce((x, y) => x + y, 0), 0);
  const pitched = runs.reduce((a, r) => a + (r.pitched || 0), 0);
  const sentEver = (log._sent || []).length;
  const sentWindow = (log._sent || []).filter(s => inWindow(s.ts)).length;
  const gmail = await countGmailDigests();
  const deaf = gmail.count > 0 && seen === 0;
  const verdict = pitched > 0 ? 'ACHIEVING' : runs.length === 0 ? 'NOT-RUNNING' : 'RUNNING-NOT-ACHIEVING';
  return {
    verdict, runs: runs.length, digestsInGmail: gmail.count, gmailNote: gmail.note, digestsSeenByBot: seen, pitched, sentWindow, sentEver, deaf,
    evidence: `${runs.length} runs in ${WINDOW_DAYS}d; Gmail has ${gmail.count ?? '?'} digests in ${HARO_MAILBOX}, bot saw ${seen}, sent ${pitched} pitches (${sentEver} ever)${deaf ? ': DEAF: digests arriving but bot sees none' : ''}`,
  };
}

function gscSection() {
  const s = readState('indexing-state.json', null);
  if (!s) throw new Error('indexing-state.json missing');
  const indexed = (s.indexed || []).length, notIndexed = (s.not_indexed || []).length, all = (s.all_urls || []).length;
  const age = daysAgo(s.last_scan);
  return {
    verdict: age !== null && age <= 3 ? 'ACHIEVING' : 'NOT-RUNNING', indexed, notIndexed, all, lastScan: s.last_scan, submittedToday: s.submitted_today,
    evidence: `${indexed} indexed / ${notIndexed} not indexed of ${all} (${pct(indexed, indexed + notIndexed)}), last scan ${age}d ago`,
  };
}

function directorySection() {
  const d = readState('directory-status.json', {});
  const rows = Object.entries(d);
  if (rows.length === 0) throw new Error('directory-status.json missing or empty');
  const listed = rows.filter(([, v]) => v.listedAt).length;
  const submitted = rows.filter(([, v]) => v.status === 'submitted').length;
  const needsReview = rows.filter(([, v]) => v.status === 'needs-review').length;
  return {
    verdict: listed > 0 ? 'ACHIEVING' : 'RUNNING-NOT-ACHIEVING', listed, submitted, needsReview, total: rows.length,
    evidence: `${listed} live of ${rows.length} (${submitted} pitched by email, ${needsReview} awaiting manual review)`,
  };
}

async function workflowsSection() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing');
  if (!REPO) throw new Error('MONITOR_REPO not set');
  const out = [];
  const repos = [{ repo: REPO, token: GITHUB_TOKEN }, ...EXTRA_REPOS.map(r => ({ ...r, token: r.token || GITHUB_TOKEN }))];
  for (const { repo, token } of repos) {
    let wfs;
    try { wfs = (await gh('/actions/workflows?per_page=100', token, repo)).workflows || []; }
    catch (e) { out.push({ repo, name: '(all)', state: 'unreachable', note: e.message }); continue; }
    for (const w of wfs) {
      if (w.state !== 'active') { out.push({ repo, name: w.name, file: path.basename(w.path), state: w.state }); continue; }
      try {
        const runs = (await gh(`/actions/workflows/${w.id}/runs?per_page=1&status=completed`, token, repo)).workflow_runs || [];
        const r = runs[0];
        out.push({ repo, name: w.name, file: path.basename(w.path), state: 'active', conclusion: r?.conclusion || 'never', lastRun: r?.updated_at || null, ageDays: daysAgo(r?.updated_at), url: r?.html_url });
      } catch (e) { out.push({ repo, name: w.name, file: path.basename(w.path), state: 'active', conclusion: 'error', note: e.message }); }
    }
  }
  const unreachable = out.filter(w => w.state === 'unreachable');
  const audited = out.filter(w => w.state !== 'unreachable');
  const failing = audited.filter(w => w.conclusion === 'failure');
  // Manual-only tools (no `schedule:` trigger) are expected to sit idle; only
  // scheduled workflows count as stale. Local checkout is authoritative for
  // this repo; extra repos are judged by name list below.
  const hasSchedule = (w) => {
    if (w.repo !== REPO) return !MANUAL_ONLY_RE.test(w.file || '');
    try { return /^\s*schedule:/m.test(fs.readFileSync(path.join(ROOT, '.github', 'workflows', w.file), 'utf8')); } catch { return true; }
  };
  const stale = audited.filter(w => w.state === 'active' && hasSchedule(w) && w.ageDays !== null && w.ageDays > 35);
  const verdict = audited.length === 0 ? 'NOT AUDITABLE' : failing.length === 0 ? 'ACHIEVING' : 'RUNNING-NOT-ACHIEVING';
  return { verdict, total: audited.length, failing: failing.map(w => `${w.file} (${w.repo.split('/')[1]})`), stale: stale.map(w => `${w.file} ${w.ageDays}d`), unreachable: unreachable.map(w => `${w.repo}: ${w.note}`), rows: out,
    evidence: `${audited.length} workflows audited; ${failing.length} last-run failed [${failing.map(w => w.file).join(', ')}]; ${stale.length} silent >35d${unreachable.length ? `; UNREACHABLE: ${unreachable.map(w => w.repo.split('/')[1]).join(', ')}` : ''}` };
}

async function businessSection() {
  if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_ADMIN_TOKEN missing');
  const min = WINDOW_START.toISOString();
  const orders = await shopifyAll(`orders.json?status=any&created_at_min=${min}&limit=250&fields=id,name,created_at,total_price,financial_status,fulfillment_status,tags,refunds`, 'orders');
  const real = orders.filter(o => o.financial_status !== 'voided');
  const gross = real.reduce((a, o) => a + parseFloat(o.total_price || 0), 0);
  let refunds = 0;
  for (const o of orders) for (const r of (o.refunds || [])) for (const t of (r.transactions || [])) if (t.kind === 'refund' && t.status === 'success') refunds += parseFloat(t.amount || 0);
  const open = await shopifyAll('orders.json?status=open&fulfillment_status=unshipped&limit=250&fields=id,name,created_at,total_price,tags', 'orders');
  const nofraud = open.filter(o => FRAUD_TAG_RE.test(o.tags || ''));
  const openValue = open.reduce((a, o) => a + parseFloat(o.total_price || 0), 0);
  const oldest = open.length ? Math.max(...open.map(o => daysAgo(o.created_at))) : 0;
  let abandoned = null;
  try { abandoned = (await shopifyAll(`checkouts.json?created_at_min=${min}&limit=250&fields=id`, 'checkouts')).length; } catch (e) { errors.push(`abandoned checkouts: ${e.message}`); }
  const refundRate = gross ? refunds / gross : 0;
  // Previous window of the same length, so a revenue drop is visible even on
  // the first run (no snapshot yet).
  let prevGross = null, prevOrders = null;
  try {
    const prevStart = new Date(WINDOW_START.getTime() - WINDOW_DAYS * 86400000).toISOString();
    const prev = (await shopifyAll(`orders.json?status=any&created_at_min=${prevStart}&created_at_max=${min}&limit=250&fields=id,total_price,financial_status`, 'orders')).filter(o => o.financial_status !== 'voided');
    prevOrders = prev.length; prevGross = +prev.reduce((a, o) => a + parseFloat(o.total_price || 0), 0).toFixed(2);
  } catch (e) { errors.push(`previous-window orders: ${e.message}`); }
  const grossChange = prevGross ? +(100 * (gross - prevGross) / prevGross).toFixed(0) : null;
  const verdict = nofraud.length > 0 || refundRate > 0.1 || (grossChange !== null && grossChange < -30) ? 'RUNNING-NOT-ACHIEVING' : 'ACHIEVING';
  return {
    verdict, orders: real.length, gross: +gross.toFixed(2), prevOrders, prevGross, grossChangePct: grossChange, refunds: +refunds.toFixed(2), refundRate: +(refundRate * 100).toFixed(1),
    openUnfulfilled: open.length, openValue: +openValue.toFixed(2), oldestOpenDays: oldest, nofraudTagged: nofraud.length,
    nofraudOrders: nofraud.slice(0, 15).map(o => `${o.name} ${fmtMoney(o.total_price)}`), abandonedCheckouts: abandoned,
    evidence: `${real.length} orders, ${fmtMoney(gross)} gross${grossChange !== null ? ` (${grossChange > 0 ? '+' : ''}${grossChange}% vs prior ${WINDOW_DAYS}d: ${prevOrders} orders, ${fmtMoney(prevGross)})` : ''}, ${fmtMoney(refunds)} refunded (${(refundRate * 100).toFixed(1)}%); ${open.length} open unfulfilled (${fmtMoney(openValue)}, oldest ${oldest}d, ${nofraud.length} fraud-review-tagged); ${abandoned ?? '?'} abandoned checkouts`,
  };
}

// ── Narrative via Claude ────────────────────────────────────────────────────
async function narrative(report, prev) {
  if (!ANTHROPIC_KEY) return '(ANTHROPIC_API_KEY not set: narrative skipped)';
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const prompt = `You are auditing the automation suite of ${COMPANY} (${BUSINESS_DESCRIPTION}, ${SITE}) for its owner. Below is the evidence JSON for the last ${WINDOW_DAYS} days, plus the previous snapshot for deltas.

Write a concise health-check narrative in markdown with exactly these sections:
1. "## Bottom line": 2-3 sentences. Honest, no hedging, real numbers. If gross sales, order count or the open-unfulfilled backlog look abnormal, that comes first, before any SEO metric.
2. "## Deltas vs last check": a short table of the metrics that moved (skip if no previous snapshot).
3. "## Top 5 actions": numbered, ranked by revenue/time impact, each one line with the number that justifies it. Actions must be concrete things the owner or a bot can do this week.

Rules: ${process.env.NARRATIVE_RULES || 'Do not make claims the evidence does not support.'} Do not pad; under 350 words total. Do not restate the scorecard (it is rendered separately).

EVIDENCE (one object per area; the business area is the store's revenue and must be weighed first):
${JSON.stringify(Object.fromEntries(Object.entries(report.sections).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => !['rows', 'linksUnverified'].includes(f)))])), null, 1).slice(0, 16000)}
COLLECTOR WARNINGS: ${JSON.stringify(report.errors)}

PREVIOUS SNAPSHOT (may be null):
${JSON.stringify(prev ? { date: prev.date, sections: Object.fromEntries(Object.entries(prev.sections || {}).map(([k, v]) => [k, { verdict: v.verdict, evidence: v.evidence }])) } : null)}`;
  const msg = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
  return msg.content[0].text.trim();
}

// ── Render ──────────────────────────────────────────────────────────────────
const ORDER = [['blog', 'Content pipeline'], ['outreach', 'Partner outreach → links placed'], ['haro', 'Journalist requests'], ['gsc', 'GSC indexing'], ['directories', 'Directory listings'], ['workflows', 'Workflow run health (all repos)'], ['business', 'Business vitals (Shopify)']];
const ICON = { 'ACHIEVING': '✅', 'RUNNING-NOT-ACHIEVING': '⚠️', 'NOT-RUNNING': '❌', 'DORMANT': '💤', 'NOT AUDITABLE': '❔' };

function scorecardMd() {
  return ['| Area | Verdict | Evidence |', '|---|---|---|', ...ORDER.map(([k, label]) => { const s = sections[k] || {}; return `| ${label} | ${ICON[s.verdict] || ''} ${s.verdict || '?'} | ${s.evidence || s.note || ''} |`; })].join('\n');
}
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function scorecardHtml() {
  const color = { 'ACHIEVING': '#1e7f3a', 'RUNNING-NOT-ACHIEVING': '#b26a00', 'NOT-RUNNING': '#b00020', 'DORMANT': '#666', 'NOT AUDITABLE': '#666' };
  return `<table style="border-collapse:collapse;width:100%;font-size:13px">${ORDER.map(([k, label]) => { const s = sections[k] || {}; return `<tr><td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap"><b>${esc(label)}</b></td><td style="padding:8px;border-bottom:1px solid #eee;color:${color[s.verdict] || '#666'};white-space:nowrap">${ICON[s.verdict] || ''} ${esc(s.verdict)}</td><td style="padding:8px;border-bottom:1px solid #eee;color:#333">${esc(s.evidence || s.note)}</td></tr>`; }).join('')}</table>`;
}
function mdToHtml(md) {
  // tiny renderer: headings, tables, numbered/bulleted lists, paragraphs
  const lines = md.split('\n'); const out = []; let list = null; let table = [];
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushTable = () => { if (table.length) { const rows = table.filter(r => !/^\|?\s*-{2,}/.test(r)); out.push('<table style="border-collapse:collapse;font-size:13px">' + rows.map((r, i) => '<tr>' + r.split('|').filter((c, j, a) => !(j === 0 && c.trim() === '') && !(j === a.length - 1 && c.trim() === '')).map(c => `<${i ? 'td' : 'th'} style="padding:4px 10px;border-bottom:1px solid #eee;text-align:left">${esc(c.trim())}</${i ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>'); table = []; } };
  for (const l of lines) {
    if (/^\|/.test(l)) { flushList(); table.push(l); continue; } else flushTable();
    const h = l.match(/^(#{1,3})\s+(.*)/); if (h) { flushList(); out.push(`<h${h[1].length + 1} style="margin:18px 0 6px">${esc(h[2])}</h${h[1].length + 1}>`); continue; }
    const li = l.match(/^\s*(\d+\.|[-*])\s+(.*)/); if (li) { const t = /\d/.test(li[1]) ? 'ol' : 'ul'; if (list !== t) { flushList(); out.push(`<${t}>`); list = t; } out.push(`<li>${esc(li[2]).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`); continue; }
    flushList(); if (l.trim()) out.push(`<p>${esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`);
  }
  flushList(); flushTable(); return out.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🩺 Outcome Health Check: ${DATE} (window ${WINDOW_DAYS}d from ${WINDOW_START.toISOString().slice(0, 10)})\n`);
  const prev = fs.existsSync(SNAPSHOT_FILE) ? readJson('reports/health-checks/latest.json', null) : null;

  await collect('blog', blogSection);
  await collect('outreach', outreachSection);
  await collect('haro', haroSection);
  await collect('gsc', async () => gscSection());
  await collect('directories', async () => directorySection());
  await collect('workflows', workflowsSection);
  await collect('business', businessSection);
  for (const [k] of ORDER) console.log(`  ${ICON[sections[k]?.verdict] || '?'} ${k.padEnd(12)} ${sections[k]?.evidence || sections[k]?.note || ''}`);
  if (errors.length) console.log(`\n  ⚠️ collector warnings:\n   - ${errors.join('\n   - ')}`);

  const report = { date: DATE, windowDays: WINDOW_DAYS, windowStart: WINDOW_START.toISOString(), sections, errors };
  let story = '';
  try { story = await narrative(report, prev); } catch (e) { story = `(narrative failed: ${e.message})`; errors.push(`narrative: ${e.message}`); }

  const md = `# Outcome Health Check: ${DATE}\n\nWindow: last ${WINDOW_DAYS} days (${WINDOW_START.toISOString().slice(0, 10)} → ${DATE}). Previous: ${prev?.date || 'none'}.\n\n## Scorecard\n\n${scorecardMd()}\n\n${story}\n\n${errors.length ? `## Collector warnings\n\n${errors.map(e => `- ${e}`).join('\n')}\n` : ''}\n*Generated by ops/outcome-health-check.js in GitHub Actions.*\n`;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, `${DATE}.md`), md);
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(report, null, 2));
  console.log(`\n📄 Saved reports/health-checks/${DATE}.md + latest.json`);

  const bad = ORDER.filter(([k]) => sections[k]?.verdict && sections[k].verdict !== 'ACHIEVING' && sections[k].verdict !== 'DORMANT').length;
  const subject = `${bad ? '⚠️' : '✅'} ${COMPANY} Outcome Health Check: ${DATE}: ${bad} of ${ORDER.length} areas need attention`;
  console.log(`\nHEALTH SUMMARY\n  Areas needing attention: ${bad}/${ORDER.length}\n  Report: reports/health-checks/${DATE}.md`);

  if (NO_EMAIL) { console.log('  (--no-email: not sent)'); return; }
  if (!GMAIL_PASS) { console.log('  ⚠️ GMAIL_APP_PASSWORD missing: email not sent'); return; }
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:820px;margin:0 auto;padding:20px;color:#222">
<h2 style="margin:0 0 4px">🩺 Outcome Health Check: ${DATE}</h2>
<div style="color:#666;font-size:12px;margin-bottom:16px">Window: last ${WINDOW_DAYS} days · previous check: ${esc(prev?.date || 'none')} · ground truth from Shopify, Ahrefs, Gmail, GitHub Actions, repo state files</div>
${scorecardHtml()}
<div style="margin-top:18px">${mdToHtml(story)}</div>
${errors.length ? `<details style="margin-top:16px;color:#888;font-size:12px"><summary>Collector warnings (${errors.length})</summary><ul>${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
<p style="color:#999;font-size:11px;margin-top:24px">Full report committed to reports/health-checks/${DATE}.md · generated by ops/outcome-health-check.js</p>
</body></html>`;
  const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  await transporter.sendMail({ from: `"${COMPANY} Health Check" <${GMAIL_USER}>`, to: EMAIL_TO, subject, html, text: md });
  console.log(`  ✉️ Emailed to ${EMAIL_TO}`);
})().catch(e => { console.error('❌ Fatal:', e); process.exit(1); });
