// @ts-check
const { test, expect } = require('@playwright/test');
const { uploadFiles, richPortfolioFixture } = require('./helpers/fixtures');

// ─── Fixture CSV data ─────────────────────────────────────────────────────────

const DK_SALARIES_CSV = `Position,Name + ID,Name,ID,Roster Position,TeamAbbrev,Salary,Game Info,AvgPointsPerGame
SP,Gerrit Cole (12345678),Gerrit Cole,12345678,P,NYY,9800,NYY@BOS 07/04/2025 07:10PM ET,28.5
SP,Shane Bieber (12345679),Shane Bieber,12345679,P,CLE,8400,CLE@DET 07/04/2025 07:10PM ET,22.1
C,Salvador Perez (12345680),Salvador Perez,12345680,C,KC,4200,KC@MIN 07/04/2025 07:10PM ET,8.2
1B,Pete Alonso (12345681),Pete Alonso,12345681,1B,NYM,4800,NYM@ATL 07/04/2025 07:10PM ET,10.1
2B,Jose Altuve (12345682),Jose Altuve,12345682,2B,HOU,5200,HOU@TEX 07/04/2025 07:10PM ET,11.3
3B,Rafael Devers (12345683),Rafael Devers,12345683,3B,BOS,5600,NYY@BOS 07/04/2025 07:10PM ET,12.4
SS,Trea Turner (12345684),Trea Turner,12345684,SS,PHI,5400,PHI@MIA 07/04/2025 07:10PM ET,11.8
OF,Juan Soto (12345685),Juan Soto,12345685,OF,NYY,5800,NYY@BOS 07/04/2025 07:10PM ET,13.2
OF,Yordan Alvarez (12345686),Yordan Alvarez,12345686,OF,HOU,5900,HOU@TEX 07/04/2025 07:10PM ET,14.1
OF,Mookie Betts (12345687),Mookie Betts,12345687,OF,LAD,6200,LAD@SF 07/04/2025 07:10PM ET,13.9
`;

const ROO_CSV = `Name,Position,Team,Salary,Floor,Median,Ceiling,Own%,Batting Order
Gerrit Cole,SP,NYY,9800,8.2,28.5,45.1,18.5,0
Shane Bieber,SP,CLE,8400,5.1,22.1,38.4,12.3,0
Salvador Perez,C,KC,4200,2.1,8.2,18.5,9.1,5
Pete Alonso,1B,NYM,4800,3.2,10.1,22.3,11.2,4
Jose Altuve,2B,HOU,5200,3.8,11.3,24.1,13.4,2
Rafael Devers,3B,BOS,5600,4.1,12.4,26.2,14.1,3
Trea Turner,SS,PHI,5400,3.9,11.8,25.0,12.8,1
Juan Soto,OF,NYY,5800,4.5,13.2,28.4,15.6,3
Yordan Alvarez,OF,HOU,5900,4.8,14.1,30.2,17.2,3
Mookie Betts,OF,LAD,6200,4.9,13.9,29.1,16.8,1
`;

const OWNERSHIP_CSV = `Gerrit Cole,18.5
Juan Soto,15.6
Yordan Alvarez,17.2
Mookie Betts,16.8
Trea Turner,12.8
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('1. Page load', () => {
  test('loads with correct title and header', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/MLB DFS Tool/);
    await expect(page.locator('.logo')).toContainText('MLB DFS Tool');
    await expect(page.locator('.ver')).toContainText('v2.0');
  });

  test('Upload panel is active on load', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#panel-upload')).toBeVisible();
    await expect(page.locator('.tab.active')).toContainText('Upload');
  });

  test('slate badge shows "No files loaded" initially', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#slate-badge')).toContainText('No files loaded');
  });
});

test.describe('2. Tab navigation', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  const TABS = [
    ['players',   'Player Pool'],
    ['stacks',    'Stacks'],
    ['vegas',     'Vegas & Weather'],
    ['lineup',    'Lineup Builder'],
    ['portfolio', 'Portfolio'],
    ['simulator', 'Simulator'],
    ['backtest',  'Backtest'],
    ['slate',     'Slate Summary'],
  ];

  for (const [id, label] of TABS) {
    test(`"${label}" shows its panel and hides others`, async ({ page }) => {
      await page.locator(`.tab:has-text("${label}")`).click();
      await expect(page.locator(`#panel-${id}`)).toBeVisible();
      await expect(page.locator('#panel-upload')).toBeHidden();
    });
  }

  test('clicking Upload tab returns to upload panel', async ({ page }) => {
    await page.locator('.tab:has-text("Player Pool")').click();
    await page.locator('.tab:has-text("Upload")').click();
    await expect(page.locator('#panel-upload')).toBeVisible();
  });
});

