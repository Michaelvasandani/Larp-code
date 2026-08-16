# Chrome Extension Launch Checklist

## Code and integration

- [x] Build Manifest V3 extension.
- [x] Implement popup, service worker, authentication, challenges, and Grovekin.
- [x] Add automated tests, package checks, and Chrome smoke tests.
- [x] Reconcile the untracked `tests/grovekin.test.ts` file on `main`.
- [x] Merge `codex/ticket-41` into `main`.
- [x] Push the integrated `main` branch.

## Product identity

- [ ] Choose the final product name.
- [ ] Purchase or configure a production domain.
- [ ] Create a monitored support email or support page.
- [ ] Publish the privacy policy at a public HTTPS URL.
- [ ] Confirm the NeetCode/LeetCode non-affiliation and license wording.
- [ ] Review and accept the documented catalog and brand risks.

## Production Supabase

- [x] Create a production Supabase project.
- [ ] Use a paid, non-pausable configuration.
- [ ] Enable MFA on the Supabase owner account.
- [x] Deploy all database migrations.
- [x] Import the reviewed 150-problem catalog.
- [x] Deploy Edge Functions.
- [ ] Configure scheduled lifecycle and retention jobs.
- [x] Verify RLS and least-privilege grants.
- [ ] Enable SSL enforcement.
- [ ] Configure production Auth and OTP limits.
- [ ] Configure backups and, if required, PITR.
- [x] Verify the extension only receives the publishable/anon key.
- [x] Confirm no `service_role` key or database credential enters the package.

Reference: [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod)

## Production email

- [ ] Create a Resend account.
- [ ] Add an authentication-only subdomain such as `auth.example.com`.
- [ ] Configure SPF.
- [ ] Configure DKIM.
- [ ] Configure DMARC.
- [ ] Disable open and click tracking.
- [ ] Configure Resend as Supabase custom SMTP.
- [ ] Configure appropriate OTP and email rate limits.
- [ ] Test OTP delivery to Gmail, Outlook, and another major provider.
- [ ] Test transactional invitation and lifecycle messages.
- [ ] Confirm emails contain no unnecessary member information.

References: [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [Resend domains](https://resend.com/docs/dashboard/domains/introduction)

## Monitoring and recovery

- [ ] Monitor backend availability.
- [ ] Monitor migration status.
- [ ] Monitor scheduled jobs and retention.
- [ ] Monitor transactional email failures.
- [ ] Configure privacy-safe error diagnostics.
- [ ] Confirm logs exclude emails, OTPs, tokens, and member data.
- [ ] Perform a production backup/restore rehearsal.
- [ ] Verify rollback and fix-forward procedures.
- [ ] Record privacy-safe evidence of the recovery test.

## Production testing

- [ ] Install a production-configured unpacked build.
- [ ] Create two disposable test accounts.
- [ ] Test OTP sign-in.
- [ ] Test first-time setup and consent.
- [ ] Test invitation creation and delivery.
- [ ] Test invitation acceptance.
- [ ] Test Scheduled-to-Active progression.
- [ ] Test Solve and Correction flows.
- [ ] Test shared pace and Grovekin conditions.
- [ ] Test all four Grovekin stages.
- [ ] Test Hungry, Sad, and Deteriorated states.
- [ ] Test Solve, evolution, and farewell animations.
- [ ] Test reduced-motion behavior.
- [ ] Test popup closure and worker restart recovery.
- [ ] Test completion and abandonment.
- [ ] Test sign-out.
- [ ] Test account deletion.
- [ ] Confirm no LeetCode or NeetCode page access occurs.
- [ ] Capture a production-controlled network trace.

## Release candidate

- [ ] Complete the human visual and disclosure review.
- [ ] Complete and sign `docs/release/gate5-attestation.json`.
- [ ] Update the qualification record with production evidence.
- [ ] Build the production ZIP:

  ```bash
  PUBLICATION_MODE=release \
  PUBLICATION_BACKEND_ORIGIN=https://your-production-backend.example \
  PUBLICATION_ANON_KEY=your-safe-publishable-key \
  pnpm publication:assemble
  ```

- [ ] Record the ZIP's SHA-256 digest.
- [ ] Run the release gate:

  ```bash
  PUBLICATION_BACKEND_ORIGIN=https://your-production-backend.example \
  PUBLICATION_ANON_KEY=your-safe-publishable-key \
  pnpm release:check
  ```

- [ ] Confirm `release:check` exits successfully.
- [ ] Independently verify the final ZIP digest.
- [ ] Archive the exact source commit, ZIP, digest, and release evidence.

## Chrome Web Store account

- [ ] Create a dedicated publisher Google account.
- [ ] Enable 2-Step Verification.
- [ ] Register as a Chrome Web Store developer.
- [ ] Pay the one-time registration fee.
- [ ] Verify the publisher contact email.
- [ ] Set the publisher name.
- [ ] Add trusted tester accounts.

Reference: [Chrome Web Store registration](https://developer.chrome.com/docs/webstore/register)

## Store listing

- [ ] Upload the qualified ZIP.
- [ ] Add the prepared detailed description.
- [ ] Add screenshots and promotional artwork.
- [ ] Enter the public privacy-policy URL.
- [ ] Enter the monitored support route.
- [ ] Declare the extension's single purpose.
- [ ] Justify the `storage` permission.
- [ ] Justify the exact backend host permission.
- [ ] Declare that no remote code is executed.
- [ ] Complete all user-data category selections.
- [ ] Complete the Limited Use certification.
- [ ] Add reviewer instructions.
- [ ] Provide disposable reviewer accounts privately.
- [ ] Choose distribution regions.
- [ ] Select **Private** visibility for the first beta.

## Review and launch

- [ ] Submit the private beta for review.
- [ ] Select deferred publishing.
- [ ] Address any reviewer questions or rejection findings.
- [ ] Publish to trusted testers.
- [ ] Monitor authentication, mail, errors, and support requests.
- [ ] Fix beta issues and increment the extension version.
- [ ] Submit the public candidate for review.
- [ ] Verify the approved package matches the recorded digest.
- [ ] Publish publicly.
- [ ] Continue monitoring Store notices and policy changes.
