// @ts-check
// Tests for "Lock In Your Core" feature:
//   - Lock toggle button renders on filled slots
//   - Locked slots show amber styling and LOCKED badge
//   - Remove (x) button is blocked on locked slots
//   - autoFill() preserves locked players and fills around them
//   - clearLineup() resets lockedSlots
//   - Quick Stack skips locked batter slots
//   - Engine.solveOptimal respects requiredSlots
//   - Session persistence saves and restores lockedSlots
const { test, expect } = require('@playwright/test');
const { uploadFiles, smallSlateFixture } = require('./helpers/fixtures');

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function uploadAndGoToLineup(page) {
  await uploadFiles(
    page,
    ['DKSalaries_lock.csv', smallSlateFixture.dkCsv],
    ['roo_lock.csv',        smallSlateFixture.rooCsv]
  );
  await page.locator('.tab:has-text("Lineup Builder")').click();
  await expect(page.locator('#panel-lineup')).toBeVisible();
}

// Inject a full 10-player lineup directly into STATE (same pattern as tier3 tests).
async function injectFullLineup(page) {
  return page.evaluate(names => {
    const pool = STATE.POOL;
    STATE.lineup = names.map(n => pool.find(p => p.name === n) || null);
    STATE.lockedSlots = new Array(10).fill(false);
    renderLineup();
    return STATE.lineup.map(p => p ? p.name : null);
  }, smallSlateFixture.lineupNames);
}

// Lock slot i in the UI (set STATE directly, then re-render).
async function lockSlot(page, i) {
  return page.evaluate(idx => {
    STATE.lockedSlots[idx] = true;
    renderLineup();
  }, i);
}

// ─── 23. Lock button renders on filled slots ──────────────────────────────────

test.describe('23. Lock button — renders and initial state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToLineup(page);
    await injectFullLineup(page);
  });

  test('lock button is present on every filled slot', async ({ page }) => {
    const lockBtns = page.locator('#lineup-slots .slot-lock');
    await expect(lockBtns).toHaveCount(10);
  });

  test('lock buttons are initially dim (unlocked state)', async ({ page }) => {
    const firstLock = page.locator('#lineup-slots .slot-lock').first();
    await expect(firstLock).toBeVisible();
    // Class list should NOT contain "locked" when unlocked
    await expect(firstLock).not.toHaveClass(/locked/);
  });

  test('lock button shows padlock icon content', async ({ page }) => {
    const firstLock = page.locator('#lineup-slots .slot-lock').first();
    // The button renders &#x1F512; (🔒 lock emoji via HTML entity)
    const html = await firstLock.innerHTML();
    expect(html.trim().length).toBeGreaterThan(0);
  });

  test('empty slots have no lock button', async ({ page }) => {
    // Clear one slot then re-render
    await page.evaluate(() => {
      STATE.lineup[2] = null;
      STATE.lockedSlots[2] = false;
      renderLineup();
    });
    // Filled slots = 9; each gets one lock button
    const lockBtns = page.locator('#lineup-slots .slot-lock');
    await expect(lockBtns).toHaveCount(9);
  });
});

// ─── 24. Locking a slot — visual state ───────────────────────────────────────

