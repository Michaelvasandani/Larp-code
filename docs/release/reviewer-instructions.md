# Chrome Web Store reviewer instructions

No reusable production credentials are embedded in the package. The Store
submission's private reviewer field must contain two publisher-created test
accounts and a disposable mailbox route, if the review environment cannot
create accounts through the public OTP flow. Do not paste those credentials
into this repository, a screenshot, or a release artifact.

## Two-account path

1. Install the candidate and open the popup. Select **Sign in**; the first OTP
   request is user initiated. Complete the code flow for reviewer account A.
2. Complete setup with a non-identifying display name and affirmative consent.
   Open **Legal and About** and **privacy.html** without signing out or
   granting any browser/page permission.
3. Create one Invitation for reviewer account B using dates at least one day in
   the future. Open a second Chrome profile, sign in as B, and accept the
   complete immutable terms.
4. Use the prepared reviewer fixture or the supplied dates to observe the
   Scheduled state, then the Active state. The extension does not infer or
   scrape a coding-site Solve.
5. In Active, select a catalog problem and explicitly affirm a Solve. Verify
   each Member sees only the authoritative shared Snapshot, separate totals,
   Pace Status, and the derived Pet Condition. Correct the claiming Member's
   own Solve and inspect the visible correction history.
6. Use a fixture with one Member behind schedule to see Hungry, Sad, or
   Deteriorated semantics and the slower Member's pace copy. The Pet is not a
   permission gate and no score is hidden.
7. Complete or abandon the Challenge to observe the terminal read-only state,
   the one-time Stage-4 farewell when applicable, and that the Pet disappears
   from the terminal page. Sign out from both profiles.
8. For deletion review, use a disposable test account, choose **Start account
   deletion**, confirm the accessible dialog, request a fresh email code, type
   `DELETE MY ACCOUNT`, and enter the fresh six-digit code. Confirm that local
   session/draft state is cleared and that the partner sees only the documented
   temporary Deleted Member record.

The popup may close when focus changes; reopen it after each such interruption.
The worker is restart-safe and the UI distinguishes an uncertain command from
an authoritative Snapshot. A reviewer should not expect notifications,
content-script controls, LeetCode login, or automatic verification because
those are deliberately outside this candidate's single purpose.

## Test data and safety

The publisher must provision disposable accounts and remove them after review.
They must not use a production Member account or share a real OTP. A prepared
Scheduled/Active fixture may be created through the same authenticated backend
with the publisher's ordinary release tooling; fixture creation is not a
permission or reviewer credential in the extension package.