test.describe('3. Upload panel UI', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('dropzone is visible', async ({ page }) => {
    await expect(page.locator('#dropzone')).toBeVisible();
  });

  test('all file indicator rows are present', async ({ page }) => {
    for (const id of ['fi-dk', 'fi-roo1', 'fi-roo2', 'fi-roo3', 'fi-s3', 'fi-s5']) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
  });

  test('projection source weight inputs default to 100/0/0', async ({ page }) => {
    await expect(page.locator('#wt-roo1')).toHaveValue('100');
    await expect(page.locator('#wt-roo2')).toHaveValue('0');
    await expect(page.locator('#wt-roo3')).toHaveValue('0');
  });
});

test.describe('4. File upload', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('uploading DK salaries updates DK file row label', async ({ page }) => {
    await uploadFiles(page, ['DKSalaries.csv', DK_SALARIES_CSV]);
    await expect(page.locator('#fn-dk')).toContainText('DKSalaries');
  });

  test('uploading ROO marks projection source 1 as loaded', async ({ page }) => {
    await uploadFiles(page, ['roo_projections.csv', ROO_CSV]);
    await expect(page.locator('#fn-roo1')).not.toContainText('not loaded');
  });

  test('uploading DK + ROO shows upload status metrics', async ({ page }) => {
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    await expect(page.locator('#upload-status')).toBeVisible();
    await expect(page.locator('#upload-metrics')).not.toBeEmpty();
  });

  test('uploading DK + ROO updates slate badge', async ({ page }) => {
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    await expect(page.locator('#slate-badge')).not.toContainText('No files loaded');
  });

  test('uploading DK + ROO populates player pool with named players', async ({ page }) => {
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    await page.locator('.tab:has-text("Player Pool")').click();
    await expect(page.locator('#player-content')).toBeVisible();
    await expect(page.locator('#player-empty')).toBeHidden();
    await expect(page.locator('#player-content')).toContainText('Gerrit Cole');
    await expect(page.locator('#player-content')).toContainText('Juan Soto');
  });

  test('ROO-only upload still populates pool', async ({ page }) => {
    await uploadFiles(page, ['roo_projections.csv', ROO_CSV]);
    await page.locator('.tab:has-text("Player Pool")').click();
    await expect(page.locator('#player-content')).toBeVisible();
    await expect(page.locator('#player-content')).toContainText('Gerrit Cole');
  });
});

test.describe('5. Player pool filters (after upload)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    await page.locator('.tab:has-text("Player Pool")').click();
    await expect(page.locator('#player-content')).toBeVisible();
  });

  test('position filter buttons are visible', async ({ page }) => {
    await expect(page.locator('#pos-btns')).toBeVisible();
    const btns = page.locator('#pos-btns .pb');
    expect(await btns.count()).toBeGreaterThanOrEqual(5);
  });

  test('"P" filter shows pitchers and hides batters', async ({ page }) => {
    await page.locator('#pos-btns .pb:has-text("P")').click();
    await page.waitForTimeout(300);
    await expect(page.locator('#player-tbody')).toContainText('Gerrit Cole');
    await expect(page.locator('#player-tbody')).not.toContainText('Juan Soto');
  });

  test('"OF" filter shows outfielders and hides pitchers', async ({ page }) => {
    await page.locator('#pos-btns .pb:has-text("OF")').click();
    await page.waitForTimeout(300);
    await expect(page.locator('#player-tbody')).toContainText('Juan Soto');
    await expect(page.locator('#player-tbody')).not.toContainText('Gerrit Cole');
  });

  test('"All" filter restores the full pool', async ({ page }) => {
    await page.locator('#pos-btns .pb:has-text("P")').click();
    await page.waitForTimeout(200);
    await page.locator('#pos-btns .pb:has-text("All")').click();
    await page.waitForTimeout(200);
    await expect(page.locator('#player-tbody')).toContainText('Gerrit Cole');
    await expect(page.locator('#player-tbody')).toContainText('Juan Soto');
  });

  test('sort selector is functional', async ({ page }) => {
    const sel = page.locator('#sort-sel');
    await expect(sel).toBeVisible();
    for (const val of ['salary', 'ceiling', 'floor', 'own', 'value']) {
      await sel.selectOption(val);
      await page.waitForTimeout(150);
      await expect(page.locator('#player-content')).toBeVisible();
    }
  });

  test('team selector includes "All Teams" and team options', async ({ page }) => {
    const sel = page.locator('#team-sel');
    await expect(sel).toBeVisible();
    const opts = await sel.locator('option').allTextContents();
    expect(opts[0]).toBe('All Teams');
    expect(opts.length).toBeGreaterThan(1);
  });

  test('team filter limits pool to selected team', async ({ page }) => {
    const sel = page.locator('#team-sel');
    const opts = await sel.locator('option').allTextContents();
    const hasNYY = opts.some(o => o === 'NYY');
    if (hasNYY) {
      await sel.selectOption('NYY');
      await page.waitForTimeout(300);
      await expect(page.locator('#player-tbody')).toContainText('Gerrit Cole');
      // Cole is NYY, Bieber is CLE — should be hidden
      await expect(page.locator('#player-tbody')).not.toContainText('Shane Bieber');
    }
  });
});

