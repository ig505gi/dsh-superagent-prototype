---
name: dsh-superagent-gitlab
description: Work with this ticket's GitLab merge request and CI using glab.
---

Use glab as the configured agent account for the project in DSH_SUPERAGENT_GITLAB_PROJECT on DSH_SUPERAGENT_GITLAB_HOST.
Create a branch whose final path segment is DSH_SUPERAGENT_NAME, push it, create an MR, and report its IID as pr_number.
Use `glab mr create` and `glab mr view` with the configured repository; inspect `glab mr --help` for supported options.
To set auto-merge, use the GitLab v4 MR merge endpoint with `auto_merge=true` and the current head `sha`; use `glab api --hostname "$DSH_SUPERAGENT_GITLAB_HOST"` and an explicitly URL-encoded project path.
Pass the Boolean as `-F auto_merge=true`, the SHA as `-f "sha=$head_sha"`, and use `-X PUT` with `projects/$encoded_project/merge_requests/$iid/merge`.
First verify the server version supports the `auto_merge` parameter, the project requires a successful pipeline, skipped pipelines are not allowed if that option exists, and the MR has a pipeline for the current head. If any prerequisite cannot be verified, report a blocker without calling the merge endpoint; an unsupported parameter might be ignored.
To stop a requested auto-merge, call the MR `cancel_auto_merge` endpoint, or `cancel_merge_when_pipeline_succeeds` on an older supported server; verify that cancellation succeeded. If it already merged, report that outcome instead.
Read the MR and its pipeline with glab; use CI job logs when needed to fix a failure, without exposing credentials.
GitLab project permissions and branch rules remain authoritative.
