# Ticket 40 human disclosure and visual review checklist

This file is a sign-off form. Empty boxes are intentional: automation must not
fabricate human review evidence.

- [ ] Publisher confirms the final HTTPS privacy URL serves the packaged
  `privacy.html` content without authentication.
- [ ] Publisher confirms the Store name, description, permission reasons,
  data-category choices, provider list, and Limited Use assertion match
  `store-listing.md` and the candidate ZIP.
- [ ] Publisher confirms the support/contact route is monitored and suitable
  for privacy and security requests.
- [ ] Rights review confirms the project-authored Grovekin ledger and pinned
  catalog notices are accepted for the intended distribution; no rights-holder
  authorization is implied.
- [ ] Human reviewer inspects the popup at 380×600 and 800×600, reduced motion,
  the four Stage/Condition still semantics, and the listing promo/screenshots.
- [ ] Human reviewer follows `reviewer-instructions.md` with disposable,
  publisher-provisioned accounts and records only non-sensitive outcomes.
- [ ] Publisher records the final archive SHA-256, backend origin, version,
  provider configuration, and date in the release record.

Until every applicable box is checked by the responsible human, Gate 5 is
pending even if `publication:check` passes. The signed/dated replacement for
[`gate5-attestation.json`](gate5-attestation.json) is required by
`pnpm release:check`; the pending template must not be edited to claim human
work that did not happen.
