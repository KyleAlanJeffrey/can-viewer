// Screenshots of the landing site (site/public) and the built app (web/dist) at desktop and phone
// widths, taken in headless Chrome over the DevTools protocol. Both are served with their _headers,
// so the shots run under the real Content-Security-Policy. Fails on any console error, CSP
// violation, uncaught exception or failed same-origin request, and on a site page wider than the
// window, and on a service worker that fails to install. No dependencies: needs Node 22 (for
// WebSocket) and Chrome.
//
// Usage: node scripts/screenshots.mjs
//   CHROME           Chrome's path (default: the macOS app, or google-chrome on PATH)
//   SCREENSHOTS_DIR  where the PNGs and index.md go (default: target/screenshots)
//   APP_DIR          the built app (default: web/dist, which needs `pnpm demo` run before `pnpm build`)
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './serve-static.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.env.SCREENSHOTS_DIR ?? join(repo, 'target/screenshots'));
const appDir = resolve(process.env.APP_DIR ?? join(repo, 'web/dist'));
const siteDir = join(repo, 'site/public');
const chromePath =
  process.env.CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
];

const SITE_PAGES = [
  { name: 'home', path: '/' },
  { name: 'canalyzer-alternative', path: '/canalyzer-alternative/' },
  { name: 'blf-viewer-online', path: '/blf-viewer-online/' },
  { name: 'dbc-viewer-online', path: '/dbc-viewer-online/' },
  { name: 'mf4-viewer-online', path: '/mf4-viewer-online/' },
  { name: '404', path: '/no-such-page/', status: 404 },
];

const APP_VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'trace', label: 'Trace' },
  { id: 'plot', label: 'Plot' },
  { id: 'reverse', label: 'Reverse Engineer' },
  { id: 'compare', label: 'Compare' },
  { id: 'database', label: 'Database' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One WebSocket to the browser; pages and workers are flattened sessions on it. */
class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  static async connect(url) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      cdp.#ws.addEventListener('open', resolveOpen, { once: true });
      cdp.#ws.addEventListener('error', () => reject(new Error(`Could not connect to Chrome at ${url}`)), { once: true });
    });
    cdp.#ws.addEventListener('message', (e) => cdp.#receive(JSON.parse(e.data)));
    cdp.#ws.addEventListener('close', () => {
      for (const { reject } of cdp.#pending.values()) reject(new Error('Chrome closed the DevTools connection'));
      cdp.#pending.clear();
    });
    return cdp;
  }

  #receive(msg) {
    if (msg.id === undefined) {
      for (const listener of this.#listeners) listener(msg.method, msg.params, msg.sessionId);
      return;
    }
    const call = this.#pending.get(msg.id);
    this.#pending.delete(msg.id);
    if (msg.error) call?.reject(new Error(`${call.method}: ${msg.error.message}`));
    else call?.resolve(msg.result);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++;
    this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolveCall, reject) => this.#pending.set(id, { resolve: resolveCall, reject, method }));
  }

  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    this.#ws.close();
  }
}

/** A page in its own browser context, with the sessions of its workers and service worker. */
class Tab {
  sessions = new Set();
  inflight = new Map();
  lastNetworkActivity = Date.now();
  step = 'setup';
  expectedStatus = null;