test.describe('6. Lineup Builder', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('renders without errors before upload', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.locator('.tab:has-text("Lineup Builder")').click();
    await expect(page.locator('#panel-lineup')).toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test('has a generate lineup button (visible after upload)', async ({ page }) => {
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    await page.locator('.tab:has-text("Lineup Builder")').click();
    await expect(page.locator('#gen-three-btn')).toBeVisible();
  });

  test('generates a lineup after uploading files', async ({ page }) => {
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    await page.locator('.tab:has-text("Lineup Builder")').click();
    const genBtn = page.locator('#gen-three-btn');
    if (await genBtn.isVisible()) {
      await genBtn.click();
      await page.waitForTimeout(3000);
      // A constraint warning is OK; a blank panel is not
      await expect(page.locator('#panel-lineup')).toBeVisible();
    }
  });
});

test.describe('7. Portfolio Builder', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('tab panel is visible', async ({ page }) => {
    await page.locator('.tab:has-text("Portfolio")').click();
    await expect(page.locator('#panel-portfolio')).toBeVisible();
  });

  test('has a generate portfolio button', async ({ page }) => {
    await page.locator('.tab:has-text("Portfolio")').click();
    await expect(page.locator('#gen-portfolio-btn')).toBeVisible();
  });

  test('has a numeric lineup count input', async ({ page }) => {
    await page.locator('.tab:has-text("Portfolio")').click();
    const numInput = page.locator('#panel-portfolio input[type="number"]').first();
    if (await numInput.isVisible()) {
      const val = await numInput.inputValue();
      expect(Number(val)).toBeGreaterThan(0);
    }
  });
});

test.describe('8. Vegas & Weather', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('tab renders without JS errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => { if (!e.message.includes('favicon')) errors.push(e.message); });
    await page.locator('.tab:has-text("Vegas")').click();
    await page.waitForTimeout(1000);
    expect(errors).toHaveLength(0);
  });

  test('has a refresh button', async ({ page }) => {
    await page.locator('.tab:has-text("Vegas")').click();
    await expect(page.locator('#panel-vegas button').first()).toBeVisible();
  });
});

test.describe('9. Backtest tab', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('loads history entries without error', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    await page.waitForTimeout(1500);
    await expect(page.locator('#panel-backtest')).not.toContainText('Failed to load');
  });

  test('DK results import section is present', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    await expect(page.locator('#dk-results-file')).toBeAttached();
  });

  test('ownership import textarea is visible', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    await expect(page.locator('#own-import-csv')).toBeVisible();
  });

  test('ownership import date input is visible', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    await expect(page.locator('#own-import-date')).toBeVisible();
  });

  test('Import Ownership button is visible', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    await expect(page.locator('button:has-text("Import Ownership")')).toBeVisible();
  });

  test('clicking import without date shows date error', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    await page.locator('#own-import-csv').fill(OWNERSHIP_CSV);
    await page.locator('button:has-text("Import Ownership")').click();
    await expect(page.locator('#own-import-status')).toContainText(/date/i);
  });

  test('clicking import without CSV shows paste error', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    await page.locator('#own-import-date').fill('2026-04-19');
    await page.locator('button:has-text("Import Ownership")').click();
    await expect(page.locator('#own-import-status')).toContainText(/paste/i);
  });

  test('import with date + CSV shows parsed count result', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    await page.locator('#own-import-date').fill('2026-04-19');
    await page.locator('#own-import-csv').fill(OWNERSHIP_CSV);
    await page.locator('button:has-text("Import Ownership")').click();
    await page.waitForTimeout(2000);
    await expect(page.locator('#own-import-status')).toContainText(/Parsed|players|matched|failed/i);
  });
});

