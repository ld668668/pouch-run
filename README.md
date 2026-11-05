# Pouch Run

An arcade runner for [Squeekchain](https://squeekchain.com), the hamster-powered proof-of-work toychain. Squeektoshi runs the real WHEELY9000 wheel; you run the track beside him, and his live wheel data changes the game while you play.

## How the wheel drives the game

| Live data (public Squeekchain API) | What it does in the game |
| --- | --- |
| `/v1/status` → `measurement.rpmMilli` | Track speed and your score multiplier. The faster he runs, the faster and more lucrative your run. |
| `/v1/status` → `measurement.coreStatus`, `freshness` | When he rests (or telemetry goes stale), night falls: you only see what your lantern lights, and seeds are worth double. |
| `/v1/measurement/blocks` | Every newly revealed provisional Squeek block drops a golden Block Seed (+250) labelled with its block height. |
| `/v1/status` → `measurement.distanceMm`, `builder.projected.blockHeight` | His distance today and the block height, shown on the menu and board. |

Projected blocks are provisional until they settle on Ethereum, and the game labels them that way. If the API can't be reached, the game switches to a clearly labelled Practice mode with a simulated wheel.

## Rules

- Switch lanes with ← → / A D, or swipe.
- Collect seeds into your cheek pouch (25 max). Your hamster's cheeks swell as it fills.
- Run into a burrow (or press Space near one) to stash the pouch and bank points at the current multiplier.
- Hit a rock or a trap and you lose a life and drop everything unbanked. Three lives.
- Local top-5 scores, and a share button for X.

## Optional onchain action

After a run you can "sign" it on the Sepolia testnet: the page asks your own browser wallet to send `approve(yourAddress, 0)` to the SQK token (`0xd78a3956cF63164d1Fa1C622ad3c66623162Fa1e`). It moves no tokens, and the game never asks for or holds keys.

## Run locally

It's a static site with no build step and no backend:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Notes

Community project, not affiliated with the Squeekchain team. Data from the public API documented at https://docs.squeekchain.com/developers/api/.

<!-- squeekchain repository line goes here -->