  constructor(cdp, problems, contextId) {
    Object.assign(this, { cdp, problems, contextId, sessionId: null });
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  problem(kind, text) {
    const entry = { step: this.step, kind, text: text.replace(/\s+/g, ' ').trim().slice(0, 500) };
    this.problems.push(entry);
    console.error(`  PROBLEM in ${entry.step}: ${kind}: ${entry.text}`);
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`Evaluating in the page failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  }

  async waitFor(description, expression, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return true;
      await sleep(100);
    }
    this.problem('timeout', `${description} after ${timeoutMs / 1000} s`);
    return false;
  }

  async waitForNetworkIdle(idleMs = 500, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.inflight.size === 0 && Date.now() - this.lastNetworkActivity >= idleMs) return;
      await sleep(50);
    }
    this.problem('timeout', `network still busy after ${timeoutMs / 1000} s: ${[...this.inflight.values()].slice(0, 3).join(', ')}`);
    // So one stuck request doesn't fail every later step too.
    this.inflight.clear();
  }

  /** Waits for fonts, the network, the DOM to stop changing and two frames to paint. */
  async settle() {
    await this.waitForNetworkIdle();
    const settled = await this.evaluate(`(async () => {
      await document.fonts.ready;
      const quiet = await new Promise((done) => {
        let timer;
        const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, 400, true); });
        const finish = (value) => { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); done(value); };
        const cap = setTimeout(finish, 10000, false);
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        timer = setTimeout(finish, 400, true);
      });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return quiet;
    })()`);
    if (!settled) console.log(`  note: the page kept changing for 10 s in ${this.step}`);
    await this.waitForNetworkIdle();
  }

  async navigate(url) {
    let off;
    const loaded = new Promise((resolveLoad) => {
      off = this.cdp.on((method, _params, sessionId) => {
        if (sessionId === this.sessionId && method === 'Page.loadEventFired') resolveLoad(true);
      });
    });
    let timer;
    const timedOut = new Promise((r) => (timer = setTimeout(r, 30_000, false)));
    const { errorText } = await this.send('Page.navigate', { url });
    if (errorText) this.problem('navigation', `${url}: ${errorText}`);
    else if (!(await Promise.race([loaded, timedOut]))) this.problem('timeout', `${url} did not finish loading after 30 s`);
    off();
    clearTimeout(timer);
  }

  /** Clicks `selector` with a real mouse event, if it is enabled, on screen and not covered. */
  async click(selector) {
    const target = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { reason: 'not in the page' };
      if (el.disabled) return { reason: 'disabled' };
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (r.width === 0 || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { reason: 'off screen or hidden' };
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(el === hit || el.contains(hit))) return { reason: 'covered by ' + (hit ? hit.tagName.toLowerCase() + '.' + hit.getAttribute('class') : 'nothing') };
      return { x, y };
    })()`);
    if (target.reason) return target.reason;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
    }
    return null;
  }

  async screenshot(file, { fullPage }) {
    const params = { format: 'png' };
    if (fullPage) {
      const { cssContentSize } = await this.send('Page.getLayoutMetrics');
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    writeFileSync(join(outDir, file), Buffer.from(data, 'base64'));
  }
}

