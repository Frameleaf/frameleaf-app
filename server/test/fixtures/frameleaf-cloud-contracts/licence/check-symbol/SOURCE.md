# Source

Copied unmodified from `Frameleaf/frameleaf-cloud` commit `8bf5b83ed2a5a4ce22b64f553a6f48ec78768504`
(`feat: FC-22 Luhn mod 32 check symbol for licence keys`), path
`packages/contracts/fixtures/licence/check-symbol/`.

These fixtures exercise `licenseKeyCheckSymbol` in
`packages/contracts/src/licence/key-format.ts` at the same commit (as-built decision #40): Luhn
mod 32 over the kind value (`S` 16, `I` 8) and the ten body symbols. Server and web drive
`checkLicenseKey` / `validateProductKey` from these same files (FL-182) so both ends of the check
stay in step with the reference.

Files: `valid.json`, `substitutions.json`, `transpositions.json`, `upstream.json`,
`normalise.json`.
