# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/shhptr/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/shhptr/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

A single-file Node entry (`main.ts`, standard library only) that serves
OpenAI- and Anthropic-shaped clients from live free models on OpenRouter,
dialled through the grader's gateway.

## How it works

- The trial brief is the catalogue: it lists the free models with their
  house ratings and capabilities, and the prompts in sending order.
- Routing is capability-first, rating-second. A prompt only goes to free
  models the brief marks as natively supporting what it needs (tools,
  vision, strict JSON), best rating first, model id as the tie-break.
- Every upstream answer is buffered and judged before a single byte is
  committed to the client. A refusal, an empty body, an error object in a
  200, a missing usage block, a stream that dies before its finish chunk,
  or an answer missing the token the prompt asked for fails over to the
  next candidate — recovered prompts carry the
  `x-makefun-upstream-failures` trail naming each failure in order.
- Answers are relayed exactly as the gateway produced them, with the
  dialled model id put back on every answer and every chunk. Nothing is
  patched, repaired, or invented locally.
- No output reads the wall clock or a random source, so a replay of a
  trial reproduces the live pass byte for byte.

## Run it

```sh
# Run the local test suite (mock gateway + mock environment, no keys, no
# network):
node test/run_tests.mjs

# Print the served catalog (the same document the server registers):
MAKEFUN_PROMPT_FILE=<trial brief> node main.ts --list
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=w4kvb54w&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