test.describe('10. Model Analysis & Calibration', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('model analysis section exists in backtest tab', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    await expect(page.locator('#model-analysis')).toBeAttached();
  });

  test('running analysis does not show error with existing history', async ({ page }) => {
    await page.locator('.tab:has-text("Backtest")').click();
    const btn = page.locator('button[onclick*="loadModelAnalysis"], button:has-text("Run Analysis"), button:has-text("Analyze")').first();
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(3000);
      await expect(page.locator('#model-analysis')).not.toContainText('Analysis failed');
    }
  });
});

test.describe('11. Projection override modal (after upload)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    await page.locator('.tab:has-text("Player Pool")').click();
    await expect(page.locator('#player-content')).toBeVisible();
  });

  test('override modal elements exist in DOM', async ({ page }) => {
    await expect(page.locator('#proj-override-modal')).toBeAttached();
    await expect(page.locator('#proj-override-backdrop')).toBeAttached();
  });

  test('override modal inputs exist', async ({ page }) => {
    await expect(page.locator('#po-median')).toBeAttached();
    await expect(page.locator('#po-ceiling')).toBeAttached();
    await expect(page.locator('#po-floor')).toBeAttached();
    await expect(page.locator('#po-own')).toBeAttached();
  });

  test('edit button opens override modal', async ({ page }) => {
    const editBtn = page.locator('button[onclick*="openOverrideModal"]').first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await expect(page.locator('#proj-override-modal')).toBeVisible();
    }
  });

  test('override modal can be closed', async ({ page }) => {
    const editBtn = page.locator('button[onclick*="openOverrideModal"]').first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await expect(page.locator('#proj-override-modal')).toBeVisible();
      const closeBtn = page.locator('button[onclick*="closeOverrideModal"]').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      } else {
        await page.locator('#proj-override-backdrop').click();
      }
      await expect(page.locator('#proj-override-modal')).toBeHidden();
    }
  });

  test('applying an override updates STATE.projOverrides and player median', async ({ page }) => {
    // Open Juan Soto's override modal (he appears in the fixture pool)
    await page.evaluate(() => openOverrideModal('Juan Soto'));
    await expect(page.locator('#proj-override-modal')).toBeVisible();

    await page.locator('#po-median').fill('50.0');
    await page.locator('#po-ceiling').fill('80.0');
    await page.locator('button[onclick*="applyOverrideModal"]').click();

    // Modal auto-closes after 700ms
    await page.waitForTimeout(900);
    await expect(page.locator('#proj-override-modal')).toBeHidden();

    const { projOverride, playerMedian } = await page.evaluate(() => {
      const ov = STATE.projOverrides['Juan Soto'];
      const p = STATE.POOL.find(pl => pl.name === 'Juan Soto');
      return { projOverride: ov, playerMedian: p?.median };
    });

    expect(projOverride?.median).toBe(50);
    expect(projOverride?.ceiling).toBe(80);
    expect(playerMedian).toBe(50);
  });

  test('clearing an override restores original projection values', async ({ page }) => {
    // Apply an override first
    await page.evaluate(() => openOverrideModal('Juan Soto'));
    await page.locator('#po-median').fill('99.9');
    await page.locator('button[onclick*="applyOverrideModal"]').click();
    await page.waitForTimeout(900);

    // Verify override was applied
    const overriddenMedian = await page.evaluate(() =>
      STATE.POOL.find(p => p.name === 'Juan Soto')?.median
    );
    expect(overriddenMedian).toBe(99.9);

    // Now clear it
    await page.evaluate(() => openOverrideModal('Juan Soto'));
    await expect(page.locator('#proj-override-modal')).toBeVisible();
    await page.locator('button[onclick*="clearOverrideModal"]').click();
    await page.waitForTimeout(300);

    const { cleared, restoredMedian } = await page.evaluate(() => ({
      cleared: !STATE.projOverrides['Juan Soto'],
      restoredMedian: STATE.POOL.find(p => p.name === 'Juan Soto')?.median,
    }));

    expect(cleared).toBe(true);
    expect(restoredMedian).toBeCloseTo(13.2, 1); // original fixture value (ROO_CSV has Juan Soto median 13.2)
  });

  test('override badge highlights edit button when override is active', async ({ page }) => {
    // Apply an override via JS
    await page.evaluate(() => {
      STATE.projOverrides['Juan Soto'] = { median: 50, ceiling: 80, floor: null, own: null };
      applyProjOverridesToPool();
      invalidatePlayerRenderCache();
      renderPlayers();
    });
    await page.waitForTimeout(300);

    // The edit button for Juan Soto should have the tsu (green) colour style
    const sotoRow = page.locator('#player-tbody tr').filter({ hasText: 'Juan Soto' });
    const editBtn = sotoRow.locator('button[onclick*="openOverrideModal"]');
    const style = await editBtn.getAttribute('style');
    expect(style).toContain('tsu');
  });
});

