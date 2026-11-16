/* Chromium UI verification with a mutable Chrome API fixture, not a live extension. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.WRANGLE_TEST_URL || 'http://127.0.0.1:8765';
async function fixture({ ai }) {
  const data = Array.from({ length: 24 }, (_, index) => ({ id: index + 1, index, windowId: 1, groupId: -1, pinned: false, active: false, title: `Article ${index + 1} about useful design patterns with a long descriptive title`, url: `https://reading.test/article/${index + 1}?original=full&tracking=${'long'.repeat(20)}` }));
  data.push({ id: 50, index: 0, windowId: 2, groupId: 10, pinned: false, active: false, title: 'Cooking', url: 'https://cooking.test/recipes' });
  data.push({ id: 60, index: 25, windowId: 1, groupId: -1, pinned: true, active: false, title: 'Pinned', url: 'https://pinned.test' });
  const groups = [{ id: 10, title: 'Cooking', color: 'blue', windowId: 2, collapsed: false }];
  const storage = { ai: { choice: ai ? 'chrome' : 'site' } }, session = {};
  let nextGroup = 20;
  const tab = id => { const t = data.find(t => t.id === id); if (!t) throw Error('Tab missing'); return t; };
  window.fixture = { data, groups, storage };
  window.chrome = {
    runtime: { getURL: path => `${location.origin}/${path}`, getManifest: () => ({ version: 'test' }), onMessage: { addListener() {} } },
    storage: { local: { get: async () => storage, set: async value => Object.assign(storage, value) }, session: { get: async () => session, set: async value => Object.assign(session, value) } },
    tabs: {
      query: async () => structuredClone(data), get: async id => structuredClone(tab(id)),
      update: async (id, value) => Object.assign(tab(id), value),
      remove: async ids => { for (const id of Array.isArray(ids) ? ids : [ids]) data.splice(data.findIndex(t => t.id === id), 1); },
      move: async (ids, value) => { for (const id of Array.isArray(ids) ? ids : [ids]) Object.assign(tab(id), { windowId: value.windowId ?? tab(id).windowId, index: value.index < 0 ? 100 : value.index }); },
      ungroup: async ids => { for (const id of Array.isArray(ids) ? ids : [ids]) tab(id).groupId = -1; },
      group: async args => { const id = args.groupId ?? nextGroup++; if (!groups.some(g => g.id === id)) groups.push({ id, title: '', color: 'grey', windowId: args.createProperties.windowId }); for (const tid of args.tabIds) tab(tid).groupId = id; return id; },
      create: async args => { const t = { ...args, id: 1000 + data.length, groupId: -1, pinned: false, title: args.url }; data.push(t); return t; },
    },
    tabGroups: { query: async () => structuredClone(groups), get: async id => { const g = groups.find(g => g.id === id); if (!g) throw Error('Group missing'); return structuredClone(g); }, update: async (id, value) => Object.assign(groups.find(g => g.id === id), value) },
    windows: { get: async id => ({ id, type: 'normal' }), update: async () => {}, create: async () => ({ id: 3 }) },
    permissions: { request: async () => true },
  };
  if (ai) {
    const model = { contextWindow: 100000, contextUsage: 0, clone: async () => model, destroy() {}, prompt: async prompt => new Promise(resolve => { window.fixture.pendingPrompt = prompt; window.fixture.answer = resolve; }) };
    window.LanguageModel = { availability: async () => 'available', create: async () => model };
  }
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  await context.addInitScript(fixture, { ai: false });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${origin}/dashboard.html`);
  await page.waitForSelector('.row.item');
  await page.keyboard.press('j');
  assert.match(await page.locator('#cururl').innerText(), /original=full/);
  assert.equal(await page.locator('.row-actions').count(), 1);
  await page.keyboard.press('x'); await page.keyboard.press('j'); await page.keyboard.press('x');
  assert.equal(await page.locator('.row.sel').count(), 2);
  assert.equal(await page.locator('.applybtn kbd').count(), 0);
  await page.keyboard.press('m'); await page.locator('#picker-q').fill('Cooking'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => fixture.data.filter(t => t.id < 50 && t.groupId === 10).length === 2);
  await page.waitForFunction(() => !document.querySelector('#undo').disabled);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => fixture.data.filter(t => t.id < 50 && t.groupId === 10).length === 0);
  await page.keyboard.press('g'); await page.keyboard.press('j');
  await page.keyboard.press('n'); await page.locator('#pg-name').fill('My group'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => fixture.groups.some(g => g.title === 'My group'));
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => document.querySelectorAll('.row.item').length === 24);
  await page.keyboard.press('g'); await page.keyboard.press('j');
  await page.keyboard.press('#');
  await page.waitForFunction(() => fixture.data.length === 25);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => fixture.data.length === 26);
  await page.keyboard.press('?'); await page.waitForSelector('[aria-label="Keyboard shortcuts"]'); await page.keyboard.press('Escape');
  await page.locator('#settings').click(); await page.waitForSelector('[role=dialog][aria-label="AI settings"]'); await page.keyboard.press('Escape');
  await page.locator('#list').focus(); await page.keyboard.press('r');
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1100, 760, 600, 360]) {
      await page.setViewportSize({ width, height: 720 });
      await page.keyboard.press('g'); await page.keyboard.press('j');
      const result = await page.evaluate(() => {
        const row = document.querySelector('.row.item.cur'), actions = row.querySelector('.row-actions'), title = row.querySelector('.title');
        const rb = row.getBoundingClientRect(), ab = actions.getBoundingClientRect(), tb = title.getBoundingClientRect();
        return { rowHeight: rb.height, overlap: tb.right > ab.left, overflow: document.documentElement.scrollWidth > innerWidth, hints: document.querySelectorAll('.applybtn kbd').length, words: getComputedStyle(row.querySelector('.action-word')).display };
      });
      assert.equal(result.rowHeight, 38); assert.equal(result.overlap, false); assert.equal(result.overflow, false); assert.ok(result.hints <= 1);
      if (width <= 650) assert.equal(result.words, 'none');
      await page.screenshot({ path: `/tmp/wrangle-${theme}-${width}.png`, fullPage: false });
      await page.keyboard.press('G'); await page.waitForTimeout(50);
      const clear = await page.evaluate(() => document.querySelector('.row:last-child').getBoundingClientRect().bottom <= document.querySelector('.applybar').getBoundingClientRect().top);
      assert.equal(clear, true, `last row covered at ${theme} ${width}`);
    }
  }
  // One-group acceptance acts immediately, without accepting other proposals.
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.keyboard.press('g'); await page.keyboard.press('Shift+Enter');
  await page.waitForFunction(() => !document.querySelectorAll('.row.item').length);
  assert.equal(await page.locator('#cururl').innerText(), '');
  await context.close();

  const aiContext = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  await aiContext.addInitScript(fixture, { ai: true });
  const aiPage = await aiContext.newPage(); aiPage.on('pageerror', e => errors.push(String(e)));
  await aiPage.goto(`${origin}/dashboard.html`);
  await aiPage.waitForFunction(() => !!fixture.answer);
  await aiPage.keyboard.press('j'); await aiPage.keyboard.press('#');
  await aiPage.waitForFunction(() => fixture.data.length === 25);
  await aiPage.waitForFunction(() => !document.querySelector('#undo').disabled);
  await aiPage.keyboard.press('x');
  const focused = await aiPage.locator('.row.cur').getAttribute('data-key');
  await aiPage.keyboard.press('m');
  await aiPage.evaluate(() => fixture.answer(JSON.stringify({ tabs: Array.from({ length: 24 }, (_, index) => ({ tab: index + 1, subject: 'Useful design patterns', group: index < 12 ? 'Design patterns' : 'Interface design' })) })));
  await aiPage.waitForSelector('[data-act=pull]');
  assert.equal(await aiPage.locator('[role=dialog]').count(), 1, 'arrival preserves modal');
  await aiPage.keyboard.press('Escape');
  assert.equal(await aiPage.locator('.row.cur').getAttribute('data-key'), focused);
  assert.equal(await aiPage.locator('.row.sel').count(), 1);
  assert.match(await aiPage.locator('#sorter').innerText(), /Import 23 ready/);
  const anchorTop = await aiPage.locator('.row.cur').evaluate(el => el.getBoundingClientRect().top);
  await aiPage.keyboard.press('u');
  await aiPage.waitForFunction(() => !document.querySelector('[data-act=pull]'));
  assert.equal(await aiPage.locator('.row.cur').getAttribute('data-key'), focused);
  assert.equal(await aiPage.locator('.row.sel').count(), 1);
  assert.ok(Math.abs(await aiPage.locator('.row.cur').evaluate(el => el.getBoundingClientRect().top) - anchorTop) < 2, 'import preserves scroll anchor');
  assert.equal(await aiPage.evaluate(() => fixture.data.filter(t => t.id < 50 && t.groupId !== -1).length), 0, 'import cannot mutate Chrome');
  await aiPage.keyboard.press('Escape'); await aiPage.keyboard.press('#');
  await aiPage.waitForFunction(() => fixture.data.length === 24);
  await aiPage.keyboard.press('R'); await aiPage.locator('#picker-q').fill('Everything'); await aiPage.keyboard.press('Enter');
  await aiPage.waitForFunction(() => fixture.pendingPrompt && !fixture.pendingPrompt.includes('"Article 1 about'));
  assert.equal(errors.length, 0, errors.join('\n'));
  await browser.close();
  console.log('Dashboard fixture passed: immediate actions/Undo, keyboard selection/dialogs, AI import/modal stability, responsive light/dark layout and footer clearance.');
})().catch(e => { console.error(e); process.exit(1); });
