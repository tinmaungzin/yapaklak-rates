import { mkdir, writeFile } from 'node:fs/promises';

const BINANCE_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const BYBIT_URL = 'https://api2.bybit.com/fiat/otc/item/online';
const OKX_URL = 'https://www.okx.com/v3/c2c/tradingOrders/books';
const ER_API_URL = 'https://open.er-api.com/v6/latest/USD';
const MIN_TRADABLE_QUANTITY = 100;
const ROWS = 20;
const MEDIAN_SAMPLE_SIZE = 10;

const headers = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

// These APIs expose the ad owner's side. The public rate side is inverted:
// our BUY rate comes from ads selling USDT, and our SELL rate comes from ads buying USDT.
const BYBIT_SIDE = {
  BUY: '1',
  SELL: '0',
};

const OKX_SIDE = {
  BUY: 'sell',
  SELL: 'buy',
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

function toNumber(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return Number.parseFloat(value.replaceAll(',', ''));
  }

  return Number.NaN;
}

function summarizeRows(rows, getPrice, getQuantity, success = true) {
  const prices = rows
    .map((row) => {
      const price = toNumber(getPrice(row));
      const quantity = toNumber(getQuantity(row));

      if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity < MIN_TRADABLE_QUANTITY) {
        return null;
      }

      return price;
    })
    .filter((price) => price !== null)
    .slice(0, MEDIAN_SAMPLE_SIZE);

  return {
    success,
    total: rows.length,
    usable: prices.length,
    median: median(prices),
  };
}

function summarizeBinanceResponse(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];

  return summarizeRows(
    rows,
    (row) => row?.adv?.price,
    (row) => row?.adv?.tradableQuantity,
    json?.success === true,
  );
}

function summarizeBybitResponse(json) {
  const rows = Array.isArray(json?.result?.items) ? json.result.items : [];

  return summarizeRows(
    rows,
    (row) => row?.price,
    (row) => row?.lastQuantity ?? row?.quantity,
    json?.ret_code === 0 || json?.retCode === 0 || json?.ret_code === '0' || json?.retCode === '0',
  );
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) ?? [];
}

function summarizeOkxResponse(json, requestedSide) {
  const data = json?.data;
  const sideRows = requestedSide === 'sell'
    ? firstArray(data?.sell, data?.sellAds, data?.offers?.sell)
    : firstArray(data?.buy, data?.buyAds, data?.offers?.buy);
  const fallbackRows = firstArray(data, data?.items, data?.orders);
  const rows = sideRows.length > 0 ? sideRows : fallbackRows;
  const success = json?.code === 0 || json?.code === '0' || json?.msg === 'success' || json?.success === true;

  return summarizeRows(
    rows,
    (row) => row?.price ?? row?.quotePrice ?? row?.fiatPrice,
    (row) => row?.availableAmount ?? row?.availableQuantity ?? row?.quantity ?? row?.baseAmount,
    success,
  );
}

async function parseJsonResponse(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

async function writeJson(path, value) {
  await mkdir('public', { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchBinanceSide(side) {
  const response = await fetch(BINANCE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fiat: 'MMK',
      asset: 'USDT',
      tradeType: side,
      page: 1,
      rows: ROWS,
      payTypes: [],
      publisherType: null,
    }),
  });

  const json = await parseJsonResponse(response, `Binance ${side}`);

  if (!response.ok) {
    throw new Error(`Binance ${side} HTTP ${response.status}`);
  }

  return summarizeBinanceResponse(json);
}

async function fetchBybitSide(side) {
  const bybitSide = BYBIT_SIDE[side];
  const response = await fetch(BYBIT_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tokenId: 'USDT',
      currencyId: 'MMK',
      side: bybitSide,
      size: String(ROWS),
      page: '1',
      payment: [],
    }),
  });

  const json = await parseJsonResponse(response, `Bybit ${side}`);

  if (!response.ok) {
    throw new Error(`Bybit ${side} HTTP ${response.status}`);
  }

  return summarizeBybitResponse(json);
}

async function fetchOkxSide(side) {
  const okxSide = OKX_SIDE[side];
  const url = new URL(OKX_URL);
  url.search = new URLSearchParams({
    t: String(Date.now()),
    quoteCurrency: 'MMK',
    baseCurrency: 'USDT',
    side: okxSide,
    paymentMethod: 'all',
    userType: 'all',
    showTrade: 'false',
    receivingAds: 'false',
  }).toString();

  const response = await fetch(url, {
    headers: {
      'User-Agent': headers['User-Agent'],
    },
  });

  const json = await parseJsonResponse(response, `OKX ${side}`);

  if (!response.ok) {
    throw new Error(`OKX ${side} HTTP ${response.status}`);
  }

  return summarizeOkxResponse(json, okxSide);
}

const SOURCES = [
  {
    name: 'binance',
    fetchSide: fetchBinanceSide,
  },
  {
    name: 'bybit',
    fetchSide: fetchBybitSide,
  },
  {
    name: 'okx',
    fetchSide: fetchOkxSide,
  },
];

async function fetchThbPerUsd() {
  const response = await fetch(ER_API_URL, {
    headers: {
      'User-Agent': headers['User-Agent'],
    },
  });

  const json = await parseJsonResponse(response, 'ER API');

  if (!response.ok) {
    throw new Error(`ER API HTTP ${response.status}`);
  }

  const thbPerUsd = Number(json?.rates?.THB);
  if (!Number.isFinite(thbPerUsd) || thbPerUsd <= 0) {
    throw new Error('ER API response did not include a usable THB rate');
  }

  return thbPerUsd;
}

function sideSummary(result) {
  return {
    success: result.success,
    total: result.total,
    usable: result.usable,
    median: result.median,
  };
}

async function probeSource(source) {
  const summary = {
    BUY: null,
    SELL: null,
  };

  for (const side of ['BUY', 'SELL']) {
    try {
      summary[side] = sideSummary(await source.fetchSide(side));
    } catch (error) {
      summary[side] = {
        success: false,
        total: 0,
        usable: 0,
        median: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return summary;
}

async function fetchWinningSource() {
  const probes = {};

  for (const source of SOURCES) {
    const summary = await probeSource(source);
    probes[source.name] = summary;

    if (summary.BUY.median !== null && summary.SELL.median !== null) {
      return {
        source,
        buyProbe: summary.BUY,
        sellProbe: summary.SELL,
        probes,
      };
    }
  }

  return {
    source: null,
    buyProbe: null,
    sellProbe: null,
    probes,
  };
}

function makeProbeDocument(probes, source = null) {
  return {
    epoch: unixSeconds(),
    updatedAt: new Date().toISOString(),
    source,
    probes,
  };
}

async function main() {
  const { source, buyProbe, sellProbe, probes } = await fetchWinningSource();

  if (source === null) {
    await writeJson('public/probe.json', makeProbeDocument(probes));
    process.exitCode = 2;
    return;
  }

  try {
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
      source: source.name,
      sampleCounts: {
        usdBuy: buyProbe.usable,
        usdSell: sellProbe.usable,
      },
      usdtThbPerUsd: thbPerUsd,
      probes,
    };

    await writeJson('public/latest.json', latest);
    console.log(
      `source=${source.name}; USD/MMK buy=${latest.data[0].buy} sell=${latest.data[0].sell}; THB/MMK buy=${latest.data[1].buy} sell=${latest.data[1].sell}; samples buy=${buyProbe.usable} sell=${sellProbe.usable}`,
    );
  } catch (error) {
    await writeJson('public/probe.json', {
      ...makeProbeDocument(probes, source.name),
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

await main();
