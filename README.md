Market reference exchange rates for MMK derived from public P2P market data. Informational only.

## JSON schema

`public/latest.json`

```json
{
  "epoch": 0,
  "data": [
    {
      "currency": "USD",
      "buy": "0.00",
      "sell": "0.00"
    },
    {
      "currency": "THB",
      "buy": "0.00",
      "sell": "0.00"
    }
  ],
  "updatedAt": "1970-01-01T00:00:00.000Z",
  "source": "binance-p2p",
  "sampleCounts": {
    "usdBuy": 0,
    "usdSell": 0
  },
  "usdtThbPerUsd": 0
}
```

`public/probe.json`

```json
{
  "epoch": 0,
  "updatedAt": "1970-01-01T00:00:00.000Z",
  "source": "binance-p2p",
  "queries": {
    "BUY": {
      "success": true,
      "total": 0,
      "usable": 0
    },
    "SELL": {
      "success": true,
      "total": 0,
      "usable": 0
    }
  }
}
```
