# Provenance

Declaration of independent development, dated 27 September 2026.

Every line of code in this repository was written on 27 September 2026 from the specification in `SPEC.md`, starting from an empty directory. No source code, configuration, schema, test or document was copied from any other codebase, public or private, including any codebase the author has built or contributed to for other ventures.

The ideas are drawn from public sources and are stated here so nobody has to guess:

- Survival tiers, heartbeat slowdown, forced sleep on idle turns and death at zero balance come from Conway Research's Automaton (MIT, https://github.com/Conway-Research/automaton). Reins keeps the control ideas and drops the wallet.
- Policy checks on tool calls, protected files, blocked command patterns and an audit trail are common practice in agent runtimes and in the Automaton repository above.
- Hash chained append only logs are a standard construction. The chain format in `SPEC.md` was written fresh for this project.
- The control identifiers (SOC 2 Trust Services Criteria, ISO 27001:2022 Annex A, NIST AI RMF 1.0, EU AI Act Articles 12 and 14) are public frameworks. The one sentence statements in `packages/core/src/controls.ts` were written for this project.
- Anthropic and OpenAI API shapes come from their public documentation. Model prices in `packages/core/src/prices.ts` were taken from the providers' public pricing pages on 27 September 2026.

Copyright in this repository is held by Richard Liddle and licensed under the MIT licence in `LICENSE`. Contributions are accepted under the Developer Certificate of Origin (https://developercertificate.org/): sign your commits with `git commit -s`.

This file is part of the record. If a later commit changes the origin of any part of the code, it must update this file in the same commit.
