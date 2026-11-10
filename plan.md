# PI-01 Audit Plan (executed on api/module-product-integration)

## Repository Findings
- The Core API is a feature-first modular monolith; AI has a private Assistant answer endpoint, but Core lacks a public Assistant module.
- RE05-DATABASE.md omits the PARTIAL status present in the AI result contract; citation source revision/claim traceability requires explicit contract alignment.
- RAG-T06 reports deterministic test coverage but leaves five live acceptance scenarios NOT RUN and incomplete inventory coverage.
- API CI runs on api/** pushes; AI CI previously did not, despite Core–AI changes in the API package.

## Affected Files
- services/api/docs/PI01-INTEGRATION-AUDIT.md and PI01-INVENTORY.json
- services/api/scripts/verify_pi01_inventory.py and test_verify_pi01_inventory.py
- .github/workflows/api-ci.yml and ai-ci.yml
- plan.md

## Proposed Changes
- Record a requirement-ID-linked, source-path-backed inventory with distinct implementation/integration/verification states, explicit risk owners and no invented live-pass claims.
- Add a dependency-free verification script with negative tests, integrated into existing API CI.
- Close the AI CI api-branch trigger gap, keeping all existing checks.
- Do not change canonical global requirements or build new Assistant/RAG features as part of an audit.

## Focused Verification
- python3 scripts/verify_pi01_inventory.py
- python3 -m unittest discover -s scripts -p 'test_verify_pi01_inventory.py'
- Existing API CI Maven verify and AI CI full suite on GitHub for this branch.
- Check that every required workflow concludes success; report any external/environment blocker, never convert skipped tests into success evidence.
