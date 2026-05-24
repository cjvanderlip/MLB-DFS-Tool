// @ts-check
// Tests for Tier 3 fixes:
//   Fix 1 — Correlation priors: n<10 minimum in buildPairCorrelations
//   Fix 2 — Export-time validation: confirm() dialog for injured/unconfirmed/postponed players
//   Fix 3 — Postponement detection: /api/postponed/:date endpoint + UI button + PPD badge
const { test, expect } = require('@playwright/test');
const { uploadFiles, smallSlateFixture } = require('./helpers/fixtures');

async function uploadAndGoToPlayers(page) {
  // Block the auto-fetch of confirmed lineups triggered when navigating to Player Pool.
  // In the full test suite the /api/lineups response is cached server-side and returns
  // quickly, causing applyConfirmedToPool() to set isConfirmed=false on pool players
  // before exportDK() runs — triggering a spurious "unconfirmed" export warning.
  await page.route('/api/lineups/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, games: [] }),
  }));
  await uploadFiles(
    page,
    ['DKSalaries_t3.csv', smallSlateFixture.dkCsv],
    ['roo_t3.csv', smallSlateFixture.rooCsv]
  );
  await page.locator('.tab:has-text("Player Pool")').click();
  await expect(page.locator('#player-content')).toBeVisible();
}

// Inject exactly 10 players into STATE.lineup using hard-coded slot order.
// Applies overrides first so the player object already carries the flag
// when it lands in STATE.lineup (same object reference as pool player).
async function injectFullLineup(page, overrides = {}) {
  return page.evaluate(([names, overrides]) => {
    const pool = STATE.POOL;
    const byName = n => pool.find(p => p.name === n) || null;
    // Apply flags before building lineup (pool player = lineup player same object)
    for (const [name, props] of Object.entries(overrides)) {
      const p = byName(name);
      if (p) Object.assign(p, props);
    }
    STATE.lineup = names.map(byName);
    return STATE.lineup.map(p => p ? p.name : null);
  }, [smallSlateFixture.lineupNames, overrides]);
}

// Build a 2-lineup portfolio from the same 10 players.
async function injectMockPortfolio(page, flagOverrides = {}) {
  return page.evaluate(([names, flagOverrides]) => {
    const pool = STATE.POOL;
    const byName = n => pool.find(p => p.name === n) || null;
    for (const [name, props] of Object.entries(flagOverrides)) {
      const p = byName(name);
      if (p) Object.assign(p, props);
    }
    const lu = names.map(byName);
    // Two lineups referencing the same player objects — dedup logic must handle this
    STATE.portfolioLineups = [lu, [...lu]];
    return STATE.portfolioLineups.length;
  }, [smallSlateFixture.lineupNames, flagOverrides]);
}

// ─── Fix 1: Correlation priors — n<10 minimum in buildPairCorrelations ────────

test.describe('16. Correlation priors — n<10 minimum (Fix 1)', () => {
  test('GET /api/history returns well-formed entries (correlation system can build from them)', async ({ page }) => {
    const r = await page.request.get('/api/history');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    const withActuals = body.filter(h => h.playerActuals && Object.keys(h.playerActuals).length >= 2);
    if (withActuals.length >= 3) {
      withActuals.slice(0, 3).forEach(entry => {
        expect(typeof entry.playerActuals).toBe('object');
        expect(Object.keys(entry.playerActuals).length).toBeGreaterThanOrEqual(2);
      });
    }
  });

  test('engine buildPairCorrelations skips pairs with n<10 (structural priors apply)', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      // 9 co-appearances — must be excluded; structural prior takes over via getCorrelation()
      const fakeHistory = Array.from({ length: 9 }, (_, i) => ({
        playerActuals: { 'PlayerA': 30 + i, 'PlayerB': 25 + i },
      }));
      Engine.buildPairCorrelations(fakeHistory);
      return Engine.getPairCorrelation('PlayerA', 'PlayerB');
    });
    expect(result).toBeNull(); // n=9 < 10, excluded → structural priors apply
  });

  test('engine buildPairCorrelations includes pairs with n>=10', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      const fakeHistory = Array.from({ length: 10 }, (_, i) => ({
        playerActuals: { 'PlayerA': 30 + i, 'PlayerB': 28 + i },
      }));
      Engine.buildPairCorrelations(fakeHistory);
      return Engine.getPairCorrelation('PlayerA', 'PlayerB');
    });
    expect(typeof result).toBe('number'); // n=10 meets threshold — stored
  });

  test('getCorrelation falls back to structural prior when no historical data', async ({ page }) => {
    await page.goto('/');
    const corr = await page.evaluate(() => {
      Engine.buildPairCorrelations([]); // clear historical data
      // Adjacent same-team batters → structural prior = 0.38
      const p1 = { name: 'FakeBatter1', team: 'NYY', opp: 'BOS', dkPos: 'OF', order: 1 };
      const p2 = { name: 'FakeBatter2', team: 'NYY', opp: 'BOS', dkPos: 'OF', order: 2 };
      return Engine.getCorrelation(p1, p2);
    });
    expect(corr).toBeCloseTo(0.38, 2);
  });
});