/** Routes console, log, exception, CSP and network events to the tab that owns the session. */
function watchForProblems(cdp, tabs, origins) {
  const tabOf = (sessionId) => tabs.find((t) => t.sessions.has(sessionId));
  const sameOrigin = (url) => origins.some((o) => url.startsWith(`${o}/`));
  const describeArgs = (args) => args.map((a) => a.value ?? a.description ?? a.type).join(' ');

  cdp.on((method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') {
      const contextId = params.targetInfo.browserContextId;
      const tab = tabs.find((t) => (sessionId ? t.sessions.has(sessionId) : t.contextId === contextId));
      const child = params.sessionId;
      if (tab) tab.sessions.add(child);
      // Not awaited: a paused service worker answers none of these until it runs.
      for (const m of ['Runtime.enable', 'Log.enable', 'Network.enable']) cdp.send(m, {}, child).catch(() => {});
      // Workers the core's worker starts in turn.
      cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child).catch(() => {});
      if (params.waitingForDebugger) cdp.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
      return;
    }
    const tab = tabOf(sessionId);
    if (!tab) return;
    switch (method) {
      case 'Runtime.consoleAPICalled':
        if (params.type === 'error' || params.type === 'assert') tab.problem('console error', describeArgs(params.args));
        break;
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails;
        tab.problem('uncaught exception', details.exception?.description ?? details.text);
        break;
      }
      case 'Runtime.bindingCalled':
        if (params.name === '__reportCspViolation') tab.problem('CSP violation', params.payload);
        break;
      case 'Log.entryAdded':
        if (params.entry.level === 'error') {
          // The 404 page's own document is meant to come back 404.
          if (tab.expectedStatus && params.entry.url === tab.expectedStatus.url && params.entry.text.includes(`${tab.expectedStatus.status}`)) break;
          tab.problem(`${params.entry.source} error`, `${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}`);
        }
        break;
      case 'Network.requestWillBeSent':
        // Keyed by request alone: a worker's script is requested in the page and finishes in the worker.
        tab.inflight.set(params.requestId, params.request.url);
        tab.lastNetworkActivity = Date.now();
        break;
      case 'Network.loadingFinished':
      case 'Network.loadingFailed': {
        const url = tab.inflight.get(params.requestId) ?? 'an unknown URL';
        tab.inflight.delete(params.requestId);
        tab.lastNetworkActivity = Date.now();
        if (method === 'Network.loadingFailed' && !params.canceled) {
          tab.problem('failed request', `${params.errorText}${params.blockedReason ? ` (${params.blockedReason})` : ''} for ${url}`);
        }
        break;
      }
      case 'Network.responseReceived': {
        const { url, status } = params.response;
        const expected = tab.expectedStatus && url === tab.expectedStatus.url && status === tab.expectedStatus.status;
        if (status >= 400 && sameOrigin(url) && !expected) tab.problem('failed request', `${status} for ${url}`);
        break;
      }
    }
  });
}

async function openTab(cdp, tabs, problems, viewport, mobileUserAgent) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  // Registered before attaching, so the attach event finds the tab.
  const tab = new Tab(cdp, problems, browserContextId);
  tabs.push(tab);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  tab.sessionId = sessionId;
  tab.sessions.add(sessionId);

  await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map((m) => tab.send(m)));
  await tab.send('Runtime.addBinding', { name: '__reportCspViolation' });
  await tab.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `addEventListener('securitypolicyviolation', (e) => __reportCspViolation(e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline') + ' in ' + e.sourceFile + ':' + e.lineNumber));`,
  });
  // Its workers, such as the one running the wasm core, and its service worker.
  await tab.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await tab.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
  });
  // Shots taken mid-transition would differ run to run.
  await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  if (viewport.mobile) {
    await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await tab.send('Emulation.setUserAgentOverride', {
      userAgent: mobileUserAgent,
      userAgentMetadata: { platform: 'Android', platformVersion: '14', architecture: '', model: 'Pixel 8', mobile: true },
    });
  }
  return tab;
}

async function shootSite(tab, origin, viewport, shots) {
  for (const page of SITE_PAGES) {
    const file = `site-${page.name}-${viewport.name}.png`;
    tab.step = file;
    const url = `${origin}${page.path}`;
    tab.expectedStatus = page.status ? { url, status: page.status } : null;
    await tab.navigate(url);
    // Lazy images below the fold would be blank in a full-page shot.
    await tab.evaluate(`Promise.all([...document.images].map((img) => { img.loading = 'eager'; return img.decode().catch(() => {}); }))`);
    await tab.settle();
    const overflow = await tab.evaluate(`(() => {
      const root = document.documentElement;
      if (root.scrollWidth <= root.clientWidth) return null;
      const wide = [...document.body.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 0.5)
        .slice(0, 5)
        .map((el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : ''));
      return 'scrollWidth ' + root.scrollWidth + ' > clientWidth ' + root.clientWidth + '; past the edge: ' + wide.join(', ');
    })()`);
    if (overflow) tab.problem('horizontal overflow', overflow);
    await tab.screenshot(file, { fullPage: true });
    shots.push({ file, what: `Site: ${page.name}`, viewport, fullPage: true });
    console.log(`  ${file}`);
  }
  tab.expectedStatus = null;
}

