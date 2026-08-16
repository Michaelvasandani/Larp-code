# Shared NeetCode Pet

This context describes the shared accountability journey undertaken by two friends and the virtual pet whose condition reflects their progress.

## Language

**Challenge**:
A time-bounded attempt by exactly two Members to restart and complete the NeetCode 150 from zero credited progress, with one shared calendar, hard deadline, and Pet. It succeeds when both Members complete all 150 problems during the Challenge; otherwise it ends incomplete.
_Avoid_: Group, team, campaign

**Challenge Time Zone**:
The shared time zone whose calendar dates and day boundaries govern a Challenge. It is fixed before the Challenge begins and applies equally to both Members regardless of their local time zones.
_Avoid_: Member time zone, local day

**Member**:
One of the two equal participants in a Challenge, identified through a persistent Member Account. Inviter status grants no special authority after Invitation acceptance.
_Avoid_: User, player, friend

**Member Account**:
A person's stable email-based identity with a required, non-unique display name. It is accessed on any browser through an emailed one-time sign-in code and has no alternate recovery channel if control of that email is lost.
_Avoid_: Username, anonymous profile, device identity, password, magic link

**Suspended Member Account**:
A Member Account whose service access has been disabled for clear technical abuse or security attacks rather than for disputed Solve truthfulness or interpersonal conflict.
_Avoid_: Banned player, reported Member

**Member Data**:
Information tied to a Member Account or its participation in a Challenge and used only to authenticate the Member, operate the shared experience, secure the service, or diagnose failures. It excludes advertising, profiling, sale, cross-site browsing data, and product analytics in the MVP.
_Avoid_: Tracking data, marketing profile

**Transactional Notice**:
A one-time operational email required for authentication or account security, to deliver an Invitation, or to tell a Member that the other Member changed an Invitation or ended their shared commitment. It is generic outside the authenticated extension, never reports progress or Pet state, cannot be muted, and is not a recurring reminder or marketing message.
_Avoid_: Reminder, nudge, activity alert, marketing email

**Challenge Record**:
The shared record of a Challenge's terms, membership, lifecycle, credited Solves, Solve Corrections, and final totals. Both Members may read it, while neither Member gains authority to alter the other's contributions.
_Avoid_: Private progress, owner record

**Deleted Member**:
The non-identifying placeholder that replaces a deleted Member Account in a temporarily retained shared Challenge Record. It preserves the record's coherence but carries no account access or recovery relationship.
_Avoid_: Former account, recoverable Member

**Invitation**:
A pending, immutable proposal bound to one invited email address and containing the complete Challenge Time Zone, Start Date, and Deadline Date. The invited person may create their Member Account when opening it; the Invitation reserves no Challenge capacity, and changing any proposed term requires a replacement Invitation and fresh acceptance.
_Avoid_: Editable invite, Challenge membership

**Challenge Pair**:
The two equal Members joined by one Committed Challenge. It exists only through that Challenge; the MVP has no separate friendship, contact, or persistent pairing relationship.
_Avoid_: Friend list, permanent pair, team

**Expired Invitation**:
An Invitation that was not accepted before the proposed Start Date began in the Challenge Time Zone. It is terminal and cannot be reactivated.
_Avoid_: Late acceptance, paused invite

**Revoked Invitation**:
An Invitation withdrawn by its inviter before acceptance, including automatically when either participant commits to another Challenge. It is terminal and cannot be reactivated.
_Avoid_: Deleted invite, canceled Challenge

**Declined Invitation**:
An Invitation rejected by its invited Member before acceptance. It is terminal and cannot be reactivated.
_Avoid_: Revoked Invitation, canceled Challenge

**Scheduled Challenge**:
An accepted Challenge whose Start Date has not yet arrived. It consumes both Members' one-Challenge capacity and automatically becomes an Active Challenge when its Start Date begins in the Challenge Time Zone.
_Avoid_: Pending Invitation, draft Challenge

**Active Challenge**:
A Challenge whose governed time window has started and not yet ended. It consumes both Members' one-Challenge capacity.
_Avoid_: Scheduled Challenge, pending Invitation

**Committed Challenge**:
Either a Scheduled Challenge or an Active Challenge. A Member may belong to at most one Committed Challenge at a time.
_Avoid_: Active Challenge when including scheduled commitments

**Canceled Challenge**:
A Scheduled Challenge ended by either Member before its Start Date. It is terminal, frees both Members' capacity, and remains as a read-only record.
_Avoid_: Revoked Invitation, reset Challenge

**Abandoned Challenge**:
An Active Challenge ended early by either Member. It is terminal, preserves both Members' final credited totals, frees their capacity, and cannot continue with one or a replacement Member.
_Avoid_: Incomplete Challenge, paused Challenge, solo Challenge

**Restart**:
Creation of a distinct Challenge through a new Invitation after an earlier Challenge ends, always with zero credited progress and a new Pet. Previous partner, time zone, and duration may be prefilled, but new dates require fresh acceptance.
_Avoid_: Reset, reopen, resume

**Solve**:
A record that one Member completed one problem in the Challenge's problem set.
_Avoid_: Check-off, completion event

**Challenge Solve**:
A self-attested Solve credited because the Member affirms they completed or recompleted the problem during the active Challenge. Prior completion history grants no credit and does not prevent the problem from qualifying once during the Challenge.
_Avoid_: New submission, post-start acceptance

**Problem Set Version**:
An immutable edition of the Challenge's problem list, pinned when an Invitation is created so an accepted or active Challenge never changes when a later edition is introduced.
_Avoid_: Live NeetCode list, mutable catalog

**Self-attested Evidence**:
A Member's explicit assertion that they completed a problem; it supports cooperative accountability but is not independent verification.
_Avoid_: Verified Solve, proof

**Solve Correction**:
An auditable correction of a Member's own Solve that preserves the original claim while fixing whether or where its Challenge progress is credited.
_Avoid_: Deletion, partner rejection

**Expected Progress**:
The shared cumulative number of Challenge Solves each Member should have reached by the end of a given Challenge day to finish by the deadline. It follows a zero-to-150 trajectory and rounds each day's fractional target upward.
_Avoid_: Daily quota, daily streak

**Pace Status**:
A Member's recoverable relationship to Expected Progress: Behind, On Pace Today, or Today's Pace Met. Early Solves carry forward, and reaching the applicable cumulative target removes any prior shortfall without a separate streak or debt.
_Avoid_: Streak, daily score, missed-day penalty

**Pair Progress**:
The exact, unrounded arithmetic mean of the two Members' credited Challenge Solve totals. It drives the Pet's condition and evolution while each Member's own total and Pace Status remain separately visible.
_Avoid_: Team score, combined total, rounded average

**Pet**:
The single virtual creature that exists only while a Challenge is active, appearing when the Challenge starts and disappearing when it ends. Its presentation reflects the pair's progress through a recoverable Pet Condition and an irreversible Evolution Stage.
_Avoid_: Mascot, avatar, reward

**Pet Condition**:
The Pet's recoverable emotional state—Healthy, Hungry, Sad, or Deteriorated—derived from Pair Progress relative to the Challenge's current cumulative schedule bands. It changes presentation only and creates no penalty, progress loss, action restriction, or recovery debt.
_Avoid_: Health points, punishment, debuff

**Evolution Stage**:
One of four permanent forms attained by the Pet as Pair Progress reaches 0, 50, 100, and 150. The final stage appears in a one-time completion-and-farewell transition before the Pet disappears; an attained stage never regresses while the Challenge remains active.
_Avoid_: Pet level, temporary form