test.describe('22. Ban Players field', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    await page.locator('.tab:has-text("Portfolio")').click();
  });

  test('port-ban-players input exists in the portfolio panel', async ({ page }) => {
    await expect(page.locator('#port-ban-players')).toBeVisible();
  });

  test('banned player is excluded from getCalibratedPool()', async ({ page }) => {
    await page.locator('#port-ban-players').fill('Juan Soto');

    const included = await page.evaluate(() => {
      const pool = getCalibratedPool();
      return pool.some(p => p.name === 'Juan Soto');
    });
    expect(included).toBe(false);
  });

  test('non-banned players are not excluded', async ({ page }) => {
    await page.locator('#port-ban-players').fill('Juan Soto');

    const included = await page.evaluate(() => {
      const pool = getCalibratedPool();
      return pool.some(p => p.name === 'Mookie Betts');
    });
    expect(included).toBe(true);
  });

  test('multiple comma-separated bans all take effect', async ({ page }) => {
    await page.locator('#port-ban-players').fill('Juan Soto, Mookie Betts, Gerrit Cole');

    const result = await page.evaluate(() => {
      const pool = getCalibratedPool();
      return {
        soto: pool.some(p => p.name === 'Juan Soto'),
        betts: pool.some(p => p.name === 'Mookie Betts'),
        cole: pool.some(p => p.name === 'Gerrit Cole'),
        altuve: pool.some(p => p.name === 'Jose Altuve'), // not banned
      };
    });
    expect(result.soto).toBe(false);
    expect(result.betts).toBe(false);
    expect(result.cole).toBe(false);
    expect(result.altuve).toBe(true);
  });

  test('ban match is case-insensitive', async ({ page }) => {
    await page.locator('#port-ban-players').fill('JUAN SOTO');

    const included = await page.evaluate(() => {
      const pool = getCalibratedPool();
      return pool.some(p => p.name === 'Juan Soto');
    });
    expect(included).toBe(false);
  });

  test('clearing the ban field restores the player to the pool', async ({ page }) => {
    await page.locator('#port-ban-players').fill('Juan Soto');
    const bannedPool = await page.evaluate(() => getCalibratedPool().some(p => p.name === 'Juan Soto'));
    expect(bannedPool).toBe(false);

    await page.locator('#port-ban-players').fill('');
    const restoredPool = await page.evaluate(() => getCalibratedPool().some(p => p.name === 'Juan Soto'));
    expect(restoredPool).toBe(true);
  });
});