async function shootApp(tab, origin, viewport, shots, notes) {
  const status = `(document.querySelector('.doc-sub[role=status]')?.textContent ?? '')`;
  const idle = `!document.querySelector('.app[data-busy]')`;
  const shoot = async (file, what) => {
    await tab.settle();
    await tab.screenshot(file, { fullPage: false });
    shots.push({ file, what: `App: ${what}`, viewport });
    console.log(`  ${file}`);
  };

  tab.step = `app-empty-${viewport.name}.png`;
  await tab.navigate(`${origin}/`);
  await tab.waitFor('the app did not finish starting', `${idle} && ${status} !== '' && !${status}.startsWith('Restoring')`, 30_000);
  await shoot(tab.step, 'empty state');
  // The app works offline only once its service worker has installed.
  await tab.waitFor('the service worker did not install', `navigator.serviceWorker.getRegistration().then((r) => !!r?.active)`, 30_000);

  tab.step = `app-demo-${viewport.name}.png`;
  await tab.navigate(`${origin}/?demo=1`);
  await tab.waitFor(
    'the demo did not finish loading',
    `${idle} && document.querySelector('.doc-title')?.textContent === 'demo.log' && /frames/.test(${status})`,
    120_000,
  );
  await shoot(tab.step, 'demo loaded');

  for (const view of APP_VIEWS) {
    const file = `app-${view.id}-${viewport.name}.png`;
    tab.step = file;
    const unreachable = await tab.click(`.view-switcher [data-value="${view.id}"]`);
    if (unreachable) {
      // Phones are out of scope for the app (PRODUCT.md), so only a desktop miss is a failure.
      if (viewport.mobile) notes.push(`${view.label} tab not clickable at ${viewport.width} px: ${unreachable}`);
      else tab.problem('unreachable', `${view.label} tab: ${unreachable}`);
      continue;
    }
    await tab.waitFor(`the ${view.label} tab did not open`, `document.querySelector('.view-switcher [data-value="${view.id}"]')?.getAttribute('aria-checked') === 'true' && ${idle}`, 30_000);
    await shoot(file, `${view.label} tab`);
  }

  const file = `app-capture-sheet-${viewport.name}.png`;
  tab.step = file;
  const unreachable = await tab.click('.toolbar-button.capture');
  if (unreachable) {
    if (viewport.mobile) notes.push(`Capture button not clickable at ${viewport.width} px: ${unreachable}`);
    else tab.problem('unreachable', `Capture button: ${unreachable}`);
    return;
  }
  await tab.waitFor('the Capture sheet did not open', `!!document.querySelector('dialog.sheet[open] .sheet-title')?.textContent.includes('Live Capture')`, 30_000);
  await shoot(file, 'Capture sheet open');
}