// ─── Fix 2: Export-time validation — exportDK() ───────────────────────────────

test.describe('17. Export validation — exportDK() (Fix 2)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToPlayers(page);
    await page.locator('.tab:has-text("Lineup Builder")').click();
  });

  test('export with no flagged players shows no confirm dialog', async ({ page }) => {
    await injectFullLineup(page);
    let dialogFired = false;
    page.on('dialog', async (dialog) => { dialogFired = true; await dialog.dismiss(); });
    await page.evaluate(() => exportDK());
    await page.waitForTimeout(500);
    expect(dialogFired).toBe(false);
  });

  test('OUT-marked player triggers export warning dialog', async ({ page }) => {
    await injectFullLineup(page, { 'Juan Soto': { dkStatus: 'O' } });
    let dialogMessage = '';
    page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.dismiss(); });
    await page.evaluate(() => exportDK());
    await page.waitForTimeout(500);
    expect(dialogMessage).toMatch(/out/i);
    expect(dialogMessage).toContain('Juan Soto');
  });

  test('IL-injured player triggers export warning dialog', async ({ page }) => {
    await injectFullLineup(page, { 'Mookie Betts': { injuryType: 'IL', injuryFlag: true, injuryDesc: 'IL-10' } });
    let dialogMessage = '';
    page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.dismiss(); });
    await page.evaluate(() => exportDK());
    await page.waitForTimeout(500);
    expect(dialogMessage).toMatch(/injured list|IL/i);
    expect(dialogMessage).toContain('Mookie Betts');
  });

  test('postponed player triggers export warning dialog', async ({ page }) => {
    await injectFullLineup(page, { 'Gerrit Cole': { isPostponed: true } });
    let dialogMessage = '';
    page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.dismiss(); });
    await page.evaluate(() => exportDK());
    await page.waitForTimeout(500);
    expect(dialogMessage).toMatch(/postponed/i);
    expect(dialogMessage).toContain('Gerrit Cole');
  });

  test('accepting the warning dialog allows export to proceed', async ({ page }) => {
    await injectFullLineup(page, { 'Juan Soto': { dkStatus: 'O' } });
    let dialogSeen = false;
    page.once('dialog', async (dialog) => { dialogSeen = true; await dialog.accept(); });
    const result = await page.evaluate(() => { try { exportDK(); return 'ran'; } catch (e) { return 'threw: ' + e.message; } });
    await page.waitForTimeout(300);
    expect(dialogSeen).toBe(true);
    expect(result).toBe('ran');
  });

  test('unconfirmed batter triggers export warning dialog', async ({ page }) => {
    await injectFullLineup(page, { 'Jose Altuve': { isConfirmed: false } });
    let dialogMessage = '';
    page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.dismiss(); });
    await page.evaluate(() => exportDK());
    await page.waitForTimeout(500);
    expect(dialogMessage).toMatch(/not.*confirmed|unconfirmed/i);
    expect(dialogMessage).toContain('Jose Altuve');
  });
});

// ─── Fix 2: Export-time validation — exportPortfolio() ───────────────────────