test.describe('12. API endpoints', () => {
  test('GET /api/history returns 200 with array', async ({ page }) => {
    const r = await page.request.get('/api/history');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test('GET /api/calibration returns scale values', async ({ page }) => {
    const r = await page.request.get('/api/calibration');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(typeof body.pitcherScale).toBe('number');
    expect(typeof body.batterScale).toBe('number');
    expect(body).toHaveProperty('positionScales');
  });

  test('calibration endpoint returns either defaults or populated position scales', async ({ page }) => {
    const r = await page.request.get('/api/calibration');
    const { pitcherScale, batterScale, positionScales } = await r.json();
    expect(typeof pitcherScale).toBe('number');
    expect(typeof batterScale).toBe('number');
    expect(positionScales && typeof positionScales).toBe('object');

    const positions = Object.keys(positionScales || {});
    if (positions.length === 0) {
      expect(pitcherScale).toBe(1.0);
      expect(batterScale).toBe(1.0);
    } else {
      expect(positions).toContain('SP');
      positions.forEach(pos => expect(typeof positionScales[pos]).toBe('number'));
    }
  });

  test('GET /api/history/analysis returns structured analysis', async ({ page }) => {
    const r = await page.request.get('/api/history/analysis');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(typeof body.sampleSize).toBe('number');
    expect(body.sampleSize).toBeGreaterThan(0);
    expect(body).toHaveProperty('overall');
    expect(body).toHaveProperty('byPosition');
  });

  test('GET /api/vegas returns an object', async ({ page }) => {
    const r = await page.request.get('/api/vegas');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(typeof body).toBe('object');
  });

  test('GET /api/bullpen returns 200', async ({ page }) => {
    const r = await page.request.get('/api/bullpen');
    expect(r.status()).toBe(200);
  });

  test('POST /api/ownership/import parses 5 players from fixture CSV', async ({ page }) => {
    const r = await page.request.post('/api/ownership/import', {
      data: { date: '2026-04-19', csv: OWNERSHIP_CSV }
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(body.parsedPlayers).toBe(5);
    expect(typeof body.playersMatched).toBe('number');
    expect(typeof body.entriesUpdated).toBe('number');
  });

  test('POST /api/ownership/import handles no-match CSV gracefully', async ({ page }) => {
    // Valid format but no real players — should parse 0 and return success
    const noMatchCsv = 'Fake Player One,99.9\nFake Player Two,88.8';
    const r = await page.request.post('/api/ownership/import', {
      data: { date: '2026-04-19', csv: noMatchCsv }
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(body.parsedPlayers).toBe(2);
    expect(body.playersMatched).toBe(0);
  });

  test('POST /api/ownership/import handles percentage-style CSV', async ({ page }) => {
    const pctCsv = `Gerrit Cole 18.5%\nJuan Soto 15.6%\nYordan Alvarez 17.2%`;
    const r = await page.request.post('/api/ownership/import', {
      data: { date: '2026-04-19', csv: pctCsv }
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(body.parsedPlayers).toBe(3);
  });
});

test.describe('13. Slate Summary tab', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('renders without JS errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => { if (!e.message.includes('favicon')) errors.push(e.message); });
    await page.locator('.tab:has-text("Slate Summary")').click();
    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });

  test('renders environment section after uploading files', async ({ page }) => {
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    await page.locator('.tab:has-text("Slate Summary")').click();
    await expect(page.locator('#panel-slate')).toBeVisible();
  });
});

test.describe('14. No uncaught JS errors', () => {
  test('cycling all tabs without files produces no errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => { if (!e.message.includes('favicon')) errors.push(e.message); });
    await page.goto('/');
    const labels = ['Player Pool', 'Stacks', 'Vegas & Weather', 'Lineup Builder',
      'Portfolio', 'Simulator', 'Backtest', 'Slate Summary', 'Upload'];
    for (const label of labels) {
      await page.locator(`.tab:has-text("${label}")`).click();
      await page.waitForTimeout(350);
    }
    expect(errors).toHaveLength(0);
  });

  test('cycling key tabs after upload produces no errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => { if (!e.message.includes('favicon')) errors.push(e.message); });
    await page.goto('/');
    await uploadFiles(page,
      ['DKSalaries.csv', DK_SALARIES_CSV],
      ['roo_projections.csv', ROO_CSV]
    );
    for (const label of ['Player Pool', 'Stacks', 'Lineup Builder', 'Portfolio', 'Slate Summary']) {
      await page.locator(`.tab:has-text("${label}")`).click();
      await page.waitForTimeout(350);
    }
    expect(errors).toHaveLength(0);
  });
});

test.describe('15. Portfolio generation — full 20-lineup count', () => {
  test('generates all 20 GPP lineups with a rich 6-team pool', async ({ page }) => {
    // Allow generous time: generation can take 15-30s on a cold engine with 20 lineups.
    test.setTimeout(120_000);

    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', e => { if (!e.message.includes('favicon')) errors.push(e.message); });

    await page.goto('/');
    // Upload DK salaries, ROO projections, and both stacks files (3-man + 5-man).
    // Without stacks files the engine falls back to virtual stacks → all same lineup → 1 accepted.
    await uploadFiles(page,
      ['DKSalaries.csv', richPortfolioFixture.dkCsv],
      ['roo_projections.csv', richPortfolioFixture.rooCsv],
      ['stacks_3man.csv', richPortfolioFixture.stacks3Csv],
      ['stacks_5man.csv', richPortfolioFixture.stacks5Csv]
    );

    // Block the auto-fetch of confirmed lineups that fires when navigating to Player Pool.
    // In the full suite the /api/lineups response is cached server-side and returns quickly,
    // causing applyConfirmedToPool() to set isConfirmed=false on real player names that
    // aren't in today's confirmed batting orders — getCalibratedPool() then filters them out,
    // shrinking the available pool below what's needed for 20 unique lineups.
    await page.route('/api/lineups/**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, games: [] }),
    }));

    // Confirm pool loaded (at least one known player visible)
    await page.locator('.tab:has-text("Player Pool")').click();
    await expect(page.locator('#player-content')).toBeVisible();
    await expect(page.locator('#player-content')).toContainText('Gerrit Cole');

    // Navigate to Portfolio tab
    await page.locator('.tab:has-text("Portfolio")').click();
    await expect(page.locator('#panel-portfolio')).toBeVisible();

    // Ensure the lineup count is set to 20
    const numInput = page.locator('#port-num-lineups');
    await numInput.fill('20');

    // Disable overlap check — the 41-player pool naturally shares many players per lineup;
    // with the default max-overlap=6 the overlap limiter blocks most candidates on a pool
    // this small. This test is specifically about the stack-recycle count fix, not overlap tuning.
    await page.locator('#port-max-overlap').fill('0');

    // Generate
    await page.locator('#gen-portfolio-btn').click();

    // The "Lineups" metric card shows totalLineups. Wait up to 90s for it to read "20".
    const lineupCountEl = page.locator(
      '#portfolio-results .mc:has(.mc-l:has-text("Lineups")) .mc-v'
    );
    await expect(lineupCountEl).toHaveText('20', { timeout: 90_000 });

    // No "Only X of Y lineups generated" partial-failure banner
    await expect(page.locator('#portfolio-results')).not.toContainText('Only');

    // No JS errors during the whole flow
    expect(errors).toHaveLength(0);
  });

  test('portfolio breaks through the stack-recycle boundary (regression for stuck-at-N bug)', async ({ page }) => {
    // Before the fix: with 16 total stacks, the generator would stall at exactly 16 lineups
    // because recycled stacks produced the same optimal lineups → all dups → deadlock.
    // After the fix: triedInCurrentRecycleCycle prevents re-picking rejected stacks within a
    // cycle, and exposure relaxation kicks in when the full cycle is exhausted → >16 lineups.
    test.setTimeout(120_000);

    await page.goto('/');
    // Block auto-fetch of confirmed lineups — real MLB lineup data would mark fixture players
    // as isConfirmed=false and filter them from getCalibratedPool(), shrinking the pool.
    await page.route('/api/lineups/**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, games: [] }),
    }));
    await uploadFiles(page,
      ['DKSalaries.csv', richPortfolioFixture.dkCsv],
      ['roo_projections.csv', richPortfolioFixture.rooCsv],
      ['stacks_3man.csv', richPortfolioFixture.stacks3Csv],
      ['stacks_5man.csv', richPortfolioFixture.stacks5Csv]
    );

    await page.locator('.tab:has-text("Portfolio")').click();
    await page.locator('#port-num-lineups').fill('20');
    await page.locator('#port-max-overlap').fill('0');
    await page.locator('#gen-portfolio-btn').click();

    // Wait for generation to fully complete (button re-enables when done)
    await expect(page.locator('#gen-portfolio-btn')).toHaveText('Generate Portfolio', { timeout: 90_000 });

    const lineupCountEl = page.locator(
      '#portfolio-results .mc:has(.mc-l:has-text("Lineups")) .mc-v'
    );

    // Primary: engine built MORE than totalAvailableStacks (16) lineups — proof the
    // recycle cycle fired and the engine didn't deadlock at the stack boundary.
    const builtText = await lineupCountEl.textContent() || '0';
    const built = parseInt(builtText, 10);
    expect(built).toBeGreaterThan(16);

    // User-visible confirmation: generation completed instead of getting stuck at the
    // recycle boundary and leaving a partial-result warning.
    await expect(page.locator('#portfolio-results')).not.toContainText('Only');
  });
});