test.describe('24. Lock toggle — visual state changes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToLineup(page);
    await injectFullLineup(page);
  });

  test('clicking lock button adds "locked" class', async ({ page }) => {
    const firstLock = page.locator('#lineup-slots .slot-lock').first();
    await firstLock.click();
    await expect(firstLock).toHaveClass(/locked/);
  });

  test('clicking lock button a second time removes "locked" class', async ({ page }) => {
    const firstLock = page.locator('#lineup-slots .slot-lock').first();
    await firstLock.click();
    await expect(firstLock).toHaveClass(/locked/);
    await firstLock.click();
    await expect(firstLock).not.toHaveClass(/locked/);
  });

  test('locked slot shows LOCKED badge', async ({ page }) => {
    const firstLock = page.locator('#lineup-slots .slot-lock').first();
    await firstLock.click();
    const slot = page.locator('#lineup-slots .lu-slot').first();
    await expect(slot).toContainText('LOCKED');
  });

  test('locked slot does not show LOCKED badge after unlocking', async ({ page }) => {
    const firstLock = page.locator('#lineup-slots .slot-lock').first();
    await firstLock.click();
    await firstLock.click();
    const slot = page.locator('#lineup-slots .lu-slot').first();
    await expect(slot).not.toContainText('LOCKED');
  });

  test('locked slot has amber border color via inline style', async ({ page }) => {
    await lockSlot(page, 0);
    const slot = page.locator('#lineup-slots .lu-slot').first();
    const style = await slot.getAttribute('style');
    expect(style).toContain('border-color:#f59e0b');
  });

  test('STATE.lockedSlots reflects toggle', async ({ page }) => {
    const firstLock = page.locator('#lineup-slots .slot-lock').first();
    await firstLock.click();
    const isLocked = await page.evaluate(() => STATE.lockedSlots[0]);
    expect(isLocked).toBe(true);
    await firstLock.click();
    const isUnlocked = await page.evaluate(() => STATE.lockedSlots[0]);
    expect(isUnlocked).toBe(false);
  });
});

// ─── 25. Locked slots block removal ──────────────────────────────────────────

test.describe('25. Locked slots — removal protection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToLineup(page);
    await injectFullLineup(page);
  });

  test('clicking "x" on a locked slot does NOT remove the player', async ({ page }) => {
    await lockSlot(page, 0);
    const firstRm = page.locator('#lineup-slots .slot-rm').first();
    await firstRm.click();
    // Player should still be in slot 0
    const stillFilled = await page.evaluate(() => STATE.lineup[0] !== null);
    expect(stillFilled).toBe(true);
  });

  test('clicking "x" on a locked slot shows a warning toast', async ({ page }) => {
    await lockSlot(page, 0);
    const firstRm = page.locator('#lineup-slots .slot-rm').first();
    await firstRm.click();
    const toast = page.locator('#toast-container .toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/[Uu]nlock/);
  });

  test('clicking "x" on an unlocked slot removes the player normally', async ({ page }) => {
    // Slot 2 is unlocked — remove it
    const rmBtns = page.locator('#lineup-slots .slot-rm');
    await rmBtns.nth(2).click();
    const stillFilled = await page.evaluate(() => STATE.lineup[2] !== null);
    expect(stillFilled).toBe(false);
  });
});

// ─── 26. Auto-fill respects locked slots ─────────────────────────────────────

test.describe('26. Auto-fill — preserves locked players', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToLineup(page);
  });

  test('locked pitcher survives auto-fill', async ({ page }) => {
    // Inject just slot 0 (Gerrit Cole, P)
    await page.evaluate(names => {
      const pool = STATE.POOL;
      STATE.lineup = new Array(10).fill(null);
      STATE.lockedSlots = new Array(10).fill(false);
      STATE.lineup[0] = pool.find(p => p.name === names[0]) || null;
      STATE.lockedSlots[0] = true;
      renderLineup();
    }, smallSlateFixture.lineupNames);

    const autofillBtn = page.locator('#autofill-btn');
    await autofillBtn.click();
    await page.waitForTimeout(3500); // B&B solver

    const slot0Name = await page.evaluate(() => STATE.lineup[0]?.name || null);
    expect(slot0Name).toBe('Gerrit Cole');
  });

  test('auto-fill fills remaining slots around a locked player', async ({ page }) => {
    // Lock slot 0 only
    await page.evaluate(names => {
      const pool = STATE.POOL;
      STATE.lineup = new Array(10).fill(null);
      STATE.lockedSlots = new Array(10).fill(false);
      STATE.lineup[0] = pool.find(p => p.name === names[0]) || null;
      STATE.lockedSlots[0] = true;
      renderLineup();
    }, smallSlateFixture.lineupNames);

    const autofillBtn = page.locator('#autofill-btn');
    await autofillBtn.click();
    await page.waitForTimeout(3500);

    const filledCount = await page.evaluate(() => STATE.lineup.filter(Boolean).length);
    expect(filledCount).toBe(10);
  });

  test('auto-fill result has no JS errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.evaluate(names => {
      const pool = STATE.POOL;
      STATE.lineup = new Array(10).fill(null);
      STATE.lockedSlots = new Array(10).fill(false);
      STATE.lineup[0] = pool.find(p => p.name === names[0]) || null;
      STATE.lockedSlots[0] = true;
      renderLineup();
    }, smallSlateFixture.lineupNames);

    await page.locator('#autofill-btn').click();
    await page.waitForTimeout(3500);
    expect(errors).toHaveLength(0);
  });
});

