// @ts-check
const { test, expect } = require('@playwright/test');
const { uploadFiles, richPortfolioFixture } = require('./helpers/fixtures');

test('portfolio diagnostic with stacks — capture DOM state', async ({ page }) => {
  test.setTimeout(180000);

  const logs = [];
  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('[Portfolio]') || t.includes('[Stacks]')) logs.push('[' + msg.type() + '] ' + t);
  });
  page.on('pageerror', e => logs.push('[ERROR] ' + e.message));

  await page.goto('/');
  await uploadFiles(
    page,
    ['DKSalaries.csv', richPortfolioFixture.dkCsv],
    ['roo_projections.csv', richPortfolioFixture.rooCsv],
    ['stacks_3man.csv', richPortfolioFixture.stacks3Csv],
    ['stacks_5man.csv', richPortfolioFixture.stacks5Csv]
  );
  await page.waitForTimeout(800);

  await page.locator('.tab:has-text("Portfolio")').click();
  await page.locator('#port-num-lineups').fill('20');
  await page.locator('#port-max-overlap').fill('0');
  await page.locator('#gen-portfolio-btn').click();

  // Wait 90s then capture whatever is rendered
  await page.waitForTimeout(90000);

  const portfolioHtml = await page.locator('#portfolio-results').innerHTML();
  const mcValues = await page.locator('#portfolio-results .mc-v').allTextContents();

  console.log('=== MC-V VALUES (first=lineup count) ===');
  console.log(JSON.stringify(mcValues));
  console.log('=== PORTFOLIO HTML SNIPPET ===');
  console.log(portfolioHtml.slice(0, 700));
  console.log('=== ENGINE LOGS ===');
  logs.forEach(l => console.log(l));

  expect(true).toBe(true);
});