function writeSummary(shots, problems, notes) {
  const lines = ['## Screenshots', '', `${shots.length} PNGs, in this run's artifacts.`, '', '| File | Shows | Window |', '|---|---|---|'];
  for (const s of shots) {
    const size = `${s.viewport.width} x ${s.viewport.height}${s.viewport.mobile ? ', phone' : ''}${s.fullPage ? ', full page' : ''}`;
    lines.push(`| \`${s.file}\` | ${s.what} | ${size} |`);
  }
  lines.push('', problems.length ? `### ${problems.length} problems` : '### No problems found');
  if (problems.length) lines.push('', ...problems.map((p) => `- \`${p.step}\`: ${p.kind}: ${p.text}`));
  if (notes.length) lines.push('', '### Notes', '', ...notes.map((n) => `- ${n}`));
  const markdown = `${lines.join('\n')}\n`;
  writeFileSync(join(outDir, 'index.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

async function main() {
  if (!existsSync(join(appDir, 'index.html'))) throw new Error(`No built app in ${appDir}. Run pnpm --dir web build first.`);
  if (!existsSync(join(appDir, 'demo/demo.log.gz'))) throw new Error(`No demo in ${appDir}. Run pnpm --dir web demo before building.`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const site = await startStaticServer({ root: siteDir, notFound: '404-page' });
  const app = await startStaticServer({ root: appDir, notFound: 'spa' });
  resources.servers.push(site.server, app.server);

  resources.profile = mkdtempSync(join(tmpdir(), 'freecan-screenshots-'));
  const args = [
    '--headless',
    `--user-data-dir=${resources.profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--lang=en-US',
    'about:blank',
  ];
  // Chrome's sandbox can fail on CI runners, which restrict user namespaces; CI loads only these pages.
  if (process.platform === 'linux' && process.env.CI) args.unshift('--no-sandbox');
  resources.chrome = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  resources.chrome.stderr.resume();
  let chromeError = null;
  resources.chrome.once('error', (e) => (chromeError = `Could not start Chrome at ${chromePath}: ${e.message}`));
  resources.chrome.once('exit', (code) => (chromeError ??= `Chrome exited early with code ${code}`));

  const portFile = join(resources.profile, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !existsSync(portFile) && !chromeError; i++) await sleep(100);
  if (chromeError) throw new Error(chromeError);
  if (!existsSync(portFile)) throw new Error('Chrome did not open its DevTools port within 30 s');
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  resources.cdp = cdp;

  const { product, userAgent } = await cdp.send('Browser.getVersion');
  console.log(`${product}; site at ${site.origin}, app at ${app.origin}; writing to ${outDir}`);
  const major = userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '0';
  const mobileUserAgent = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;

  const tabs = [];
  const problems = [];
  const notes = [];
  const shots = [];
  watchForProblems(cdp, tabs, [site.origin, app.origin]);

  for (const viewport of VIEWPORTS) {
    console.log(`${viewport.name} (${viewport.width} px)`);
    const siteTab = await openTab(cdp, tabs, problems, viewport, mobileUserAgent);
    await shootSite(siteTab, site.origin, viewport, shots);
    const appTab = await openTab(cdp, tabs, problems, viewport, mobileUserAgent);
    await shootApp(appTab, app.origin, viewport, shots, notes);
    for (const tab of [siteTab, appTab]) await cdp.send('Target.disposeBrowserContext', { browserContextId: tab.contextId });
  }

  writeSummary(shots, problems, notes);
  console.log(`${shots.length} screenshots, ${problems.length} problems. Index: ${join(outDir, 'index.md')}`);
  return problems.length === 0;
}

const resources = { servers: [], chrome: null, cdp: null, profile: null };

/** Stops Chrome and the servers and deletes the profile; safe to call more than once. */
function cleanUp() {
  resources.cdp?.close();
  resources.cdp = null;
  if (resources.chrome && resources.chrome.exitCode === null && resources.chrome.signalCode === null) {
    try {
      // The whole process group, so no renderer or GPU process outlives the browser.
      process.kill(-resources.chrome.pid, 'SIGKILL');
    } catch {
      resources.chrome.kill('SIGKILL');
    }
  }
  for (const server of resources.servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  try {
    if (resources.profile) rmSync(resources.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    resources.profile = null;
  } catch (error) {
    console.error(`Could not delete the Chrome profile ${resources.profile}: ${error.message}`);
  }
}

process.on('exit', cleanUp);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(signal, () => process.exit(code));

/** Asks Chrome to quit, so it isn't writing to the profile while it is deleted. */
async function stopChrome() {
  const chrome = resources.chrome;
  if (!chrome || !resources.cdp || chrome.exitCode !== null) return;
  const exited = new Promise((r) => chrome.once('exit', r));
  resources.cdp.send('Browser.close').catch(() => {});
  await Promise.race([exited, sleep(5000)]);
}

try {
  const ok = await main();
  await stopChrome();
  cleanUp();
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(error);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) console.error(`Screenshots taken so far are in ${outDir}`);
  process.exitCode = 1;
  await stopChrome();
  cleanUp();
}