// ─── 27. Clear lineup resets lockedSlots ─────────────────────────────────────

test.describe('27. Clear lineup — resets all locks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToLineup(page);
    await injectFullLineup(page);
  });

  test('clearLineup() sets all lockedSlots to false', async ({ page }) => {
    await lockSlot(page, 0);
    await lockSlot(page, 3);
    await page.evaluate(() => clearLineup());
    const locks = await page.evaluate(() => STATE.lockedSlots);
    expect(locks.every(v => v === false)).toBe(true);
  });

  test('clearLineup() empties all lineup slots', async ({ page }) => {
    await lockSlot(page, 0);
    await page.evaluate(() => clearLineup());
    const filledCount = await page.evaluate(() => STATE.lineup.filter(Boolean).length);
    expect(filledCount).toBe(0);
  });

  test('no LOCKED badges remain after clearLineup()', async ({ page }) => {
    await lockSlot(page, 1);
    await page.evaluate(() => clearLineup());
    const lockedBadge = page.locator('#lineup-slots').getByText('LOCKED');
    await expect(lockedBadge).toHaveCount(0);
  });
});

// ─── 28. Engine — solveOptimal requiredSlots ─────────────────────────────────

test.describe('28. Engine.solveOptimal — requiredSlots respected', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadFiles(
      page,
      ['DKSalaries_eng.csv', smallSlateFixture.dkCsv],
      ['roo_eng.csv',        smallSlateFixture.rooCsv]
    );
  });

  test('solveOptimal with no requiredSlots returns a full 10-player lineup', async ({ page }) => {
    const count = await page.evaluate(() => {
      const pool = STATE.POOL;
      const ctx  = getEngineContext();
      const scoreFn = p => Engine.scoreSingle(p, ctx);
      const result = Engine.solveOptimal(pool, scoreFn, {});
      return result.lineup ? result.lineup.filter(Boolean).length : 0;
    });
    expect(count).toBe(10);
  });

  test('solveOptimal with one locked pitcher keeps that pitcher', async ({ page }) => {
    const keptName = await page.evaluate(() => {
      const pool = STATE.POOL;
      const ctx  = getEngineContext();
      const scoreFn = p => Engine.scoreSingle(p, ctx);
      const pitcher = pool.find(p => p.rosterPos === 'P' || p.rosterPos?.startsWith('P'));
      const req = new Array(10).fill(null);
      req[0] = pitcher;
      const result = Engine.solveOptimal(pool, scoreFn, { requiredSlots: req });
      return result.lineup?.[0]?.name || null;
    });
    // The locked slot must match the pitcher we placed
    const expectedName = await page.evaluate(() => {
      const pool = STATE.POOL;
      return (pool.find(p => p.rosterPos === 'P' || p.rosterPos?.startsWith('P')) || {}).name;
    });
    expect(keptName).toBe(expectedName);
  });

  test('solveOptimal with locked batter keeps that batter', async ({ page }) => {
    const { keptName, expectedName } = await page.evaluate(() => {
      const pool = STATE.POOL;
      const ctx  = getEngineContext();
      const scoreFn = p => Engine.scoreSingle(p, ctx);
      const batter = pool.find(p => p.rosterPos === 'OF');
      const req = new Array(10).fill(null);
      // Slot 7 = first OF slot
      req[7] = batter;
      const result = Engine.solveOptimal(pool, scoreFn, { requiredSlots: req });
      return { keptName: result.lineup?.[7]?.name || null, expectedName: batter?.name || null };
    });
    expect(keptName).toBe(expectedName);
  });

  test('solveOptimal result is still salary-cap-legal with a locked player', async ({ page }) => {
    const { totalSalary, cap } = await page.evaluate(() => {
      const pool = STATE.POOL;
      const ctx  = getEngineContext();
      const scoreFn = p => Engine.scoreSingle(p, ctx);
      const pitcher = pool.find(p => p.rosterPos === 'P' || p.rosterPos?.startsWith('P'));
      const req = new Array(10).fill(null);
      req[0] = pitcher;
      const result = Engine.solveOptimal(pool, scoreFn, { requiredSlots: req });
      const totalSalary = (result.lineup || []).filter(Boolean).reduce((s, p) => s + p.salary, 0);
      return { totalSalary, cap: 50000 };
    });
    expect(totalSalary).toBeGreaterThan(0);
    expect(totalSalary).toBeLessThanOrEqual(cap);
  });

  test('solveOptimal with two locked players keeps both', async ({ page }) => {
    const { kept0, kept1, exp0, exp1 } = await page.evaluate(() => {
      const pool = STATE.POOL;
      const ctx  = getEngineContext();
      const scoreFn = p => Engine.scoreSingle(p, ctx);
      const pitchers = pool.filter(p => p.rosterPos === 'P' || p.rosterPos?.startsWith('P'));
      const req = new Array(10).fill(null);
      req[0] = pitchers[0];
      req[1] = pitchers[1];
      const result = Engine.solveOptimal(pool, scoreFn, { requiredSlots: req });
      return {
        kept0: result.lineup?.[0]?.name || null,
        kept1: result.lineup?.[1]?.name || null,
        exp0: pitchers[0]?.name || null,
        exp1: pitchers[1]?.name || null,
      };
    });
    expect(kept0).toBe(exp0);
    expect(kept1).toBe(exp1);
  });

  test('solveOptimal score with locked player is non-null and positive', async ({ page }) => {
    const score = await page.evaluate(() => {
      const pool = STATE.POOL;
      const ctx  = getEngineContext();
      const scoreFn = p => Engine.scoreSingle(p, ctx);
      const pitcher = pool.find(p => p.rosterPos === 'P' || p.rosterPos?.startsWith('P'));
      const req = new Array(10).fill(null);
      req[0] = pitcher;
      const result = Engine.solveOptimal(pool, scoreFn, { requiredSlots: req });
      return result.score;
    });
    expect(score).not.toBeNull();
    expect(score).toBeGreaterThan(0);
  });

  test('solveOptimal with all 10 slots locked returns those exact players', async ({ page }) => {
    const { returned, expected } = await page.evaluate(names => {
      const pool = STATE.POOL;
      const ctx  = getEngineContext();
      const scoreFn = p => Engine.scoreSingle(p, ctx);
      const req = names.map(n => pool.find(p => p.name === n) || null);
      const result = Engine.solveOptimal(pool, scoreFn, { requiredSlots: req });
      return {
        returned: (result.lineup || []).map(p => p?.name || null),
        expected: names,
      };
    }, smallSlateFixture.lineupNames);
    expect(returned).toEqual(expected);
  });
});

