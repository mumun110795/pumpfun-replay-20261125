# pumpfun-replay-20261125

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mumun110795/pumpfun-replay-20261125/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mumun110795/pumpfun-replay-20261125/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the Pump.fun Replay Sprint. It is a momentum rider: it waits for a coin to show sustained buying pressure over a long lookback — rising over several minutes, with most of the recent volume on the buy side from many distinct buyers — enters once, banks half at +50%, and cuts everything else fast with a tight trailing exit, a hard stop, and a stale exit that frees the slot when a coin sits without moving. It recycles its five position slots steadily so it keeps trading fresh coins through the whole 24-hour window.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` JSONL protocol over stdin/stdout: it reads a hello message, then one batch of chain events per slot, and writes one reply with its orders per batch.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vdsf53gd&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
