# PI-05 / CA operator checklist

This checklist is intentionally separate from engineering work. No step below
is approved merely because an engineering test passes.

## Incident containment

- [x] Preserve incident records.
- [ ] Owner verifies the recorded shell artifact path and applies mode `0600`
      without changing bytes.
- [ ] Owner restricts OpenCode/session access to authorized personnel.
- [x] No certificate issuance, CA authentication, revocation, restart or
      configuration mutation performed by the agent.

## CA recovery approval

- [ ] Approve CA downtime and staged configuration activation.
- [ ] Decide whether `sme-dev-admin` receives a new JWK key pair and `kid`.
- [ ] Determine disposition of broker/storage and other JWK provisioners.
- [ ] Approve online intermediate-key password rotation.
- [ ] Place the root key in approved offline custody.
- [ ] Define backup retention and recovery authority.

## Post-rotation verification

- [ ] CA health and HTTPS trust pass.
- [ ] Root/intermediate certificate fingerprints unchanged unless a new
      hierarchy was explicitly approved.
- [ ] Provisioner names, key IDs, claims and templates match the decision.
- [ ] Existing shared certificates remain valid.
- [ ] No unapproved issuance occurred during maintenance.
- [ ] Fresh enrollment is separately approved and performed by a human in a
      trusted terminal.

## Release gate

- [ ] All ten real PI-05 scenarios have independent receipts.
- [ ] Proof receipts, transport evidence and alert policy are independently
      reviewed.
- [ ] PI-06 release gate returns `READY_FOR_OPERATOR_APPROVAL`.
- [ ] A separate human authorizes release; the gate never deploys.