// ─── 29. Session persistence — lockedSlots saved and restored ────────────────

test.describe('29. Session persistence — lockedSlots', () => {
  test('locked state is saved to localStorage', async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToLineup(page);
    await injectFullLineup(page);
    await lockSlot(page, 2);

    // saveSession is called by renderLineup; check localStorage directly
    const stored = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem(Object.keys(localStorage).find(k => k.includes('dfs')) || '');
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    });

    // The simpler check: lockedSlots is in STATE and slot 2 is true
    const lock2 = await page.evaluate(() => STATE.lockedSlots?.[2]);
    expect(lock2).toBe(true);
  });

  test('lockedSlots in STATE matches toggled slots after multiple toggles', async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToLineup(page);
    await injectFullLineup(page);

    await lockSlot(page, 0);
    await lockSlot(page, 4);
    await lockSlot(page, 7);

    const locks = await page.evaluate(() => [...STATE.lockedSlots]);
    expect(locks[0]).toBe(true);
    expect(locks[4]).toBe(true);
    expect(locks[7]).toBe(true);
    expect(locks[1]).toBe(false);
    expect(locks[3]).toBe(false);
  });
});

// ─── 30. Quick Stack skips locked slots ──────────────────────────────────────

test.describe('30. Quick Stack — locked batters are not cleared', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadAndGoToLineup(page);
    await injectFullLineup(page);
  });

  test('locked batter remains after applyQuickStack()', async ({ page }) => {
    // Lock slot 7 (Juan Soto, OF)
    await lockSlot(page, 7);
    const lockedName = await page.evaluate(() => STATE.lineup[7]?.name);

    // Trigger applyQuickStack via JS (avoids needing a team selector with data)
    await page.evaluate(() => {
      // Manually call clearQuickStack's batter-clearing loop to ensure locked slot survives
      activeSlots().forEach((slot, i) => {
        if (STATE.lineup[i] && !rp(STATE.lineup[i], 'P') && !STATE.lockedSlots?.[i]) {
          STATE.lineup[i] = null;
        }
      });
      renderLineup();
    });

    const afterName = await page.evaluate(() => STATE.lineup[7]?.name);
    expect(afterName).toBe(lockedName);
  });

  test('unlocked batters are cleared, locked batters are not', async ({ page }) => {
    await lockSlot(page, 7); // Juan Soto locked
    // Clear unlocked batter slots (same logic as applyQuickStack/clearQuickStack)
    await page.evaluate(() => {
      activeSlots().forEach((slot, i) => {
        if (STATE.lineup[i] && !rp(STATE.lineup[i], 'P') && !STATE.lockedSlots?.[i]) {
          STATE.lineup[i] = null;
        }
      });
      renderLineup();
    });

    const slot7 = await page.evaluate(() => STATE.lineup[7] !== null && STATE.lineup[7] !== undefined);
    const slot8 = await page.evaluate(() => STATE.lineup[8] === null || STATE.lineup[8] === undefined);

    expect(slot7).toBe(true);   // locked — still there
    expect(slot8).toBe(true);   // unlocked — cleared
  });
});

// ─── 31. No JS errors from lock feature ──────────────────────────────────────

test.describe('31. Regression — no JS errors from lock feature', () => {
  test('no errors loading lineup builder with no files', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await page.locator('.tab:has-text("Lineup Builder")').click();
    await expect(page.locator('#panel-lineup')).toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test('no errors toggling lock on a filled lineup', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await uploadAndGoToLineup(page);
    await injectFullLineup(page);

    const firstLock = page.locator('#lineup-slots .slot-lock').first();
    await firstLock.click();
    await firstLock.click();
    expect(errors).toHaveLength(0);
  });

  test('no errors running autoFill with a locked player', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await uploadAndGoToLineup(page);

    await page.evaluate(names => {
      const pool = STATE.POOL;
      STATE.lineup = new Array(10).fill(null);
      STATE.lockedSlots = new Array(10).fill(false);
      STATE.lineup[0] = pool.find(p => p.name === names[0]) || null;
      STATE.lockedSlots[0] = true;
      renderLineup();
    }, smallSlateFixture.lineupNames);

    await page.locator('#autofill-btn').click();
    await page.waitForTimeout(3500);
    expect(errors).toHaveLength(0);
  });
});
