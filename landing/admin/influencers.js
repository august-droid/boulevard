// Boulevard /admin — influencer campaign module.
//
// Self-contained ES module mounted by index.html into the "Influencers"
// section. Talks to Supabase directly with the signed-in admin's session;
// the influencer_* tables are admin-only via RLS (is_admin()).
//
// Tables: influencer_creators, influencer_campaigns, influencer_deals,
// influencer_outreach  (see sql/2026-05-18_influencer_campaigns.sql).

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let sb = null;          // Supabase client (passed in from index.html)
let toast = () => {};   // toast(msg)
let rootEl = null;      // the section container we render into

const state = {
  tab: 'creators',
  creators: [],
  campaigns: [],
  deals: [],
  outreach: [],
  filters: {},
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STATUSES = [
  ['discovered', 'Discovered'],
  ['approved_outreach', 'Approved for outreach'],
  ['contacted', 'Contacted'],
  ['replied', 'Replied'],
  ['negotiating', 'Negotiating'],
  ['deal_agreed', 'Deal agreed'],
  ['brief_sent', 'Content brief sent'],
  ['content_received', 'Content received'],
  ['revision_requested', 'Revision requested'],
  ['approved', 'Approved'],
  ['posted', 'Posted'],
  ['paid', 'Paid'],
  ['rejected', 'Rejected'],
  ['blacklisted', 'Blacklisted'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const statusIndex = (s) => STATUSES.findIndex(([k]) => k === s);

const PLATFORMS = [['tiktok', 'TikTok'], ['instagram', 'Instagram']];
const GOALS = [
  ['app_signups', 'App signups'],
  ['website_signups', 'Website signups'],
  ['listens', 'Listens'],
  ['viral_reach', 'Viral reach'],
  ['paid_whitelisting', 'Paid ad whitelisting'],
];
const CONTACT_METHODS = [
  ['', '—'], ['email', 'Email'], ['dm', 'DM'], ['agency', 'Agency'], ['other', 'Other'],
];
const USAGE_RIGHTS = [
  ['organic_only', 'Organic only'],
  ['paid_ads_allowed', 'Paid ads allowed'],
  ['whitelisting_allowed', 'Whitelisting allowed'],
];
const USAGE_PERIODS = [['30_days', '30 days'], ['90_days', '90 days'], ['unlimited', 'Unlimited']];
const PAYMENT_STATUS = [['unpaid', 'Unpaid'], ['deposit_paid', 'Deposit paid'], ['paid', 'Paid']];
const CAMPAIGN_STATUS = [
  ['draft', 'Draft'], ['active', 'Active'], ['completed', 'Completed'], ['archived', 'Archived'],
];

// 8 content-brief angles from the campaign spec.
const ANGLES = [
  'You might cancel Spotify',
  "Don't try this if you want to listen to normal artists again",
  'This app makes songs that feel made for you',
  'AI music is getting scary',
  'I found a song that sounds like my exact mood',
  'This feels illegal to be free',
  'This app ruined normal music for me',
  'Send this to someone who needs a song made for their mood',
];

const DEFAULT_LANDING = 'https://boulevardai.app/';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const round1 = (n) => Math.round(n * 10) / 10;

function fmt(n) {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a % 1e6 ? 1 : 0).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a % 1e3 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
function money(n) {
  return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function pct(n) { return (Number(n) || 0).toFixed(1) + '%'; }
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}
function slug(s) {
  return String(s || '').toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'creator';
}
function platformWord(p) { return p === 'instagram' ? 'Reel' : 'TikTok'; }
function platLabel(p) {
  return p === 'tiktok' ? 'TikTok' : p === 'instagram' ? 'Instagram' : 'Both';
}

// ---------------------------------------------------------------------------
// Scoring — weights: view/follower 35, engagement 20, audience fit 20,
// content quality 15, cost efficiency 10. Curve constants live here so the
// formula is easy to retune.
// ---------------------------------------------------------------------------
function ratios(c) {
  const followers = num(c.followers), views = num(c.avg_views);
  const ratio = followers > 0 ? views / followers : 0;
  const eng = views > 0 ? (num(c.avg_likes) + num(c.avg_comments)) / views : 0;
  return { ratio, eng };
}
// 5k-250k followers is the underpriced "viral testing" sweet spot.
function inSweetSpot(c) {
  const f = num(c.followers);
  return f >= 5000 && f <= 250000;
}
function costEfficiencyProxy(c) {
  const f = num(c.followers);
  if (f >= 5000 && f <= 250000) return 100;        // sweet spot
  if (f < 5000) return f <= 0 ? 40 : 40 + (f / 5000) * 40;   // 40..80 ramp
  return clamp(100 - ((f - 250000) / 250000) * 35, 30, 100); // decay past 250k
}
function scoreCreator(c) {
  const { ratio, eng } = ratios(c);
  const ratioPts = clamp((ratio / 2) * 100, 0, 100);   // views = 2x followers => 100
  const engPts = clamp((eng / 0.12) * 100, 0, 100);    // 12% engagement => 100
  const fitPts = clamp(num(c.audience_fit ?? 60), 0, 100);
  const qualPts = clamp(num(c.content_quality ?? 60), 0, 100);
  const costPts = costEfficiencyProxy(c);
  const breakdown = {
    view_follower_ratio: round1(0.35 * ratioPts),
    engagement_rate: round1(0.20 * engPts),
    audience_fit: round1(0.20 * fitPts),
    content_quality: round1(0.15 * qualPts),
    cost_efficiency: round1(0.10 * costPts),
  };
  const score = clamp(Math.round(
    breakdown.view_follower_ratio + breakdown.engagement_rate + breakdown.audience_fit +
    breakdown.content_quality + breakdown.cost_efficiency), 0, 100);
  const label = score >= 85 ? 'priority' : score >= 70 ? 'good_test'
    : score >= 50 ? 'maybe' : 'skip';
  return { score, score_label: label, score_breakdown: breakdown };
}
const SCORE_LABEL_TEXT = {
  priority: 'Priority creator', good_test: 'Good test', maybe: 'Maybe', skip: 'Skip',
};

// ---------------------------------------------------------------------------
// Outreach message generation — casual, non-corporate, native-feeling.
// ---------------------------------------------------------------------------
function genMessage(creator, channel, campaign, variant = 0) {
  const name = firstName(creator.creator_name) || creator.username || 'there';
  const pw = platformWord(creator.platform);
  const dmTemplates = [
    `Yo ${name}, your videos fit exactly what we're looking for. We're launching a new music app where people find AI-generated songs that feel like they were made for them. Want to pay you for a simple ${pw} testing it. No polished ad — just a raw video that feels like something you'd send a friend. Interested?`,
    `Hey ${name} — been watching your stuff and the vibe is perfect for this. We're launching Boulevard, a music app where you discover AI songs that feel weirdly personal. Looking to pay you for one raw ${pw} of you just trying it. Nothing scripted, nothing salesy. You down?`,
    `${name} hey! Quick one — we're launching a music app (Boulevard) where the songs feel made for your exact mood. Your content style is exactly the energy we want. We'd pay you a flat fee for one native ${pw} testing it — the kind of video you'd send a friend, not an ad. Want details?`,
  ];
  if (channel === 'email') {
    const subject = `Paid ${pw} collab — Boulevard (raw, non-ad)`;
    const body =
      `Hi ${name},\n\n` +
      `I'll keep this short. We're launching Boulevard — a music app where people discover ` +
      `AI-generated songs that feel weirdly personal and addictive.\n\n` +
      `Your content stood out: it feels personal and real, not like an ad — which is exactly ` +
      `what we want. We'd love to pay you a flat fee for one ${pw} of you genuinely trying it. ` +
      `No script, no polished ad — just a raw video that feels like something you'd send a friend.\n\n` +
      (campaign ? `Campaign: ${campaign.name}. ` : '') +
      `If you're open to it, reply and I'll send the fee + a simple brief.\n\n` +
      `Thanks,\nBoulevard team`;
    return `Subject: ${subject}\n\n${body}`;
  }
  return dmTemplates[variant % dmTemplates.length];
}

// ---------------------------------------------------------------------------
// Content-brief generation — native, non-corporate, hook-first.
// ---------------------------------------------------------------------------
const ANGLE_DETAIL = {
  'You might cancel Spotify': {
    hook: "I don't think I need Spotify anymore...",
    cta: 'try it, it\'s free',
    caption: 'not saying cancel your subscription but… 👀 #boulevard',
  },
  "Don't try this if you want to listen to normal artists again": {
    hook: "do NOT download this app if you still want to enjoy normal music",
    cta: 'search Boulevard if you\'re brave',
    caption: "you've been warned 😭 #aimusic",
  },
  'This app makes songs that feel made for you': {
    hook: 'this app just made a song that sounds like it knows me',
    cta: 'listen for free and see',
    caption: 'how did it KNOW 😨',
  },
  'AI music is getting scary': {
    hook: 'ok AI music is officially getting scary good',
    cta: 'try it before it gets weirder',
    caption: 'we are not ready for this 💀',
  },
  'I found a song that sounds like my exact mood': {
    hook: 'I found a song that sounds like my exact mood right now',
    cta: 'go find yours, it\'s free',
    caption: 'this is literally my brain in a song',
  },
  'This feels illegal to be free': {
    hook: 'this app feels illegal to be free honestly',
    cta: 'get it free while it still is',
    caption: 'why is this free 😭 #boulevard',
  },
  'This app ruined normal music for me': {
    hook: 'this app low-key ruined normal music for me',
    cta: 'don\'t download it unless you want to get addicted',
    caption: 'no going back fr',
  },
  'Send this to someone who needs a song made for their mood': {
    hook: 'send this to someone who needs a song made for exactly how they feel',
    cta: 'make them try it',
    caption: 'tag someone who needs this 🤍',
  },
};
function genBrief(creator, angle) {
  const d = ANGLE_DETAIL[angle] || { hook: angle, cta: 'try it', caption: angle };
  const pw = platformWord(creator.platform);
  const who = creator.creator_name || ('@' + creator.username);
  return (
`CONTENT BRIEF — ${who} (${platLabel(creator.platform)})
Angle: "${angle}"

THE HOOK (first 1-2 seconds)
Open mid-thought, like you're already talking to a friend:
  "${d.hook}"
No "hey guys", no intro. The very first frame has to make someone stop scrolling.

THE FEEL
Raw, native ${pw} content. Filmed like you're sending it to one person.
Personal, a little emotional, slightly obsessed. You DISCOVERED something —
you are not advertising it. It should not feel scripted.

WHAT TO SHOW
- You opening Boulevard and a song appearing that fits your exact mood.
- Your genuine, unfiltered reaction (the song feels made for you).
- A few seconds of the audio so people actually hear it.

WHAT TO AVOID
- No corporate ad tone. No feature list. Don't over-explain the app.
- No "link in bio, use my code" energy. Don't read a script to camera.
- Nothing polished — if it looks like an ad, it failed.

CTA (say it casually, once)
  "${d.cta}"

CAPTION IDEA
  ${d.caption}

DELIVERABLE
One ${pw}, native style, hook in the first 1-2 seconds, strong emotional
reaction, clear casual CTA. Filmed like a video you'd send a friend.`
  );
}

// ---------------------------------------------------------------------------
// Tracking links
// ---------------------------------------------------------------------------
function buildTrackingLink(campaign, creator) {
  const base = (campaign.landing_page_url || '').trim() || DEFAULT_LANDING;
  let u;
  try { u = new URL(base); } catch { u = new URL(DEFAULT_LANDING); }
  u.searchParams.set('utm_source', campaign.utm_source || creator.platform || 'tiktok');
  u.searchParams.set('utm_campaign', campaign.utm_campaign || slug(campaign.name));
  u.searchParams.set('utm_creator', slug(creator.username));
  return u.toString();
}

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------
async function loadAll() {
  const [cr, ca, de, ou] = await Promise.all([
    sb.from('influencer_creators').select('*').order('score', { ascending: false }),
    sb.from('influencer_campaigns').select('*').order('created_at', { ascending: false }),
    sb.from('influencer_deals').select('*').order('created_at', { ascending: false }),
    sb.from('influencer_outreach').select('*').order('created_at', { ascending: false }),
  ]);
  for (const r of [cr, ca, de, ou]) if (r.error) throw new Error(r.error.message);
  state.creators = cr.data || [];
  state.campaigns = ca.data || [];
  state.deals = de.data || [];
  state.outreach = ou.data || [];
}
async function refresh() {
  await loadAll();
  selectTab(state.tab);
}

const CREATOR_COLS = ['platform', 'creator_name', 'username', 'profile_url', 'followers',
  'avg_views', 'avg_likes', 'avg_comments', 'audience_fit', 'content_quality', 'score',
  'score_label', 'score_breakdown', 'niche', 'country', 'language', 'audience_age',
  'audience_gender', 'contact_method', 'contact_info', 'notes', 'status', 'last_contacted_at',
  'next_follow_up_at', 'can_use_as_ad', 'can_edit_video', 'can_use_handle', 'ad_usage_duration',
  'ad_extra_fee', 'spark_ads_code', 'meta_partnership_access'];
const CAMPAIGN_COLS = ['name', 'platform', 'goal', 'budget', 'target_creators', 'target_cpa',
  'target_cpm', 'target_cost_per_signup', 'target_view_follower_ratio', 'start_date', 'end_date',
  'brief', 'landing_page_url', 'tracking_link', 'utm_source', 'utm_campaign', 'status'];
const DEAL_COLS = ['campaign_id', 'creator_id', 'agreed_fee', 'deliverables', 'num_posts',
  'usage_rights', 'usage_period', 'payment_status', 'payment_method', 'invoice_url',
  'content_deadline', 'posting_deadline', 'utm_creator', 'tracking_link', 'posted_url',
  'final_views', 'final_likes', 'final_comments', 'final_shares', 'final_saves', 'signups',
  'brief_angle', 'content_brief', 'notes'];

function pick(obj, cols) {
  const out = {};
  for (const k of cols) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

async function saveCreator(data, id) {
  const payload = pick({ ...data, ...scoreCreator(data) }, CREATOR_COLS);
  const q = id
    ? sb.from('influencer_creators').update(payload).eq('id', id)
    : sb.from('influencer_creators').insert(payload);
  const { error } = await q;
  if (error) throw new Error(error.message);
}
async function updateCreator(id, patch) {
  // Re-score if any score input changed.
  if (['followers', 'avg_views', 'avg_likes', 'avg_comments', 'audience_fit', 'content_quality']
      .some((k) => k in patch)) {
    const cur = state.creators.find((c) => c.id === id) || {};
    Object.assign(patch, scoreCreator({ ...cur, ...patch }));
  }
  const { error } = await sb.from('influencer_creators')
    .update(pick(patch, CREATOR_COLS)).eq('id', id);
  if (error) throw new Error(error.message);
}
async function saveCampaign(data, id) {
  const payload = pick(data, CAMPAIGN_COLS);
  const q = id
    ? sb.from('influencer_campaigns').update(payload).eq('id', id)
    : sb.from('influencer_campaigns').insert(payload);
  const { error } = await q;
  if (error) throw new Error(error.message);
}
async function saveDeal(data, id) {
  const payload = pick(data, DEAL_COLS);
  const q = id
    ? sb.from('influencer_deals').update(payload).eq('id', id)
    : sb.from('influencer_deals').insert(payload);
  const { error } = await q;
  if (error) throw new Error(error.message);
}
async function logOutreach(row) {
  const { error } = await sb.from('influencer_outreach').insert(pick(row,
    ['creator_id', 'campaign_id', 'channel', 'message', 'sent', 'sent_at', 'follow_up_at',
      'response_status', 'response_notes']));
  if (error) throw new Error(error.message);
}

// Per-creator rollup of deal performance.
function creatorRoll(creatorId) {
  const deals = state.deals.filter((d) => d.creator_id === creatorId);
  let spend = 0, views = 0, signups = 0, paid = false, posted = false;
  for (const d of deals) {
    spend += Number(d.agreed_fee) || 0;
    views += num(d.final_views);
    signups += num(d.signups);
    if (d.payment_status === 'paid') paid = true;
    if (d.posted_url) posted = true;
  }
  return { deals, spend, views, signups, paid, posted };
}
const campaignName = (id) => (state.campaigns.find((c) => c.id === id) || {}).name || '—';
const creatorById = (id) => state.creators.find((c) => c.id === id) || null;

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------
export function mountInfluencers(container, ctx) {
  sb = ctx.supabase;
  toast = ctx.toast || (() => {});
  rootEl = container;
  ensureStyles();
  container.innerHTML = `
    <div class="inf">
      <div class="inf-tabs">
        <button class="inf-tab" data-tab="creators">Creators</button>
        <button class="inf-tab" data-tab="pipeline">Pipeline</button>
        <button class="inf-tab" data-tab="campaigns">Campaigns</button>
        <button class="inf-tab" data-tab="dashboard">Dashboard</button>
      </div>
      <div id="inf-content"><div class="inf-empty">loading influencer data…</div></div>
    </div>`;
  container.querySelectorAll('.inf-tab').forEach((b) => {
    b.onclick = () => selectTab(b.dataset.tab);
  });
  loadAll().then(() => selectTab(state.tab)).catch((e) => {
    container.querySelector('#inf-content').innerHTML =
      `<div class="inf-empty">failed to load: ${esc(e.message)}<br>
       <span style="font-size:13px">run the migration sql/2026-05-18_influencer_campaigns.sql first.</span></div>`;
  });
}

function ensureStyles() {
  if (document.getElementById('inf-css')) return;
  const link = document.createElement('link');
  link.id = 'inf-css';
  link.rel = 'stylesheet';
  link.href = '/admin/influencers.css';
  document.head.appendChild(link);
}

function selectTab(tab) {
  state.tab = tab;
  rootEl.querySelectorAll('.inf-tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
  const c = rootEl.querySelector('#inf-content');
  if (tab === 'creators') renderCreators(c);
  else if (tab === 'pipeline') renderPipeline(c);
  else if (tab === 'campaigns') renderCampaigns(c);
  else renderDashboard(c);
}

// ---------------------------------------------------------------------------
// Modal helper (reuses .modal-backdrop / .modal styles from index.html)
// ---------------------------------------------------------------------------
function modal({ title, wide, body, foot }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
      <div class="head"><h2>${esc(title)}</h2><button class="close" aria-label="Close">×</button></div>
      <div class="body">${body || ''}</div>
      ${foot ? `<div class="foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(backdrop);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.close').onclick = close;
  document.addEventListener('keydown', onKey);
  return {
    close,
    q: (s) => backdrop.querySelector(s),
    qa: (s) => [...backdrop.querySelectorAll(s)],
    setBody: (html) => { backdrop.querySelector('.body').innerHTML = html; },
    el: backdrop,
  };
}

// Form field builders.
function field(label, name, value, opts = {}) {
  const full = opts.full ? ' full' : '';
  if (opts.options) {
    return `<div class="fld${full}"><label>${esc(label)}</label>
      <select name="${name}">${opts.options.map(([v, l]) =>
        `<option value="${esc(v)}"${String(value ?? '') === String(v) ? ' selected' : ''}>${esc(l)}</option>`)
        .join('')}</select></div>`;
  }
  if (opts.type === 'textarea') {
    return `<div class="fld${full}"><label>${esc(label)}</label>
      <textarea name="${name}" placeholder="${esc(opts.ph || '')}"
        ${opts.rows ? `rows="${opts.rows}"` : ''}>${esc(value ?? '')}</textarea></div>`;
  }
  if (opts.type === 'checkbox') {
    return `<div class="fld check"><input type="checkbox" name="${name}" id="f-${name}"
      ${value ? 'checked' : ''}><label for="f-${name}">${esc(label)}</label></div>`;
  }
  return `<div class="fld${full}"><label>${esc(label)}</label>
    <input type="${opts.type || 'text'}" name="${name}" value="${esc(value ?? '')}"
      placeholder="${esc(opts.ph || '')}"></div>`;
}
function readForm(scope) {
  const out = {};
  scope.querySelectorAll('[name]').forEach((el) => {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return out;
}
function sectionHead(label) { return `<div class="form-section">${esc(label)}</div>`; }

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('copied'),
    () => toast('copy failed'));
}

// ===========================================================================
// CREATORS TAB
// ===========================================================================
function renderCreators(c) {
  const f = state.filters;
  c.innerHTML = `
    <div class="inf-head">
      <h2>Creators</h2>
      <span class="sub" id="cr-count"></span>
      <div class="inf-spacer"></div>
      <button class="btn" id="cr-import">Import CSV</button>
      <button class="btn primary" id="cr-add">+ Add creator</button>
    </div>
    <div class="inf-filters">
      <input id="fl-search" placeholder="search name / handle" value="${esc(f.search || '')}">
      <select id="fl-platform">
        <option value="">all platforms</option>
        ${PLATFORMS.map(([v, l]) => `<option value="${v}"${f.platform === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <select id="fl-status">
        <option value="">all statuses</option>
        ${STATUSES.map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <input id="fl-country" placeholder="country" value="${esc(f.country || '')}">
      <input id="fl-niche" placeholder="niche" value="${esc(f.niche || '')}">
      <div class="grp"><span style="color:var(--muted);font-size:12px">followers</span>
        <input class="num" id="fl-fmin" type="number" placeholder="min" value="${f.fmin ?? ''}">
        <input class="num" id="fl-fmax" type="number" placeholder="max" value="${f.fmax ?? ''}"></div>
      <div class="grp"><span style="color:var(--muted);font-size:12px">views</span>
        <input class="num" id="fl-vmin" type="number" placeholder="min" value="${f.vmin ?? ''}">
        <input class="num" id="fl-vmax" type="number" placeholder="max" value="${f.vmax ?? ''}"></div>
      <div class="grp"><span style="color:var(--muted);font-size:12px">min ratio</span>
        <input class="num" id="fl-ratio" type="number" step="0.1" placeholder="0" value="${f.ratioMin ?? ''}"></div>
      <div class="grp"><span style="color:var(--muted);font-size:12px">min score</span>
        <input class="num" id="fl-score" type="number" placeholder="0" value="${f.scoreMin ?? ''}"></div>
      <select id="fl-contacted">
        <option value="">contacted: any</option>
        <option value="yes"${f.contacted === 'yes' ? ' selected' : ''}>contacted</option>
        <option value="no"${f.contacted === 'no' ? ' selected' : ''}>not contacted</option>
      </select>
      <select id="fl-replied">
        <option value="">replied: any</option>
        <option value="yes"${f.replied === 'yes' ? ' selected' : ''}>replied</option>
        <option value="no"${f.replied === 'no' ? ' selected' : ''}>no reply</option>
      </select>
      <select id="fl-paid">
        <option value="">paid: any</option>
        <option value="yes"${f.paid === 'yes' ? ' selected' : ''}>paid</option>
        <option value="no"${f.paid === 'no' ? ' selected' : ''}>not paid</option>
      </select>
      <select id="fl-posted">
        <option value="">posted: any</option>
        <option value="yes"${f.posted === 'yes' ? ' selected' : ''}>posted</option>
        <option value="no"${f.posted === 'no' ? ' selected' : ''}>not posted</option>
      </select>
      <select id="fl-ad">
        <option value="">ads: any</option>
        <option value="yes"${f.canAd === 'yes' ? ' selected' : ''}>can use for ads</option>
        <option value="no"${f.canAd === 'no' ? ' selected' : ''}>no ad rights</option>
      </select>
      <button class="btn sm" id="fl-clear">Clear</button>
    </div>
    <div id="cr-table"></div>`;

  c.querySelector('#cr-add').onclick = () => openCreatorForm(null);
  c.querySelector('#cr-import').onclick = openCsvImport;
  const apply = () => {
    state.filters = {
      search: c.querySelector('#fl-search').value.trim(),
      platform: c.querySelector('#fl-platform').value,
      status: c.querySelector('#fl-status').value,
      country: c.querySelector('#fl-country').value.trim(),
      niche: c.querySelector('#fl-niche').value.trim(),
      fmin: numOrNull(c.querySelector('#fl-fmin').value),
      fmax: numOrNull(c.querySelector('#fl-fmax').value),
      vmin: numOrNull(c.querySelector('#fl-vmin').value),
      vmax: numOrNull(c.querySelector('#fl-vmax').value),
      ratioMin: numOrNull(c.querySelector('#fl-ratio').value),
      scoreMin: numOrNull(c.querySelector('#fl-score').value),
      contacted: c.querySelector('#fl-contacted').value,
      replied: c.querySelector('#fl-replied').value,
      paid: c.querySelector('#fl-paid').value,
      posted: c.querySelector('#fl-posted').value,
      canAd: c.querySelector('#fl-ad').value,
    };
    paintCreatorTable(c);
  };
  c.querySelectorAll('.inf-filters input, .inf-filters select').forEach((el) => {
    el.addEventListener('change', apply);
    if (el.tagName === 'INPUT') el.addEventListener('keyup', (e) => { if (e.key === 'Enter') apply(); });
  });
  c.querySelector('#fl-clear').onclick = () => { state.filters = {}; renderCreators(c); };
  paintCreatorTable(c);
}

function applyFilters(list) {
  const f = state.filters;
  const repliedSet = new Set(state.outreach
    .filter((o) => o.response_status === 'replied').map((o) => o.creator_id));
  const sentSet = new Set(state.outreach.filter((o) => o.sent).map((o) => o.creator_id));
  return list.filter((c) => {
    if (f.platform && c.platform !== f.platform) return false;
    if (f.status && c.status !== f.status) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      if (!(c.creator_name || '').toLowerCase().includes(q) &&
          !(c.username || '').toLowerCase().includes(q)) return false;
    }
    if (f.country && !(c.country || '').toLowerCase().includes(f.country.toLowerCase())) return false;
    if (f.niche && !(c.niche || '').toLowerCase().includes(f.niche.toLowerCase())) return false;
    if (f.fmin != null && num(c.followers) < f.fmin) return false;
    if (f.fmax != null && num(c.followers) > f.fmax) return false;
    if (f.vmin != null && num(c.avg_views) < f.vmin) return false;
    if (f.vmax != null && num(c.avg_views) > f.vmax) return false;
    if (f.ratioMin != null && Number(c.view_follower_ratio || 0) < f.ratioMin) return false;
    if (f.scoreMin != null && num(c.score) < f.scoreMin) return false;
    const contacted = !!c.last_contacted_at || sentSet.has(c.id) ||
      statusIndex(c.status) >= statusIndex('contacted') && statusIndex(c.status) <= statusIndex('paid');
    if (f.contacted === 'yes' && !contacted) return false;
    if (f.contacted === 'no' && contacted) return false;
    const replied = repliedSet.has(c.id) ||
      (statusIndex(c.status) >= statusIndex('replied') && statusIndex(c.status) <= statusIndex('paid'));
    if (f.replied === 'yes' && !replied) return false;
    if (f.replied === 'no' && replied) return false;
    const roll = creatorRoll(c.id);
    if (f.paid === 'yes' && !roll.paid) return false;
    if (f.paid === 'no' && roll.paid) return false;
    if (f.posted === 'yes' && !roll.posted) return false;
    if (f.posted === 'no' && roll.posted) return false;
    if (f.canAd === 'yes' && !c.can_use_as_ad) return false;
    if (f.canAd === 'no' && c.can_use_as_ad) return false;
    return true;
  });
}

function scoreBadge(c) {
  return `<span class="score-badge score-${c.score_label || 'maybe'}"
    title="${esc(SCORE_LABEL_TEXT[c.score_label] || '')}">${num(c.score)}</span>`;
}
function statusPill(s) {
  return `<span class="status-pill status-${s}">${esc(STATUS_LABEL[s] || s)}</span>`;
}
function platBadge(p) { return `<span class="plat plat-${p}">${esc(p)}</span>`; }

function paintCreatorTable(c) {
  const rows = applyFilters(state.creators);
  c.querySelector('#cr-count').textContent =
    `${rows.length} of ${state.creators.length}`;
  const wrap = c.querySelector('#cr-table');
  if (!state.creators.length) {
    wrap.innerHTML = `<div class="inf-empty">No creators yet. Add one or import a CSV.</div>`;
    return;
  }
  if (!rows.length) {
    wrap.innerHTML = `<div class="inf-empty">No creators match the filters.</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="inf-table-wrap">
      <table class="inf-table">
        <thead><tr>
          <th>Creator</th><th>Platform</th><th>Followers</th><th>Avg views</th>
          <th>Ratio</th><th>Eng.</th><th>Score</th><th>Status</th><th>Niche</th><th>Country</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-id="${r.id}">
              <td><div class="cell-creator">
                <span class="nm">${esc(r.creator_name || r.username)}
                  ${inSweetSpot(r) ? '<span class="sweet">sweet spot</span>' : ''}</span>
                <span class="hd">@${esc(r.username)}</span>
              </div></td>
              <td>${platBadge(r.platform)}</td>
              <td class="num">${fmt(r.followers)}</td>
              <td class="num">${fmt(r.avg_views)}</td>
              <td class="num">${Number(r.view_follower_ratio || 0).toFixed(2)}×</td>
              <td class="num">${pct(Number(r.engagement_rate || 0) * 100)}</td>
              <td>${scoreBadge(r)}</td>
              <td>${statusPill(r.status)}</td>
              <td>${esc(r.niche || '—')}</td>
              <td>${esc(r.country || '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  wrap.querySelectorAll('tbody tr').forEach((tr) => {
    tr.onclick = () => openCreatorDetail(tr.dataset.id);
  });
}

// ---------------------------------------------------------------------------
// Add / edit creator form
// ---------------------------------------------------------------------------
function openCreatorForm(creator) {
  const c = creator || {};
  const m = modal({
    title: creator ? 'Edit creator' : 'Add creator',
    wide: true,
    body: `<form id="cr-form" class="form-grid">
      ${field('Platform', 'platform', c.platform || 'tiktok', { options: PLATFORMS })}
      ${field('Status', 'status', c.status || 'discovered', { options: STATUSES })}
      ${field('Creator name', 'creator_name', c.creator_name)}
      ${field('Username / handle', 'username', c.username, { ph: 'without @' })}
      ${field('Profile URL', 'profile_url', c.profile_url, { full: true })}
      ${field('Followers', 'followers', c.followers ?? '', { type: 'number' })}
      ${field('Avg views per video', 'avg_views', c.avg_views ?? '', { type: 'number' })}
      ${field('Avg likes', 'avg_likes', c.avg_likes ?? '', { type: 'number' })}
      ${field('Avg comments', 'avg_comments', c.avg_comments ?? '', { type: 'number' })}
      ${field('Audience fit (0-100)', 'audience_fit', c.audience_fit ?? 60, { type: 'number' })}
      ${field('Content quality (0-100)', 'content_quality', c.content_quality ?? 60, { type: 'number' })}
      ${field('Niche / category', 'niche', c.niche)}
      ${field('Country', 'country', c.country)}
      ${field('Language', 'language', c.language)}
      ${field('Audience age estimate', 'audience_age', c.audience_age, { ph: 'e.g. 18-24' })}
      ${field('Audience gender estimate', 'audience_gender', c.audience_gender, { ph: 'e.g. 60% F' })}
      ${field('Contact method', 'contact_method', c.contact_method || '', { options: CONTACT_METHODS })}
      ${field('Contact info', 'contact_info', c.contact_info)}
      ${field('Notes', 'notes', c.notes, { type: 'textarea', full: true })}
      <div class="score-preview" id="score-preview"></div>
      ${sectionHead('Ad usage / whitelisting')}
      ${field('Can use content as paid ad', 'can_use_as_ad', !!c.can_use_as_ad, { type: 'checkbox' })}
      ${field('Can edit the video', 'can_edit_video', !!c.can_edit_video, { type: 'checkbox' })}
      ${field('Can use creator handle / name', 'can_use_handle', !!c.can_use_handle, { type: 'checkbox' })}
      ${field('Ad usage duration', 'ad_usage_duration', c.ad_usage_duration, { ph: 'e.g. 90 days' })}
      ${field('Extra fee for paid usage', 'ad_extra_fee', c.ad_extra_fee ?? '', { type: 'number' })}
      ${field('Spark Ads code / whitelisting access', 'spark_ads_code', c.spark_ads_code)}
      ${field('Meta partnership ad access', 'meta_partnership_access', c.meta_partnership_access)}
    </form>`,
    foot: `<button class="btn" id="cr-cancel">Cancel</button>
           <button class="btn primary" id="cr-save">${creator ? 'Save' : 'Add creator'}</button>`,
  });

  const form = m.q('#cr-form');
  const repaintScore = () => {
    const d = readForm(form);
    const sc = scoreCreator({
      followers: d.followers, avg_views: d.avg_views, avg_likes: d.avg_likes,
      avg_comments: d.avg_comments, audience_fit: d.audience_fit, content_quality: d.content_quality,
    });
    const b = sc.score_breakdown;
    const bars = [
      ['View/follower ratio', b.view_follower_ratio, 35],
      ['Engagement', b.engagement_rate, 20],
      ['Audience fit', b.audience_fit, 20],
      ['Content quality', b.content_quality, 15],
      ['Cost efficiency', b.cost_efficiency, 10],
    ];
    m.q('#score-preview').innerHTML = `
      <div style="text-align:center">
        <div class="score-badge score-${sc.score_label}" style="font-size:18px;padding:7px 14px">${sc.score}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:5px">${SCORE_LABEL_TEXT[sc.score_label]}</div>
      </div>
      <div class="score-bars">
        ${bars.map(([n, v, max]) => `
          <div class="score-bar"><span class="bn">${n}</span>
            <span class="bt"><span class="bf" style="width:${(v / max) * 100}%"></span></span>
            <span class="bv">${v}</span></div>`).join('')}
      </div>`;
  };
  form.addEventListener('input', repaintScore);
  repaintScore();

  m.q('#cr-cancel').onclick = m.close;
  m.q('#cr-save').onclick = async () => {
    const d = readForm(form);
    if (!d.username.trim()) { toast('username required'); return; }
    const btn = m.q('#cr-save'); btn.disabled = true;
    try {
      await saveCreator({
        platform: d.platform,
        status: d.status,
        creator_name: d.creator_name.trim(),
        username: d.username.trim().replace(/^@+/, ''),
        profile_url: d.profile_url.trim() || null,
        followers: num(d.followers),
        avg_views: num(d.avg_views),
        avg_likes: num(d.avg_likes),
        avg_comments: num(d.avg_comments),
        audience_fit: clamp(num(d.audience_fit), 0, 100),
        content_quality: clamp(num(d.content_quality), 0, 100),
        niche: d.niche.trim() || null,
        country: d.country.trim() || null,
        language: d.language.trim() || null,
        audience_age: d.audience_age.trim() || null,
        audience_gender: d.audience_gender.trim() || null,
        contact_method: d.contact_method || null,
        contact_info: d.contact_info.trim() || null,
        notes: d.notes.trim() || null,
        can_use_as_ad: d.can_use_as_ad,
        can_edit_video: d.can_edit_video,
        can_use_handle: d.can_use_handle,
        ad_usage_duration: d.ad_usage_duration.trim() || null,
        ad_extra_fee: numOrNull(d.ad_extra_fee),
        spark_ads_code: d.spark_ads_code.trim() || null,
        meta_partnership_access: d.meta_partnership_access.trim() || null,
      }, creator ? creator.id : null);
      toast(creator ? 'creator updated' : 'creator added');
      m.close();
      await refresh();
    } catch (e) {
      toast('error: ' + e.message);
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Creator detail
// ---------------------------------------------------------------------------
function openCreatorDetail(creatorId) {
  const m = modal({ title: 'Creator', wide: true, body: '<div class="inf-empty">…</div>' });
  paintCreatorDetail(m, creatorId);
}
function paintCreatorDetail(m, creatorId) {
  const c = creatorById(creatorId);
  if (!c) { m.setBody('<div class="inf-empty">creator not found</div>'); return; }
  const roll = creatorRoll(creatorId);
  const b = c.score_breakdown || {};
  const outreach = state.outreach.filter((o) => o.creator_id === creatorId);
  m.el.querySelector('.head h2').textContent = c.creator_name || ('@' + c.username);

  const dstat = (v, l) => `<div class="dstat"><div class="dv">${v}</div><div class="dl">${esc(l)}</div></div>`;
  m.setBody(`
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      ${platBadge(c.platform)} ${statusPill(c.status)} ${scoreBadge(c)}
      <span style="color:var(--muted);font-size:12px">${SCORE_LABEL_TEXT[c.score_label] || ''}</span>
      ${inSweetSpot(c) ? '<span class="sweet">sweet spot</span>' : ''}
      ${c.profile_url ? `<a href="${esc(c.profile_url)}" target="_blank" rel="noopener"
        style="color:var(--gold);font-size:12px">profile ↗</a>` : ''}
    </div>
    <div class="detail-grid">
      ${dstat('@' + esc(c.username), 'Handle')}
      ${dstat(fmt(c.followers), 'Followers')}
      ${dstat(fmt(c.avg_views), 'Avg views')}
      ${dstat(Number(c.view_follower_ratio || 0).toFixed(2) + '×', 'View/follower ratio')}
      ${dstat(pct(Number(c.engagement_rate || 0) * 100), 'Engagement rate')}
      ${dstat(fmt(c.avg_likes), 'Avg likes')}
      ${dstat(fmt(c.avg_comments), 'Avg comments')}
      ${dstat(esc(c.niche || '—'), 'Niche')}
      ${dstat(esc(c.country || '—'), 'Country')}
      ${dstat(esc(c.language || '—'), 'Language')}
      ${dstat(esc(c.audience_age || '—'), 'Audience age')}
      ${dstat(esc(c.audience_gender || '—'), 'Audience gender')}
    </div>
    <div class="panel">
      <h3>Score breakdown · ${num(c.score)}/100</h3>
      <div class="score-bars">
        ${[['View/follower ratio', b.view_follower_ratio || 0, 35],
           ['Engagement', b.engagement_rate || 0, 20],
           ['Audience fit', b.audience_fit || 0, 20],
           ['Content quality', b.content_quality || 0, 15],
           ['Cost efficiency', b.cost_efficiency || 0, 10]]
          .map(([n, v, max]) => `<div class="score-bar"><span class="bn">${n}</span>
            <span class="bt"><span class="bf" style="width:${(v / max) * 100}%"></span></span>
            <span class="bv">${v}</span></div>`).join('')}
      </div>
    </div>
    <div class="inf-filters" style="margin-bottom:14px">
      <label>Status
        <select id="d-status">${STATUSES.map(([v, l]) =>
          `<option value="${v}"${c.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Follow-up
        <input type="date" id="d-followup" value="${esc(c.next_follow_up_at || '')}"></label>
      <span style="color:var(--muted);font-size:12px">${c.last_contacted_at
        ? 'last contacted ' + new Date(c.last_contacted_at).toLocaleDateString() : 'not contacted yet'}</span>
    </div>
    <div class="action-row">
      <button class="btn" data-act="edit">Edit</button>
      <button class="btn good" data-act="approve">Approve for outreach</button>
      <button class="btn" data-act="dm">Generate DM</button>
      <button class="btn" data-act="email">Generate email</button>
      <button class="btn" data-act="contacted">Mark contacted</button>
      <button class="btn" data-act="deal">Add deal</button>
      <button class="btn" data-act="brief">Generate brief</button>
      <button class="btn" data-act="posted">Mark posted</button>
      <button class="btn" data-act="results">Add results</button>
      <button class="btn" data-act="rebook">Rebook</button>
      <button class="btn danger" data-act="reject">Reject</button>
      <button class="btn danger" data-act="delete">Delete</button>
    </div>
    ${c.contact_info ? `<div class="panel"><h3>Contact</h3>
      <div style="font-size:13px">${esc(c.contact_method || 'contact')}: <b>${esc(c.contact_info)}</b></div></div>` : ''}
    <div class="panel">
      <h3>Ad usage / whitelisting</h3>
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)">
        <span>Paid ad: <b style="color:#fff">${c.can_use_as_ad ? 'yes' : 'no'}</b></span>
        <span>Editable: <b style="color:#fff">${c.can_edit_video ? 'yes' : 'no'}</b></span>
        <span>Use handle: <b style="color:#fff">${c.can_use_handle ? 'yes' : 'no'}</b></span>
        <span>Duration: <b style="color:#fff">${esc(c.ad_usage_duration || '—')}</b></span>
        <span>Extra fee: <b style="color:#fff">${c.ad_extra_fee != null ? money(c.ad_extra_fee) : '—'}</b></span>
        <span>Spark code: <b style="color:#fff">${esc(c.spark_ads_code || '—')}</b></span>
      </div>
    </div>
    <div class="panel">
      <h3>Deals (${roll.deals.length})</h3>
      ${roll.deals.length ? roll.deals.map((d) => dealRow(d, 'campaign')).join('')
        : '<div style="color:var(--muted);font-size:13px">No deals yet — assign this creator to a campaign.</div>'}
    </div>
    ${c.notes ? `<div class="panel"><h3>Notes</h3>
      <div style="font-size:13px;white-space:pre-wrap;color:var(--muted)">${esc(c.notes)}</div></div>` : ''}
    <div class="panel">
      <h3>Outreach history (${outreach.length})</h3>
      ${outreach.length ? outreach.map((o) => `
        <div class="deal-row"><div class="di">
          <div class="dt">${esc(channelLabel(o.channel))} · ${o.sent ? 'sent' : 'draft'}
            ${o.response_status !== 'none' ? '· ' + esc(o.response_status) : ''}</div>
          <div class="dm">${esc((o.message || '').slice(0, 110))}${(o.message || '').length > 110 ? '…' : ''}</div>
        </div>
        <span style="color:var(--muted);font-size:11px">${o.created_at
          ? new Date(o.created_at).toLocaleDateString() : ''}</span></div>`).join('')
        : '<div style="color:var(--muted);font-size:13px">No outreach logged yet.</div>'}
    </div>`);

  // Status + follow-up controls.
  m.q('#d-status').onchange = async (e) => {
    try { await updateCreator(creatorId, { status: e.target.value }); toast('status updated');
      await loadAll(); paintCreatorDetail(m, creatorId); selectTabSilent(); }
    catch (err) { toast('error: ' + err.message); }
  };
  m.q('#d-followup').onchange = async (e) => {
    try { await updateCreator(creatorId, { next_follow_up_at: e.target.value || null });
      toast('follow-up saved'); await loadAll(); }
    catch (err) { toast('error: ' + err.message); }
  };

  // Action buttons.
  m.qa('.action-row button').forEach((btn) => {
    btn.onclick = () => creatorAction(m, c, btn.dataset.act);
  });
}
function channelLabel(ch) {
  return ch === 'email' ? 'Email' : ch === 'instagram_dm' ? 'Instagram DM' : 'TikTok DM';
}
// Re-render the underlying tab without stealing focus from an open modal.
function selectTabSilent() {
  if (state.tab === 'creators') paintCreatorTable(rootEl.querySelector('#inf-content'));
}

async function creatorAction(m, c, act) {
  try {
    if (act === 'edit') { m.close(); openCreatorForm(c); return; }
    if (act === 'delete') {
      if (!confirm(`Delete ${c.creator_name || c.username}? This removes their deals too.`)) return;
      const { error } = await sb.from('influencer_creators').delete().eq('id', c.id);
      if (error) throw new Error(error.message);
      toast('creator deleted'); m.close(); await refresh(); return;
    }
    if (act === 'dm') { openOutreachComposer(c, c.platform === 'instagram' ? 'instagram_dm' : 'tiktok_dm', m); return; }
    if (act === 'email') { openOutreachComposer(c, 'email', m); return; }
    if (act === 'brief') { openBriefGenerator(c, m); return; }
    if (act === 'deal' || act === 'rebook') { openDealForm(c, null, null, m); return; }
    if (act === 'results') {
      const roll = creatorRoll(c.id);
      if (!roll.deals.length) { toast('no deal yet — add a deal first'); return; }
      if (roll.deals.length === 1) openResultsForm(roll.deals[0], m);
      else pickDeal(roll.deals, (d) => openResultsForm(d, m));
      return;
    }
    let status = null, extra = {};
    if (act === 'approve') status = 'approved_outreach';
    else if (act === 'contacted') { status = 'contacted'; extra.last_contacted_at = new Date().toISOString(); }
    else if (act === 'posted') status = 'posted';
    else if (act === 'reject') status = 'rejected';
    if (status) {
      // Don't move backwards in the pipeline for approve/contacted.
      const patch = { ...extra };
      if (['reject', 'posted'].includes(act) || statusIndex(c.status) < statusIndex(status)) {
        patch.status = status;
      } else if (extra.last_contacted_at) {
        // keep status, just stamp contact time
      }
      await updateCreator(c.id, patch);
      toast(act + 'd');
      await loadAll();
      paintCreatorDetail(m, c.id);
      selectTabSilent();
    }
  } catch (e) {
    toast('error: ' + e.message);
  }
}

function pickDeal(deals, cb) {
  const m = modal({
    title: 'Pick a deal',
    body: deals.map((d, i) => `<button class="angle-opt" data-i="${i}">
      ${esc(campaignName(d.campaign_id))} · ${money(d.agreed_fee)}</button>`).join(''),
  });
  m.qa('.angle-opt').forEach((btn) => {
    btn.onclick = () => { m.close(); cb(deals[Number(btn.dataset.i)]); };
  });
}

function dealRow(d, ctx) {
  const cr = creatorById(d.creator_id);
  const title = ctx === 'campaign'
    ? campaignName(d.campaign_id)
    : (cr ? (cr.creator_name || '@' + cr.username) : 'creator');
  return `<div class="deal-row" data-deal="${d.id}">
    <div class="di">
      <div class="dt">${esc(title)} · ${money(d.agreed_fee)} · ${esc(d.payment_status)}</div>
      <div class="dm">${num(d.num_posts)} post(s) · ${esc(d.usage_rights.replace(/_/g, ' '))}
        ${d.posted_url ? '· posted' : ''} ·
        ${fmt(d.final_views)} views · ${num(d.signups)} signups
        ${d.cost_per_signup != null ? '· ' + money(d.cost_per_signup) + '/signup' : ''}</div>
    </div>
    ${d.tracking_link ? `<button class="btn sm" data-link="${esc(d.tracking_link)}">Copy link</button>` : ''}
    <button class="btn sm" data-results="${d.id}">Results</button>
  </div>`;
}
// Wire deal-row buttons within any container after render.
function wireDealRows(scope, modalRef) {
  scope.querySelectorAll('[data-link]').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); copyText(btn.dataset.link); };
  });
  scope.querySelectorAll('[data-results]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const d = state.deals.find((x) => x.id === btn.dataset.results);
      if (d) openResultsForm(d, modalRef);
    };
  });
}

// ===========================================================================
// PIPELINE (Kanban)
// ===========================================================================
function renderPipeline(c) {
  c.innerHTML = `
    <div class="inf-head">
      <h2>Pipeline</h2>
      <span class="sub">drag a creator card between stages to update status</span>
    </div>
    <div class="kanban" id="kb"></div>`;
  const kb = c.querySelector('#kb');
  for (const [key, label] of STATUSES) {
    const list = state.creators.filter((cr) => cr.status === key);
    const col = document.createElement('div');
    col.className = 'kanban-col';
    col.dataset.status = key;
    col.innerHTML = `
      <div class="col-head">${esc(label)}<span class="ct">${list.length}</span></div>
      <div class="col-body"></div>`;
    const body = col.querySelector('.col-body');
    for (const cr of list) body.appendChild(kanbanCard(cr));
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop-on'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop-on'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop-on');
      const id = e.dataTransfer.getData('text/plain');
      const cr = creatorById(id);
      if (!cr || cr.status === key) return;
      try {
        const patch = { status: key };
        if (key === 'contacted' && !cr.last_contacted_at) patch.last_contacted_at = new Date().toISOString();
        await updateCreator(id, patch);
        toast('moved to ' + label);
        await refresh();
      } catch (err) { toast('error: ' + err.message); }
    });
    kb.appendChild(col);
  }
}
function kanbanCard(cr) {
  const card = document.createElement('div');
  card.className = 'kard';
  card.draggable = true;
  card.dataset.id = cr.id;
  card.innerHTML = `
    <div class="kn">${esc(cr.creator_name || cr.username)}</div>
    <div class="kh">@${esc(cr.username)}</div>
    <div class="kr">${platBadge(cr.platform)} ${scoreBadge(cr)}
      ${inSweetSpot(cr) ? '<span class="sweet">sweet</span>' : ''}</div>`;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', cr.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', () => openCreatorDetail(cr.id));
  return card;
}

