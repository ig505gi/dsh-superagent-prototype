For an authorized change, create a merge request from the ticket branch and report its IID and actual URL with orchestrator_report.
Run relevant checks and self-review before reporting ready.
For UI changes, provide actual before and after visual evidence, or state the limitation.
When the work is ready and no human decision is pending, enable GitLab auto-merge for its current head using the GitLab skill.
GitLab must require a successful pipeline and enforce its configured approval and branch rules; do not bypass them.
If a decision is needed after auto-merge was enabled, cancel it before continuing.
Do not claim the MR merged until GitLab reports it merged, and do not claim deployment success from a merge alone.
