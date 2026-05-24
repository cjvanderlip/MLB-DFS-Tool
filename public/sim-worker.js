// sim-worker.js — Web Worker for CPU-heavy portfolio generation and simulation.
// Runs Engine.buildPortfolio and Engine.simulatePortfolio off the main thread
// so the UI stays responsive during long sim-filter passes (60s+ for large portfolios).
//
// importScripts loads engine.js into this worker's global lexical scope,
// making Engine available as a top-level binding in subsequent code.
importScripts('engine.js');

self.onmessage = async function({ data }) {
  const { type, payload } = data;
  try {
    if (type === 'buildPortfolio') {
      const { pool, opts, corrScale, simDiversity } = payload;
      if (corrScale != null) Engine.setCorrScale(corrScale);
      if (simDiversity != null) Engine.setSimDiversity(simDiversity);

      const result = await Engine.buildPortfolio(pool, opts, (built, target) => {
        self.postMessage({ type: 'progress', built, target });
      });

      self.postMessage({ type: 'result', result });

    } else if (type === 'simulatePortfolio') {
      const {
        lineups, pool, numSims, contestType,
        manualCashLine, manualWinLine, payoutType, contestSize, skipLineupStats,
        corrScale, simDiversity, customPayoutConfig,
      } = payload;
      if (corrScale != null) Engine.setCorrScale(corrScale);
      if (simDiversity != null) Engine.setSimDiversity(simDiversity);

      const results = await Engine.simulatePortfolio(
        lineups, pool, numSims, contestType,
        manualCashLine, manualWinLine, payoutType, contestSize, skipLineupStats,
        null, customPayoutConfig || null
      );
      self.postMessage({ type: 'result', results });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