// ===========================================================================
// CAMPAIGNS
// ===========================================================================
function renderCampaigns(c) {
  c.innerHTML = `
    <div class="inf-head">
      <h2>Campaigns</h2>
      <span class="sub">${state.campaigns.length} campaign(s)</span>
      <div class="inf-spacer"></div>
      <button class="btn primary" id="ca-add">+ New campaign</button>
    </div>
    <div id="ca-list"></div>`;
  c.querySelector('#ca-add').onclick = () => openCampaignForm(null);
  const list = c.querySelector('#ca-list');
  if (!state.campaigns.length) {
    list.innerHTML = `<div class="inf-empty">No campaigns yet.</div>`;
    return;
  }
  list.className = 'card-grid';
  list.innerHTML = state.campaigns.map((ca) => {
    const deals = state.deals.filter((d) => d.campaign_id === ca.id);
    const spend = deals.reduce((a, d) => a + (Number(d.agreed_fee) || 0), 0);
    const signups = deals.reduce((a, d) => a + num(d.signups), 0);
    return `<div class="camp-card" data-id="${ca.id}">
      <h3>${esc(ca.name)}</h3>
      <div class="cmeta">${platLabel(ca.platform)} · ${esc((GOALS.find(([g]) => g === ca.goal) || [])[1] || ca.goal)}
        · <span class="status-pill status-${ca.status === 'active' ? 'approved' : 'discovered'}">${esc(ca.status)}</span></div>
      <div class="cstats">
        <span>Budget <b>${money(ca.budget)}</b></span>
        <span>Creators <b>${deals.length}${ca.target_creators ? '/' + ca.target_creators : ''}</b></span>
        <span>Spend <b>${money(spend)}</b></span>
        <span>Signups <b>${signups}</b></span>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.camp-card').forEach((el) => {
    el.onclick = () => openCampaignDetail(el.dataset.id);
  });
}

function openCampaignForm(campaign) {
  const c = campaign || {};
  const m = modal({
    title: campaign ? 'Edit campaign' : 'New campaign',
    wide: true,
    body: `<form id="ca-form" class="form-grid">
      ${field('Campaign name', 'name', c.name, { full: true })}
      ${field('Platform', 'platform', c.platform || 'tiktok',
        { options: [...PLATFORMS, ['both', 'Both']] })}
      ${field('Goal', 'goal', c.goal || 'app_signups', { options: GOALS })}
      ${field('Budget', 'budget', c.budget ?? '', { type: 'number' })}
      ${field('Target number of creators', 'target_creators', c.target_creators ?? '', { type: 'number' })}
      ${field('Target CPA', 'target_cpa', c.target_cpa ?? '', { type: 'number' })}
      ${field('Target CPM', 'target_cpm', c.target_cpm ?? '', { type: 'number' })}
      ${field('Target cost per signup', 'target_cost_per_signup', c.target_cost_per_signup ?? '', { type: 'number' })}
      ${field('Target view/follower ratio', 'target_view_follower_ratio', c.target_view_follower_ratio ?? '', { type: 'number' })}
      ${field('Start date', 'start_date', c.start_date, { type: 'date' })}
      ${field('End date', 'end_date', c.end_date, { type: 'date' })}
      ${field('Status', 'status', c.status || 'draft', { options: CAMPAIGN_STATUS })}
      ${field('Landing page URL', 'landing_page_url', c.landing_page_url || DEFAULT_LANDING, { full: true })}
      ${field('UTM source', 'utm_source', c.utm_source, { ph: 'tiktok' })}
      ${field('UTM campaign', 'utm_campaign', c.utm_campaign, { ph: 'influencer_test_1' })}
      ${field('Brief', 'brief', c.brief, { type: 'textarea', full: true })}
    </form>`,
    foot: `<button class="btn" id="ca-cancel">Cancel</button>
           <button class="btn primary" id="ca-save">${campaign ? 'Save' : 'Create'}</button>`,
  });
  m.q('#ca-cancel').onclick = m.close;
  m.q('#ca-save').onclick = async () => {
    const d = readForm(m.q('#ca-form'));
    if (!d.name.trim()) { toast('name required'); return; }
    const btn = m.q('#ca-save'); btn.disabled = true;
    try {
      await saveCampaign({
        name: d.name.trim(),
        platform: d.platform,
        goal: d.goal,
        budget: numOrNull(d.budget) || 0,
        target_creators: num(d.target_creators),
        target_cpa: numOrNull(d.target_cpa),
        target_cpm: numOrNull(d.target_cpm),
        target_cost_per_signup: numOrNull(d.target_cost_per_signup),
        target_view_follower_ratio: numOrNull(d.target_view_follower_ratio),
        start_date: d.start_date || null,
        end_date: d.end_date || null,
        status: d.status,
        landing_page_url: d.landing_page_url.trim() || null,
        utm_source: d.utm_source.trim() || null,
        utm_campaign: d.utm_campaign.trim() || slug(d.name),
        brief: d.brief.trim() || null,
      }, campaign ? campaign.id : null);
      toast(campaign ? 'campaign saved' : 'campaign created');
      m.close();
      await refresh();
    } catch (e) { toast('error: ' + e.message); btn.disabled = false; }
  };
}

function openCampaignDetail(campaignId) {
  const m = modal({ title: 'Campaign', wide: true, body: '<div class="inf-empty">…</div>' });
  paintCampaignDetail(m, campaignId);
}
function paintCampaignDetail(m, campaignId) {
  const ca = state.campaigns.find((x) => x.id === campaignId);
  if (!ca) { m.setBody('<div class="inf-empty">campaign not found</div>'); return; }
  const deals = state.deals.filter((d) => d.campaign_id === campaignId);
  const spend = deals.reduce((a, d) => a + (Number(d.agreed_fee) || 0), 0);
  const views = deals.reduce((a, d) => a + num(d.final_views), 0);
  const signups = deals.reduce((a, d) => a + num(d.signups), 0);
  m.el.querySelector('.head h2').textContent = ca.name;
  const dstat = (v, l) => `<div class="dstat"><div class="dv">${v}</div><div class="dl">${esc(l)}</div></div>`;
  m.setBody(`
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="plat plat-${ca.platform}">${platLabel(ca.platform)}</span>
      <span class="status-pill">${esc((GOALS.find(([g]) => g === ca.goal) || [])[1] || ca.goal)}</span>
      <span class="status-pill">${esc(ca.status)}</span>
      ${ca.start_date ? `<span style="color:var(--muted);font-size:12px">${esc(ca.start_date)} → ${esc(ca.end_date || '…')}</span>` : ''}
    </div>
    <div class="detail-grid">
      ${dstat(money(ca.budget), 'Budget')}
      ${dstat(money(spend), 'Committed spend')}
      ${dstat(deals.length + (ca.target_creators ? '/' + ca.target_creators : ''), 'Creators')}
      ${dstat(fmt(views), 'Total views')}
      ${dstat(signups, 'Signups')}
      ${dstat(signups ? money(spend / signups) : '—', 'Cost / signup')}
      ${dstat(ca.target_cost_per_signup != null ? money(ca.target_cost_per_signup) : '—', 'Target / signup')}
      ${dstat(views ? money(spend / views * 1000) : '—', 'Cost / 1k views')}
    </div>
    <div class="action-row">
      <button class="btn" data-act="edit">Edit campaign</button>
      <button class="btn primary" data-act="assign">+ Assign creator</button>
      <button class="btn danger" data-act="delete">Delete</button>
    </div>
    ${ca.brief ? `<div class="panel"><h3>Brief</h3>
      <div style="font-size:13px;white-space:pre-wrap;color:var(--muted)">${esc(ca.brief)}</div></div>` : ''}
    <div class="panel">
      <h3>Creators (${deals.length})</h3>
      <div id="cd-deals">
        ${deals.length ? deals.map((d) => dealRow(d, 'creator')).join('')
          : '<div style="color:var(--muted);font-size:13px">No creators assigned yet.</div>'}
      </div>
    </div>`);

  wireDealRows(m.q('#cd-deals'), m);
  m.q('#cd-deals').querySelectorAll('.deal-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const d = state.deals.find((x) => x.id === row.dataset.deal);
      if (d) openCreatorDetail(d.creator_id);
    });
  });
  m.qa('.action-row button').forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      if (act === 'edit') { m.close(); openCampaignForm(ca); return; }
      if (act === 'assign') { openDealForm(null, ca, null, m); return; }
      if (act === 'delete') {
        if (!confirm(`Delete campaign "${ca.name}"? Its deals will be removed.`)) return;
        const { error } = await sb.from('influencer_campaigns').delete().eq('id', ca.id);
        if (error) { toast('error: ' + error.message); return; }
        toast('campaign deleted'); m.close(); await refresh();
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Deal form — assign a creator to a campaign (fixed-fee deal).
// ---------------------------------------------------------------------------
function openDealForm(creator, campaign, deal, parentModal) {
  const d = deal || {};
  // Creator picker (when opened from a campaign) or campaign picker
  // (when opened from a creator).
  let creatorField, campaignField;
  if (creator) {
    creatorField = `<input type="hidden" name="creator_id" value="${esc(creator.id)}">
      <div class="fld"><label>Creator</label>
      <input value="${esc(creator.creator_name || '@' + creator.username)}" disabled></div>`;
  } else {
    const opts = state.creators
      .filter((cr) => !campaign || !state.deals.some((x) =>
        x.campaign_id === campaign.id && x.creator_id === cr.id))
      .map((cr) => [cr.id, (cr.creator_name || '@' + cr.username) + ' · ' + cr.platform]);
    creatorField = field('Creator', 'creator_id', d.creator_id || (opts[0] || [])[0],
      { options: opts.length ? opts : [['', 'no creators available']] });
  }
  if (campaign) {
    campaignField = `<input type="hidden" name="campaign_id" value="${esc(campaign.id)}">
      <div class="fld"><label>Campaign</label>
      <input value="${esc(campaign.name)}" disabled></div>`;
  } else {
    const opts = state.campaigns.map((ca) => [ca.id, ca.name]);
    campaignField = field('Campaign', 'campaign_id', d.campaign_id || (opts[0] || [])[0],
      { options: opts.length ? opts : [['', 'create a campaign first']] });
  }

  const m = modal({
    title: deal ? 'Edit deal' : 'Assign creator',
    wide: true,
    body: `<form id="dl-form" class="form-grid">
      ${creatorField}
      ${campaignField}
      ${field('Agreed fee', 'agreed_fee', d.agreed_fee ?? '', { type: 'number' })}
      ${field('Number of TikToks / Reels', 'num_posts', d.num_posts ?? 1, { type: 'number' })}
      ${field('Deliverables', 'deliverables', d.deliverables, { type: 'textarea', full: true })}
      ${field('Usage rights', 'usage_rights', d.usage_rights || 'organic_only', { options: USAGE_RIGHTS })}
      ${field('Usage period', 'usage_period', d.usage_period || '30_days', { options: USAGE_PERIODS })}
      ${field('Payment status', 'payment_status', d.payment_status || 'unpaid', { options: PAYMENT_STATUS })}
      ${field('Payment method', 'payment_method', d.payment_method)}
      ${field('Content deadline', 'content_deadline', d.content_deadline, { type: 'date' })}
      ${field('Posting deadline', 'posting_deadline', d.posting_deadline, { type: 'date' })}
      <div class="fld full"><span class="hint">A unique tracking link is generated automatically
        from the campaign UTMs + creator handle.</span></div>
    </form>`,
    foot: `<button class="btn" id="dl-cancel">Cancel</button>
           <button class="btn primary" id="dl-save">${deal ? 'Save deal' : 'Assign'}</button>`,
  });
  m.q('#dl-cancel').onclick = m.close;
  m.q('#dl-save').onclick = async () => {
    const v = readForm(m.q('#dl-form'));
    if (!v.creator_id) { toast('pick a creator'); return; }
    if (!v.campaign_id) { toast('pick a campaign'); return; }
    const cr = creator || creatorById(v.creator_id);
    const ca = campaign || state.campaigns.find((x) => x.id === v.campaign_id);
    const link = buildTrackingLink(ca, cr);
    const btn = m.q('#dl-save'); btn.disabled = true;
    try {
      await saveDeal({
        campaign_id: v.campaign_id,
        creator_id: v.creator_id,
        agreed_fee: numOrNull(v.agreed_fee) || 0,
        num_posts: num(v.num_posts) || 1,
        deliverables: v.deliverables.trim() || null,
        usage_rights: v.usage_rights,
        usage_period: v.usage_period,
        payment_status: v.payment_status,
        payment_method: v.payment_method.trim() || null,
        content_deadline: v.content_deadline || null,
        posting_deadline: v.posting_deadline || null,
        utm_creator: slug(cr.username),
        tracking_link: link,
      }, deal ? deal.id : null);
      // Advance the creator's pipeline to "deal agreed" if still earlier.
      if (statusIndex(cr.status) < statusIndex('deal_agreed')) {
        await updateCreator(cr.id, { status: 'deal_agreed' });
      }
      toast(deal ? 'deal saved' : 'creator assigned');
      m.close();
      await loadAll();
      if (parentModal) {
        if (campaign) paintCampaignDetail(parentModal, ca.id);
        else if (creator) paintCreatorDetail(parentModal, cr.id);
      }
      selectTab(state.tab);
    } catch (e) {
      toast('error: ' + (e.message.includes('duplicate') ? 'creator already in this campaign' : e.message));
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Results form — performance + payment + invoice upload.
// ---------------------------------------------------------------------------
function openResultsForm(deal, parentModal) {
  const cr = creatorById(deal.creator_id);
  const m = modal({
    title: 'Results — ' + (cr ? (cr.creator_name || '@' + cr.username) : 'deal'),
    wide: true,
    body: `<form id="rs-form" class="form-grid">
      ${field('Posted URL', 'posted_url', deal.posted_url, { full: true })}
      ${field('Final views', 'final_views', deal.final_views ?? '', { type: 'number' })}
      ${field('Final likes', 'final_likes', deal.final_likes ?? '', { type: 'number' })}
      ${field('Final comments', 'final_comments', deal.final_comments ?? '', { type: 'number' })}
      ${field('Final shares', 'final_shares', deal.final_shares ?? '', { type: 'number' })}
      ${field('Final saves', 'final_saves', deal.final_saves ?? '', { type: 'number' })}
      ${field('Signups generated', 'signups', deal.signups ?? '', { type: 'number' })}
      ${field('Payment status', 'payment_status', deal.payment_status || 'unpaid', { options: PAYMENT_STATUS })}
      ${field('Payment method', 'payment_method', deal.payment_method)}
      <div class="fld full"><label>Invoice / receipt</label>
        <input type="file" name="invoice_file" accept="image/*,application/pdf">
        <span class="hint">${deal.invoice_url ? 'an invoice is on file — uploading replaces it'
          : 'optional — uploads to a private bucket'}</span></div>
      ${field('Invoice URL (or paste a link)', 'invoice_url',
        deal.invoice_url && !deal.invoice_url.startsWith('storage:') ? deal.invoice_url : '', { full: true })}
      ${field('Notes', 'notes', deal.notes, { type: 'textarea', full: true })}
      <div class="score-preview" id="rs-derived"></div>
    </form>`,
    foot: `<button class="btn" id="rs-cancel">Cancel</button>
           <button class="btn primary" id="rs-save">Save results</button>`,
  });
  const derived = () => {
    const v = readForm(m.q('#rs-form'));
    const fee = Number(deal.agreed_fee) || 0;
    const su = num(v.signups), vw = num(v.final_views);
    m.q('#rs-derived').innerHTML = `
      <div style="display:flex;gap:20px;font-size:13px">
        <span style="color:var(--muted)">Cost / signup
          <b style="color:#fff">${su ? money(fee / su) : '—'}</b></span>
        <span style="color:var(--muted)">Cost / 1k views
          <b style="color:#fff">${vw ? money(fee / vw * 1000) : '—'}</b></span>
      </div>`;
  };
  m.q('#rs-form').addEventListener('input', derived);
  derived();
  m.q('#rs-cancel').onclick = m.close;
  m.q('#rs-save').onclick = async () => {
    const v = readForm(m.q('#rs-form'));
    const btn = m.q('#rs-save'); btn.disabled = true;
    try {
      let invoiceUrl = v.invoice_url.trim() || (deal.invoice_url || null);
      const fileInput = m.q('[name=invoice_file]');
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (file) {
        const path = `${deal.id}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, '_')}`;
        const { error: upErr } = await sb.storage.from('influencer-invoices').upload(path, file);
        if (upErr) throw new Error('upload failed: ' + upErr.message);
        invoiceUrl = 'storage:influencer-invoices/' + path;
      }
      await saveDeal({
        posted_url: v.posted_url.trim() || null,
        final_views: num(v.final_views),
        final_likes: num(v.final_likes),
        final_comments: num(v.final_comments),
        final_shares: num(v.final_shares),
        final_saves: num(v.final_saves),
        signups: num(v.signups),
        payment_status: v.payment_status,
        payment_method: v.payment_method.trim() || null,
        invoice_url: invoiceUrl,
        notes: v.notes.trim() || null,
      }, deal.id);
      // Advance creator pipeline based on what was recorded.
      if (cr) {
        if (v.payment_status === 'paid' && statusIndex(cr.status) < statusIndex('paid')) {
          await updateCreator(cr.id, { status: 'paid' });
        } else if (v.posted_url.trim() && statusIndex(cr.status) < statusIndex('posted')) {
          await updateCreator(cr.id, { status: 'posted' });
        }
      }
      toast('results saved');
      m.close();
      await loadAll();
      if (parentModal && parentModal.el && document.body.contains(parentModal.el)) {
        const ca = parentModal.el.querySelector('.head h2');
        // Re-paint whichever detail modal is open.
        if (cr && state.campaigns.some((x) => x.name === ca?.textContent)) {
          paintCampaignDetail(parentModal, deal.campaign_id);
        } else if (cr) {
          paintCreatorDetail(parentModal, cr.id);
        }
      }
      selectTab(state.tab);
    } catch (e) { toast('error: ' + e.message); btn.disabled = false; }
  };
}

// ===========================================================================
// OUTREACH COMPOSER
// ===========================================================================
function openOutreachComposer(creator, channel, parentModal) {
  const campaigns = state.campaigns;
  let variant = 0;
  const m = modal({
    title: 'Outreach — ' + (creator.creator_name || '@' + creator.username),
    wide: true,
    body: `
      <div class="inf-filters" style="margin-bottom:12px">
        <label>Channel
          <select id="oc-channel">
            <option value="tiktok_dm"${channel === 'tiktok_dm' ? ' selected' : ''}>TikTok DM</option>
            <option value="instagram_dm"${channel === 'instagram_dm' ? ' selected' : ''}>Instagram DM</option>
            <option value="email"${channel === 'email' ? ' selected' : ''}>Email</option>
          </select></label>
        <label>Campaign
          <select id="oc-campaign">
            <option value="">none</option>
            ${campaigns.map((ca) => `<option value="${ca.id}">${esc(ca.name)}</option>`).join('')}
          </select></label>
        <label>Follow-up
          <input type="date" id="oc-followup"></label>
        <button class="btn sm" id="oc-regen">Regenerate</button>
      </div>
      <textarea class="gen-out" id="oc-msg"></textarea>
      <div style="font-size:11.5px;color:var(--muted);margin-top:8px">
        Keep it direct, casual and personal — never corporate. Edit freely before sending.</div>`,
    foot: `<button class="btn" id="oc-copy">Copy</button>
           <button class="btn primary" id="oc-sent">Mark as contacted & log</button>`,
  });
  const regen = () => {
    const ch = m.q('#oc-channel').value;
    const ca = campaigns.find((x) => x.id === m.q('#oc-campaign').value) || null;
    m.q('#oc-msg').value = genMessage(creator, ch, ca, variant);
  };
  m.q('#oc-channel').onchange = () => { variant = 0; regen(); };
  m.q('#oc-campaign').onchange = regen;
  m.q('#oc-regen').onclick = () => { variant++; regen(); };
  regen();
  m.q('#oc-copy').onclick = () => copyText(m.q('#oc-msg').value);
  m.q('#oc-sent').onclick = async () => {
    const btn = m.q('#oc-sent'); btn.disabled = true;
    try {
      const ch = m.q('#oc-channel').value;
      const followUp = m.q('#oc-followup').value || null;
      await logOutreach({
        creator_id: creator.id,
        campaign_id: m.q('#oc-campaign').value || null,
        channel: ch,
        message: m.q('#oc-msg').value,
        sent: true,
        sent_at: new Date().toISOString(),
        follow_up_at: followUp,
        response_status: 'none',
      });
      const patch = { last_contacted_at: new Date().toISOString() };
      if (followUp) patch.next_follow_up_at = followUp;
      if (statusIndex(creator.status) < statusIndex('contacted')) patch.status = 'contacted';
      await updateCreator(creator.id, patch);
      toast('logged as contacted');
      m.close();
      await loadAll();
      if (parentModal && document.body.contains(parentModal.el)) {
        paintCreatorDetail(parentModal, creator.id);
      }
      selectTab(state.tab);
    } catch (e) { toast('error: ' + e.message); btn.disabled = false; }
  };
}

// ===========================================================================
// BRIEF GENERATOR
// ===========================================================================
function openBriefGenerator(creator, parentModal) {
  const deals = creatorRoll(creator.id).deals;
  let angle = ANGLES[0];
  const m = modal({
    title: 'Content brief — ' + (creator.creator_name || '@' + creator.username),
    wide: true,
    body: `
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Pick an angle:</div>
      <div class="angle-list" id="bg-angles">
        ${ANGLES.map((a, i) => `<button class="angle-opt${i === 0 ? ' on' : ''}" data-a="${esc(a)}">${esc(a)}</button>`).join('')}
      </div>
      ${deals.length ? `<div class="inf-filters" style="margin-bottom:10px"><label>Save to deal
        <select id="bg-deal"><option value="">don't save</option>
        ${deals.map((d) => `<option value="${d.id}">${esc(campaignName(d.campaign_id))}</option>`).join('')}
        </select></label></div>` : ''}
      <textarea class="gen-out" id="bg-out" style="min-height:320px"></textarea>`,
    foot: `<button class="btn" id="bg-copy">Copy</button>
           <button class="btn primary" id="bg-save">${deals.length ? 'Save brief' : 'Done'}</button>`,
  });
  const regen = () => { m.q('#bg-out').value = genBrief(creator, angle); };
  m.qa('#bg-angles .angle-opt').forEach((btn) => {
    btn.onclick = () => {
      m.qa('#bg-angles .angle-opt').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      angle = btn.dataset.a;
      regen();
    };
  });
  regen();
  m.q('#bg-copy').onclick = () => copyText(m.q('#bg-out').value);
  m.q('#bg-save').onclick = async () => {
    const dealId = m.q('#bg-deal') ? m.q('#bg-deal').value : '';
    const btn = m.q('#bg-save'); btn.disabled = true;
    try {
      if (dealId) {
        await saveDeal({ brief_angle: angle, content_brief: m.q('#bg-out').value }, dealId);
        if (statusIndex(creator.status) < statusIndex('brief_sent')) {
          await updateCreator(creator.id, { status: 'brief_sent' });
        }
        toast('brief saved to deal');
        await loadAll();
        if (parentModal && document.body.contains(parentModal.el)) {
          paintCreatorDetail(parentModal, creator.id);
        }
        selectTab(state.tab);
      }
      m.close();
    } catch (e) { toast('error: ' + e.message); btn.disabled = false; }
  };
}

// ===========================================================================
// CSV IMPORT
// ===========================================================================
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function openCsvImport() {
  const m = modal({
    title: 'Import creators from CSV',
    wide: true,
    body: `
      <div class="import-note">
        Paste CSV with a header row. Columns (order-independent):<br>
        <code>platform, name, username, profile_url, followers, avg_views, avg_likes,
        avg_comments, niche, country, language, contact_info, notes</code><br>
        Score is calculated automatically. Duplicates (same platform + username) are skipped.
        Imported creators land in <b>Discovered</b>.
      </div>
      <textarea class="gen-out" id="csv-in" style="min-height:220px"
        placeholder="platform,name,username,followers,avg_views,avg_likes,avg_comments,niche,country
tiktok,Jane Doe,janedoe,42000,90000,7200,310,music,US"></textarea>
      <div id="csv-result"></div>`,
    foot: `<button class="btn" id="csv-cancel">Cancel</button>
           <button class="btn primary" id="csv-run">Import</button>`,
  });
  m.q('#csv-cancel').onclick = m.close;
  m.q('#csv-run').onclick = async () => {
    const text = m.q('#csv-in').value.trim();
    const res = m.q('#csv-result');
    if (!text) { res.className = 'import-result err'; res.textContent = 'paste some CSV first'; return; }
    let rows;
    try { rows = parseCSV(text); } catch (e) {
      res.className = 'import-result err'; res.textContent = 'parse error: ' + e.message; return;
    }
    if (rows.length < 2) {
      res.className = 'import-result err'; res.textContent = 'need a header row + at least one data row';
      return;
    }
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const idx = (name) => header.indexOf(name);
    const get = (r, name) => { const i = idx(name); return i >= 0 ? String(r[i] ?? '').trim() : ''; };
    const existing = new Set(state.creators.map((c) =>
      c.platform + '|' + (c.username || '').toLowerCase()));
    const seen = new Set();
    const toInsert = [];
    let skipped = 0, errors = 0;
    for (const r of rows.slice(1)) {
      const platform = get(r, 'platform').toLowerCase();
      const username = get(r, 'username').replace(/^@+/, '');
      if (!username || !['tiktok', 'instagram'].includes(platform)) { errors++; continue; }
      const key = platform + '|' + username.toLowerCase();
      if (existing.has(key) || seen.has(key)) { skipped++; continue; }
      seen.add(key);
      const base = {
        platform,
        creator_name: get(r, 'name'),
        username,
        profile_url: get(r, 'profile_url') || null,
        followers: num(get(r, 'followers')),
        avg_views: num(get(r, 'avg_views')),
        avg_likes: num(get(r, 'avg_likes')),
        avg_comments: num(get(r, 'avg_comments')),
        niche: get(r, 'niche') || null,
        country: get(r, 'country') || null,
        language: get(r, 'language') || null,
        contact_info: get(r, 'contact_info') || null,
        notes: get(r, 'notes') || null,
        audience_fit: 60,
        content_quality: 60,
        status: 'discovered',
      };
      toInsert.push(pick({ ...base, ...scoreCreator(base) }, CREATOR_COLS));
    }
    if (!toInsert.length) {
      res.className = 'import-result err';
      res.textContent = `Nothing to import — ${skipped} duplicate(s), ${errors} invalid row(s).`;
      return;
    }
    const btn = m.q('#csv-run'); btn.disabled = true;
    try {
      const { error } = await sb.from('influencer_creators').insert(toInsert);
      if (error) throw new Error(error.message);
      res.className = 'import-result';
      res.textContent = `Imported ${toInsert.length} creator(s) · ${skipped} duplicate(s) skipped · ${errors} invalid row(s).`;
      toast(`imported ${toInsert.length}`);
      await loadAll();
      selectTab('creators');
      setTimeout(m.close, 1400);
    } catch (e) {
      res.className = 'import-result err';
      res.textContent = 'import failed: ' + e.message;
      btn.disabled = false;
    }
  };
}

// ===========================================================================
// PERFORMANCE DASHBOARD
// ===========================================================================
function renderDashboard(c) {
  const creators = state.creators;
  const deals = state.deals;
  const outreach = state.outreach;

  // A creator counts as contacted if outreach was logged, a contact time is
  // stamped, or their pipeline status is already past "approved for outreach".
  const contactedSet = new Set([
    ...creators.filter((cr) => cr.last_contacted_at).map((cr) => cr.id),
    ...outreach.filter((o) => o.sent).map((o) => o.creator_id),
    ...creators.filter((cr) => {
      const i = statusIndex(cr.status);
      return i >= statusIndex('contacted') && i <= statusIndex('paid');
    }).map((cr) => cr.id),
  ]);
  const repliedSet = new Set([
    ...outreach.filter((o) => o.response_status === 'replied').map((o) => o.creator_id),
    ...creators.filter((cr) => {
      const i = statusIndex(cr.status);
      return i >= statusIndex('replied') && i <= statusIndex('paid');
    }).map((cr) => cr.id),
  ]);
  const dealCreatorIds = new Set(deals.map((d) => d.creator_id));

  const spend = deals.reduce((a, d) => a + (Number(d.agreed_fee) || 0), 0);
  const posts = deals.filter((d) => d.posted_url).length;
  const views = deals.reduce((a, d) => a + num(d.final_views), 0);
  const signups = deals.reduce((a, d) => a + num(d.signups), 0);
  const replyRate = contactedSet.size
    ? clamp((repliedSet.size / contactedSet.size) * 100, 0, 100) : 0;
  const closeRate = contactedSet.size
    ? clamp((dealCreatorIds.size / contactedSet.size) * 100, 0, 100) : 0;

  // Aggregations.
  const byKey = (keyFn) => {
    const map = {};
    for (const d of deals) {
      const k = keyFn(d);
      if (!k) continue;
      map[k] = map[k] || { signups: 0, views: 0, spend: 0, n: 0 };
      map[k].signups += num(d.signups);
      map[k].views += num(d.final_views);
      map[k].spend += Number(d.agreed_fee) || 0;
      map[k].n++;
    }
    return map;
  };
  const byPlatform = byKey((d) => (creatorById(d.creator_id) || {}).platform);
  const byNiche = byKey((d) => (creatorById(d.creator_id) || {}).niche);
  const byAngle = byKey((d) => d.brief_angle);

  const topEntry = (map, metric) => Object.entries(map)
    .sort((a, b) => (b[1][metric] || 0) - (a[1][metric] || 0))[0];
  const bestPlat = topEntry(byPlatform, 'signups');
  const bestNiche = topEntry(byNiche, 'signups');
  const bestAngle = topEntry(byAngle, 'signups');

  // Posted deals ranked by signups.
  const posted = deals.filter((d) => d.posted_url || num(d.signups) > 0);
  const rankedDeals = [...posted].sort((a, b) => num(b.signups) - num(a.signups));
  const worst = [...posted].sort((a, b) => num(a.signups) - num(b.signups)).slice(0, 5);
  const avgCps = signups ? spend / signups : 0;
  const rebook = rankedDeals.filter((d) =>
    num(d.signups) > 0 && d.cost_per_signup != null && (avgCps === 0 || d.cost_per_signup <= avgCps))
    .slice(0, 5);
  const adWorthy = rankedDeals.filter((d) => {
    const cr = creatorById(d.creator_id);
    return cr && cr.can_use_as_ad && num(d.final_views) > 0;
  }).slice(0, 5);

  const dealCreatorName = (d) => {
    const cr = creatorById(d.creator_id);
    return cr ? (cr.creator_name || '@' + cr.username) : 'creator';
  };

  const box = (v, l, x) => `<div class="stat-box"><div class="sv">${v}</div>
    <div class="sl">${esc(l)}</div>${x ? `<div class="sx">${esc(x)}</div>` : ''}</div>`;

  c.innerHTML = `
    <div class="inf-head"><h2>Performance dashboard</h2>
      <span class="sub">across all campaigns</span></div>
    <div class="stat-grid">
      ${box(creators.length, 'Creators')}
      ${box(contactedSet.size, 'Contacted')}
      ${box(pct(replyRate), 'Reply rate')}
      ${box(pct(closeRate), 'Deal close rate')}
      ${box(money(spend), 'Total spend')}
      ${box(posts, 'Total posts')}
      ${box(fmt(views), 'Total views')}
      ${box(signups, 'Total signups')}
      ${box(signups ? money(spend / signups) : '—', 'Cost / signup')}
      ${box(views ? money(spend / views * 1000) : '—', 'Cost / 1k views')}
    </div>
    <div class="card-grid">
      <div class="panel">
        <h3>Best creators (by signups)</h3>
        ${rankedDeals.length ? rankedDeals.slice(0, 6).map((d, i) => `
          <div class="rank-row"><span class="rk">${i + 1}</span>
            <span class="rn">${esc(dealCreatorName(d))}</span>
            <span class="rv">${num(d.signups)} signups · ${fmt(d.final_views)} views</span></div>`).join('')
          : '<div style="color:var(--muted);font-size:13px">No results recorded yet.</div>'}
      </div>
      <div class="panel">
        <h3>Best platform / angle / niche</h3>
        <div class="rank-row"><span class="rn">Best platform</span>
          <span class="rv">${bestPlat ? esc(platLabel(bestPlat[0])) + ' · ' + bestPlat[1].signups + ' signups' : '—'}</span></div>
        <div class="rank-row"><span class="rn">Best content angle</span>
          <span class="rv">${bestAngle ? esc(bestAngle[0].slice(0, 32)) + ' · ' + bestAngle[1].signups : '—'}</span></div>
        <div class="rank-row"><span class="rn">Best niche</span>
          <span class="rv">${bestNiche ? esc(bestNiche[0]) + ' · ' + bestNiche[1].signups + ' signups' : '—'}</span></div>
      </div>
      <div class="panel">
        <h3>Worth rebooking</h3>
        ${rebook.length ? rebook.map((d) => `
          <div class="rank-row"><span class="rn">${esc(dealCreatorName(d))}</span>
            <span class="rv">${money(d.cost_per_signup)}/signup</span></div>`).join('')
          : '<div style="color:var(--muted);font-size:13px">No standout performers yet.</div>'}
      </div>
      <div class="panel">
        <h3>Worth using for paid ads</h3>
        ${adWorthy.length ? adWorthy.map((d) => `
          <div class="rank-row"><span class="rn">${esc(dealCreatorName(d))}</span>
            <span class="rv">${fmt(d.final_views)} views</span></div>`).join('')
          : '<div style="color:var(--muted);font-size:13px">No ad-cleared creators with results yet.</div>'}
      </div>
      <div class="panel">
        <h3>Worst performers</h3>
        ${worst.length ? worst.map((d) => `
          <div class="rank-row"><span class="rn">${esc(dealCreatorName(d))}</span>
            <span class="rv">${num(d.signups)} signups · ${fmt(d.final_views)} views</span></div>`).join('')
          : '<div style="color:var(--muted);font-size:13px">No results recorded yet.</div>'}
      </div>
      <div class="panel">
        <h3>Recommendations</h3>
        <div style="font-size:13px;color:var(--muted);line-height:1.6">
          ${recommendations(rankedDeals, rebook, adWorthy, worst, bestAngle, dealCreatorName)}
        </div>
      </div>
    </div>`;
}
function recommendations(ranked, rebook, adWorthy, worst, bestAngle, nameFn) {
  if (!ranked.length) return 'Record post results to unlock winner recommendations.';
  const out = [];
  if (rebook.length) out.push(`Rebook <b style="color:#fff">${esc(nameFn(rebook[0]))}</b> — strong cost per signup.`);
  if (adWorthy.length) out.push(`Promote <b style="color:#fff">${esc(nameFn(adWorthy[0]))}</b>'s post as a paid ad.`);
  if (bestAngle) out.push(`Double down on the angle "<b style="color:#fff">${esc(bestAngle[0].slice(0, 40))}</b>".`);
  if (worst.length && num(worst[0].signups) === 0) {
    out.push(`Kill or rework the angle behind <b style="color:#fff">${esc(nameFn(worst[0]))}</b> — zero signups.`);
  }
  out.push('Test similar creators to your best performers and increase budget on what converts.');
  return out.map((s) => '• ' + s).join('<br>');
}