test.describe('18. Export validation — exportPortfolio() (Fix 2)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToPlayers(page);
  });

  test('portfolio export with clean players shows no confirm dialog', async ({ page }) => {
    await injectMockPortfolio(page);
    let dialogFired = false;
    page.on('dialog', async (dialog) => { dialogFired = true; await dialog.dismiss(); });
    await page.evaluate(() => exportPortfolio());
    await page.waitForTimeout(500);
    expect(dialogFired).toBe(false);
  });

  test('portfolio export with OUT player triggers warning dialog', async ({ page }) => {
    await injectMockPortfolio(page, { 'Juan Soto': { dkStatus: 'O' } });
    let dialogMessage = '';
    page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.dismiss(); });
    await page.evaluate(() => exportPortfolio());
    await page.waitForTimeout(500);
    expect(dialogMessage).toMatch(/warning/i);
    expect(dialogMessage).toContain('Juan Soto');
    expect(dialogMessage).toMatch(/OUT/i);
  });

  test('portfolio export with postponed player triggers warning dialog', async ({ page }) => {
    await injectMockPortfolio(page, { 'Mookie Betts': { isPostponed: true } });
    let dialogMessage = '';
    page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.dismiss(); });
    await page.evaluate(() => exportPortfolio());
    await page.waitForTimeout(500);
    expect(dialogMessage).toMatch(/postponed/i);
    expect(dialogMessage).toContain('Mookie Betts');
  });

  test('portfolio export warning message shows the lineup count', async ({ page }) => {
    await injectMockPortfolio(page, { 'Juan Soto': { dkStatus: 'O' } });
    let dialogMessage = '';
    page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.dismiss(); });
    await page.evaluate(() => exportPortfolio());
    await page.waitForTimeout(500);
    expect(dialogMessage).toMatch(/2\s*lineup/i);
  });

  test('portfolio export deduplicates warnings for the same player across lineups', async ({ page }) => {
    // Gerrit Cole appears in both lineups — should appear in warning exactly once
    await injectMockPortfolio(page, { 'Gerrit Cole': { injuryFlag: true, injuryType: 'IL' } });
    let dialogMessage = '';
    page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.dismiss(); });
    await page.evaluate(() => exportPortfolio());
    await page.waitForTimeout(500);
    expect(dialogMessage).toContain('Gerrit Cole');
    const count = (dialogMessage.match(/Gerrit Cole/g) || []).length;
    expect(count).toBe(1);
  });
});

// ─── Fix 3: Postponement detection — API endpoint ─────────────────────────────

test.describe('19. Postponement API endpoint (Fix 3)', () => {
  test('GET /api/postponed/:date returns 200 with success and postponed array', async ({ page }) => {
    const r = await page.request.get('/api/postponed/2026-05-21');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.postponed)).toBe(true);
    expect(body.date).toBe('2026-05-21');
  });

  test('GET /api/postponed/:date returns 400 for invalid date format', async ({ page }) => {
    const r = await page.request.get('/api/postponed/not-a-date');
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body).toHaveProperty('error');
  });

  test('GET /api/postponed/:date returns 400 for MM-DD-YYYY format', async ({ page }) => {
    const r = await page.request.get('/api/postponed/05-21-2026');
    expect(r.status()).toBe(400);
  });

  test('GET /api/postponed/:date for a past date returns valid structure', async ({ page }) => {
    const r = await page.request.get('/api/postponed/2025-04-15');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.postponed)).toBe(true);
    body.postponed.forEach(g => {
      expect(typeof g.homeTeam).toBe('string');
      expect(typeof g.awayTeam).toBe('string');
      expect(typeof g.status).toBe('string');
      expect(typeof g.gameTime).toBe('string');
    });
  });

  test('postponed entries only have status in {Postponed, Suspended, Cancelled}', async ({ page }) => {
    const r = await page.request.get('/api/postponed/2025-04-15');
    const body = await r.json();
    const validStatuses = new Set(['Postponed', 'Suspended', 'Cancelled']);
    body.postponed.forEach(g => {
      expect(validStatuses.has(g.status)).toBe(true);
    });
  });
});

// ─── Fix 3: Postponement detection — UI button and PPD badge ──────────────────

