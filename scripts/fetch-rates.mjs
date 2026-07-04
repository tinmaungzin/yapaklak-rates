import { mkdir, writeFile } from 'node:fs/promises';

const BINANCE_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const ER_API_URL = 'https://open.er-api.com/v6/latest/USD';
const MIN_TRADABLE_QUANTITY = 100;
const ROWS = 20;
const MEDIAN_SAMPLE_SIZE = 10;

const headers = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

function unixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function roundMoney(value) {
  return value.toFixed(2);
}

function median(values) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }

  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarizeBinanceResponse(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const prices = rows
    .map((row) => {
      const price = Number.parseFloat(row?.adv?.price);
      const quantity = Number.parseFloat(row?.adv?.tradableQuantity);

      if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity < MIN_TRADABLE_QUANTITY) {
        return null;
      }

      return price;
    })
    .filter((price) => price !== null)
    .slice(0, MEDIAN_SAMPLE_SIZE);

  return {
    success: json?.success === true,
    total: rows.length,
    usable: prices.length,
    median: median(prices),
  };
}

async function writeJson(path, value) {
  await mkdir('public', { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchBinanceRates(tradeType) {
  const response = await fetch(BINANCE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fiat: 'MMK',
      asset: 'USDT',
      tradeType,
      page: 1,
      rows: ROWS,
      payTypes: [],
      publisherType: null,
    }),
  });

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new Error(`Binance ${tradeType} returned invalid JSON: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Binance ${tradeType} HTTP ${response.status}`);
  }

  return summarizeBinanceResponse(json);
}

async function fetchThbPerUsd() {
  const response = await fetch(ER_API_URL, {
    headers: {
      'User-Agent': headers['User-Agent'],
    },
  });

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new Error(`ER API returned invalid JSON: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`ER API HTTP ${response.status}`);
  }

  const thbPerUsd = Number(json?.rates?.THB);
  if (!Number.isFinite(thbPerUsd) || thbPerUsd <= 0) {
    throw new Error('ER API response did not include a usable THB rate');
  }

  return thbPerUsd;
}

async function main() {
  try {
    const [buyProbe, sellProbe] = await Promise.all([fetchBinanceRates('BUY'), fetchBinanceRates('SELL')]);
    const probe = {
      epoch: unixSeconds(),
      updatedAt: new Date().toISOString(),
      source: 'binance-p2p',
      queries: {
        BUY: {
          success: buyProbe.success,
          total: buyProbe.total,
          usable: buyProbe.usable,
        },
        SELL: {
          success: sellProbe.success,
          total: sellProbe.total,
          usable: sellProbe.usable,
        },
      },
    };

    if (buyProbe.usable === 0 && sellProbe.usable === 0) {
      await writeJson('public/probe.json', probe);
      process.exitCode = 2;
      return;
    }

    if (buyProbe.median === null || sellProbe.median === null) {
      throw new Error(`Missing usable Binance prices: BUY=${buyProbe.usable}, SELL=${sellProbe.usable}`);
    }

    const thbPerUsd = await fetchThbPerUsd();
    const thbMmkBuy = buyProbe.median / thbPerUsd;
    const thbMmkSell = sellProbe.median / thbPerUsd;
    const latest = {
      epoch: unixSeconds(),
      data: [
        {
          currency: 'USD',
          buy: roundMoney(buyProbe.median),
          sell: roundMoney(sellProbe.median),
        },
        {
          currency: 'THB',
          buy: roundMoney(thbMmkBuy),
          sell: roundMoney(thbMmkSell),
        },
      ],
      updatedAt: new Date().toISOString(),
      source: 'binance-p2p',
      sampleCounts: {
        usdBuy: buyProbe.usable,
        usdSell: sellProbe.usable,
      },
      usdtThbPerUsd: thbPerUsd,
    };

    await writeJson('public/latest.json', latest);
    console.log(
      `USD/MMK buy=${latest.data[0].buy} sell=${latest.data[0].sell}; THB/MMK buy=${latest.data[1].buy} sell=${latest.data[1].sell}; samples buy=${buyProbe.usable} sell=${sellProbe.usable}`,
    );
  } catch (error) {
    await writeJson('public/probe.json', {
      epoch: unixSeconds(),
      updatedAt: new Date().toISOString(),
      source: 'binance-p2p',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

await main();
