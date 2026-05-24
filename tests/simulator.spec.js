// @ts-check
const { test, expect } = require('@playwright/test');
const { uploadFiles, smallSlateFixture } = require('./helpers/fixtures');

async function uploadBaseFiles(page) {
  await uploadFiles(
    page,
    ['simulator_dk.csv', smallSlateFixture.dkCsv],
    ['simulator_roo.csv', smallSlateFixture.rooCsv]
  );
}

async function injectFullLineup(page) {
  await page.evaluate((names) => {
    const pool = STATE.POOL;
    STATE.lineup = names.map(name => pool.find(player => player.name === name) || null);
  }, smallSlateFixture.lineupNames);
}

test.describe('Simulator and sim-filter coverage', () => {
  test('portfolio sim filter defaults to 1500 sims', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab:has-text("Portfolio")').click();
    await expect(page.locator('#port-sim-filter-sims')).toHaveValue('1500');
  });

  test('runSimulation reads current sim count and slider values from the UI', async ({ page }) => {
    await page.goto('/');
    await uploadBaseFiles(page);
    await injectFullLineup(page);

    await page.evaluate(() => {
      window.__simCapture = { corrScale: null, simDiversity: null, numSims: null };

      const originalSetCorrScale = Engine.setCorrScale;
      const originalSetSimDiversity = Engine.setSimDiversity;
      const originalSimulateLineup = Engine.simulateLineup;

      Engine.setCorrScale = (value) => {
        window.__simCapture.corrScale = value;
        return originalSetCorrScale(value);
      };
      Engine.setSimDiversity = (value) => {
        window.__simCapture.simDiversity = value;
        return originalSetSimDiversity(value);
      };
      Engine.simulateLineup = (lineup, numSims) => {
        window.__simCapture.numSims = numSims;
        return {
          mean: 101.2,
          std: 12.4,
          p10: 85.0,
          p50: 101.0,
          p90: 118.0,
          p99: 129.0,
          max: 133.0,
          min: 72.0,
          correlationScore: 0.381,
          numSims,
          meanSE: 0,
          p50SE: 0,
          histogram: [
            { lo: 70, hi: 85, count: 2 },
            { lo: 85, hi: 100, count: 5 },
            { lo: 100, hi: 115, count: 7 },
            { lo: 115, hi: 130, count: 4 },
          ],
          playerStats: lineup.filter(Boolean).map((player) => ({
            name: player.name,
            mean: player.median || 10,
            p10: Math.max((player.floor || 0), 1),
            p50: player.median || 10,
            p90: player.ceiling || 20,
            std: 3,
            bustRate: 0.1,
            boomRate: 0.2,
          })),
        };
      };
    });

    await page.locator('.tab:has-text("Simulator")').click();
    await page.selectOption('#sim-count', '25000');
    await page.locator('#sim-corr-scale').evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, '1.7');
    await page.locator('#sim-diversity').evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, '1.4');
    await page.locator('#run-sim-btn').click();

    await page.waitForFunction(() => window.__simCapture && window.__simCapture.numSims === 25000);
    const capture = await page.evaluate(() => window.__simCapture);
    expect(capture).toEqual({ corrScale: 1.7, simDiversity: 1.4, numSims: 25000 });
    await expect(page.locator('#sim-results')).toContainText('25,000 sims');
    await expect(page.locator('#sim-results')).toContainText('Corr Score');
  });

  test('simulator settings persist across reload', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab:has-text("Simulator")').click();
    await page.selectOption('#sim-count', '50000');
    await page.locator('#sim-corr-scale').evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, '1.8');
    await page.locator('#sim-diversity').evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, '1.6');

    await page.evaluate(() => {
      const simFilterSims = document.getElementById('port-sim-filter-sims');
      simFilterSims.value = '2100';
      simFilterSims.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await page.reload();

    await page.locator('.tab:has-text("Simulator")').click();
    await expect(page.locator('#sim-count')).toHaveValue('50000');
    await expect(page.locator('#sim-corr-scale')).toHaveValue('1.8');
    await expect(page.locator('#sim-diversity')).toHaveValue('1.6');
    await expect(page.locator('#corr-scale-label')).toHaveText('1.8×');
    await expect(page.locator('#diversity-label')).toHaveText('1.6×');

    await page.locator('.tab:has-text("Portfolio")').click();
    await expect(page.locator('#port-sim-filter-sims')).toHaveValue('2100');
  });

  test('portfolio sim ROI diagnostics explain empty and zero-band results', async ({ page }) => {
    await page.goto('/');
    await uploadBaseFiles(page);
    await page.locator('.tab:has-text("Portfolio")').click();
    await page.locator('#port-sim-filter').check();
    await page.locator('#port-sim-roi-min').fill('5');
    await page.locator('#port-sim-roi-max').fill('15');

    await page.evaluate(() => {
      renderPortfolioResults({ lineups: [], _diag: { dupFail: 2 } });
    });
    await expect(page.locator('#portfolio-results')).toContainText('Sim ROI band is enabled');

    await page.evaluate(() => {
      const lineup = STATE.POOL.slice(0, 10);
      const totalLineups = 1;
      const playerExposure = {};
      lineup.forEach((player) => {
        playerExposure[player.name] = {
          count: 1,
          pct: '100.0',
          isPitcher: player.dkPos === 'P',
        };
      });
      renderPortfolioResults({
        lineups: [lineup],
        requested: 3,
        totalLineups,
        playerExposure,
        diversity: {
          score: 44,
          avgOverlap: 4,
          maxOverlap: 4,
          maxGameExposurePct: 0.3,
          gameExposure: { 'NYY@BOS': 1 },
          distribution: { 4: 1 },
        },
        simFilterStats: {
          generated: 12,
          inBand: 0,
          backfilled: 1,
          simROIMin: 5,
          simROIMax: 15,
          simROIMean: 3,
        },
        _diag: { overlapFail: 0, dupFail: 0, nullLu: 0, stackSizeFail: 0, incompleteLu: 0, gameCapFail: 0 },
        exposureRelaxUsed: 0,
        virtualStackTeams: [],
        pitcherWarnings: [],
        bannedTeams: [],
        lockedTeams: [],
        teamExposureWarnings: [],
      });
    });

    await expect(page.locator('#portfolio-results')).toContainText('0 candidates met your ROI band');
    await expect(page.locator('#portfolio-results')).toContainText('All selected lineups were backfilled from outside the band');
  });
});