test.describe('20. Postponement UI — button and badge (Fix 3)', () => {
  // The Live Data Enrichment section (containing the button) is inside panel-players,
  // visible only when the Player Pool tab is active.
  async function goToPlayerPool(page) {
    await page.locator('.tab:has-text("Player Pool")').click();
    await page.waitForTimeout(200);
  }

  test('Check Postponements button is visible in the Player Pool panel', async ({ page }) => {
    await page.goto('/');
    await goToPlayerPool(page);
    await expect(page.locator('#check-postponed-btn')).toBeVisible();
  });

  test('Check Postponements button has correct onclick handler', async ({ page }) => {
    await page.goto('/');
    const onclick = await page.locator('#check-postponed-btn').getAttribute('onclick');
    expect(onclick).toBe('checkPostponements()');
  });

  test('checkPostponements() function exists on the page', async ({ page }) => {
    await page.goto('/');
    const exists = await page.evaluate(() => typeof checkPostponements === 'function');
    expect(exists).toBe(true);
  });

  test('clicking Check Postponements button calls /api/postponed with today\'s date', async ({ page }) => {
    await page.goto('/');
    await goToPlayerPool(page);
    const today = new Date().toISOString().slice(0, 10);
    let requestUrl = '';
    page.on('request', req => {
      if (req.url().includes('/api/postponed')) requestUrl = req.url();
    });
    page.on('dialog', async (d) => await d.dismiss());
    await page.locator('#check-postponed-btn').click();
    await page.waitForTimeout(3000);
    expect(requestUrl).toContain(`/api/postponed/${today}`);
  });

  test('PPD badge appears on pool players when isPostponed is set', async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToPlayers(page);
    await page.evaluate(() => {
      const p = STATE.POOL.find(pl => pl.name === 'Juan Soto');
      if (p) p.isPostponed = true;
      invalidatePlayerRenderCache();
      renderPlayers();
    });
    await page.waitForTimeout(300);
    const row = page.locator('#player-tbody tr').filter({ hasText: 'Juan Soto' });
    await expect(row).toContainText('PPD');
  });

  test('checkPostponements() clears previous isPostponed flags before re-applying', async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToPlayers(page);
    await page.evaluate(() => {
      const p = STATE.POOL.find(pl => pl.name === 'Juan Soto');
      if (p) p.isPostponed = true;
    });
    await page.route('**/api/postponed/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, date: '2026-05-21', postponed: [] }),
      });
    });
    page.on('dialog', async (d) => await d.dismiss());
    await page.evaluate(() => checkPostponements());
    await page.waitForTimeout(1000);
    const stillPostponed = await page.evaluate(() => {
      const p = STATE.POOL.find(pl => pl.name === 'Juan Soto');
      return p ? !!p.isPostponed : false;
    });
    expect(stillPostponed).toBe(false);
  });

  test('checkPostponements() flags pool players from postponed teams', async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToPlayers(page);
    await page.route('**/api/postponed/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          date: '2026-05-21',
          postponed: [{ homeTeam: 'BOS', awayTeam: 'NYY', status: 'Postponed', gameTime: '' }],
        }),
      });
    });
    page.on('dialog', async (d) => await d.dismiss());
    await page.evaluate(() => checkPostponements());
    await page.waitForTimeout(1000);
    const colePostponed = await page.evaluate(() => {
      const p = STATE.POOL.find(pl => pl.name === 'Gerrit Cole');
      return p ? !!p.isPostponed : false;
    });
    expect(colePostponed).toBe(true); // Cole is NYY
    const sotoPostponed = await page.evaluate(() => {
      const p = STATE.POOL.find(pl => pl.name === 'Juan Soto');
      return p ? !!p.isPostponed : false;
    });
    expect(sotoPostponed).toBe(true); // Soto is NYY
  });

  test('PPD badge is absent when no player has isPostponed set', async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToPlayers(page);
    await page.evaluate(() => {
      STATE.POOL.forEach(p => { delete p.isPostponed; });
      invalidatePlayerRenderCache();
      renderPlayers();
    });
    await page.waitForTimeout(300);
    await expect(page.locator('#player-tbody')).not.toContainText('PPD');
  });
});

// ─── Regression: existing features unbroken by Tier 3 changes ─────────────────

test.describe('21. Regression — no JS errors after Tier 3 changes', () => {
  test('all tabs cycle without uncaught errors after tier 3 additions', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => { if (!e.message.includes('favicon')) errors.push(e.message); });
    await page.goto('/');
    await uploadFiles(
      page,
      ['DKSalaries_reg.csv', smallSlateFixture.dkCsv],
      ['roo_reg.csv', smallSlateFixture.rooCsv]
    );
    for (const label of ['Player Pool', 'Stacks', 'Vegas & Weather', 'Lineup Builder', 'Portfolio', 'Simulator', 'Backtest', 'Slate Summary', 'Upload']) {
      await page.locator(`.tab:has-text("${label}")`).click();
      await page.waitForTimeout(300);
    }
    expect(errors).toHaveLength(0);
  });

  test('exportDK shows empty-slots alert on empty lineup, does not throw', async ({ page }) => {
    await page.goto('/');
    let alertMessage = '';
    page.on('dialog', async (d) => { alertMessage = d.message(); await d.dismiss(); });
    const result = await page.evaluate(() => { try { exportDK(); return 'ok'; } catch (e) { return e.message; } });
    expect(result).toBe('ok');
    expect(alertMessage).toMatch(/empty|slot/i);
  });

  test('exportPortfolio returns early on empty portfolio without throwing', async ({ page }) => {
    await page.goto('/');
    let dialogFired = false;
    page.on('dialog', async (d) => { dialogFired = true; await d.dismiss(); });
    const result = await page.evaluate(() => {
      STATE.portfolioLineups = [];
      try { exportPortfolio(); return 'ok'; } catch (e) { return e.message; }
    });
    expect(result).toBe('ok');
    expect(dialogFired).toBe(false);
  });

  test('Fetch Pitcher Hands and Check Postponements buttons both visible in player panel', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab:has-text("Player Pool")').click();
    await expect(page.locator('#fetch-hands-btn')).toBeVisible();
    await expect(page.locator('#check-postponed-btn')).toBeVisible();
  });
});
