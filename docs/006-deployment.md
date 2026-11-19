# 006 Deployment

Each Superagent instance runs a Node HTTP service with a React panel, a SQLite state directory and its own conversations on a same-machine Paseo daemon. Use one instance per monitored repository. The panel and API are described in [005 Panel](005-panel.md).

## Build from GitHub

Install Git and the Node and pnpm versions in package.json. Use a local Paseo 0.15.0 daemon with the providers you intend to run. Create Agent Profiles in Paseo and check that the chosen providers can run shell commands. Use the same operating-system account for Superagent and Paseo so both can access the workspaces and per-session tools.

Clone the GitHub repository or fork with the release, then build the chosen revision. Give the build account write access to /opt/superagent.

~~~sh
git clone https://github.com/OWNER/dsh-superagent-prototype.git /opt/superagent
cd /opt/superagent
git switch --detach RELEASE_COMMIT
pnpm install --frozen-lockfile
pnpm check
~~~

The build clears and regenerates lib/ for Node, then builds web/assets/ for the panel. Keep web/index.html, prompts/ and skills/ with the build. Install dependencies on the host that runs the build. Configure providers and Profiles in Paseo separately.

## Configure each instance

Copy the examples in examples/multi-instance/ and adjust the instance ID, absolute state directory and private panel listener. When using a private HTTPS proxy, set publicOrigin and allowedHosts to match its hostname and port, and preserve the Host header. Use a different port for each instance.

~~~json
{
  "instanceId": "project-a",
  "stateDir": "/var/lib/superagent/project-a",
  "host": "127.0.0.1",
  "port": 3083,
  "paseo": {
    "endpoint": "127.0.0.1:6767"
  }
}
~~~

Set SUPERAGENT_PASSWORD_FILE or SUPERAGENT_PASSWORD for panel login. If the daemon requires authentication, set PASEO_PASSWORD_FILE or PASEO_PASSWORD. Use one form per password. Keep any credential files at absolute paths readable by the service account. Supply DingTalk Stream credentials through that instance's DINGTALK_CLIENT_ID_FILE and DINGTALK_CLIENT_SECRET_FILE, or their inline environment equivalents.

The optional JSON fields paseo.main.profileId and paseo.worker.profileId seed unset roles with available Profiles from the daemon. Use the Profile IDs from Paseo. In the panel, **Settings → Eval** selects the main assessor and **Settings → Execution** selects the worker. Each instance stores the selection and its provider, model, mode, thinking option and feature values in orchestrator.sqlite. If either selection is missing, the panel stays available and shows where to complete setup. Saving both triggers another setup check. An upgrade from schema 11 clears earlier model routes that lack a Profile ID. Select Profiles in the panel or supply valid seeds for those roles.

When an assessor Profile changes, Superagent waits for the current main turn and its owned shell jobs to finish. It creates a conversation with the selected Profile, then cancels and archives the previous one. If creation fails, the overview reports the failure and the previous conversation remains available. When the instance starts without a usable main conversation, processing waits and the panel stays available. Save an available Profile under **Settings → Eval** to try again. New workers pick up a new worker Profile. Existing workers keep their original session and Profile.

## Install the system systemd template

The template starts the built entry from /opt/superagent and uses /etc/superagent/INSTANCE/config.json and /etc/superagent/INSTANCE/runtime.env. Replace User and Group in the installed unit or a systemd drop-in if the daemon runs under a different account.

~~~sh
sudo install -d -o root -g superagent -m 0750 /etc/superagent /etc/superagent/project-a /etc/superagent/project-b
sudo install -o root -g superagent -m 0640 examples/multi-instance/project-a.json /etc/superagent/project-a/config.json
sudo install -o root -g superagent -m 0640 examples/multi-instance/project-b.json /etc/superagent/project-b/config.json
sudo install -m 0600 examples/multi-instance/runtime.env.example /etc/superagent/project-a/runtime.env
sudo install -m 0600 examples/multi-instance/runtime.env.example /etc/superagent/project-b/runtime.env
sudo install -m 0644 examples/systemd/superagent@.service /etc/systemd/system/superagent@.service
~~~

In each runtime.env, point the credential-file variables to that instance's protected files. Use the installed unit's Group in the install commands if it differs from superagent. The system manager reads runtime.env and creates /var/lib/superagent/INSTANCE with private permissions for the service account.

~~~sh
sudo systemctl daemon-reload
sudo systemctl enable --now superagent@project-a.service superagent@project-b.service
sudo systemctl status superagent@project-a.service superagent@project-b.service
sudo journalctl -u superagent@project-a.service -u superagent@project-b.service
~~~

## Install the user systemd template

Use this template with the account that runs Paseo. With lingering already enabled for that account via `loginctl enable-linger`, its services can start at boot and keep running after logout. Build the same revision in `$HOME/.local/share/superagent/app` and make Node available on the user service manager's PATH.

Run these commands from the user build directory.

~~~sh
install -d -m 0755 "$HOME/.config/systemd/user"
install -d -m 0700 "$HOME/.config/superagent"
install -m 0644 examples/systemd/superagent-user@.service "$HOME/.config/systemd/user/"
for instance in project-a project-b; do
  install -m 0600 "examples/multi-instance/$instance.json" "$HOME/.config/superagent/$instance.json"
  install -m 0600 examples/multi-instance/runtime.env.example "$HOME/.config/superagent/$instance.env"
done
~~~

In each JSON file, set `stateDir` to the absolute path under `$HOME/.local/state/superagent/INSTANCE`, or use the matching path under `$XDG_STATE_HOME` if the user manager sets it. In each .env file, set the absolute paths to that instance's credential files. Then start the units as the same user.

~~~sh
systemctl --user daemon-reload
systemctl --user enable --now superagent-user@project-a.service superagent-user@project-b.service
systemctl --user status superagent-user@project-a.service superagent-user@project-b.service
journalctl --user -u superagent-user@project-a.service -u superagent-user@project-b.service
~~~

## Check the instances

Sign in to each panel at /login on its configured port. Management API requests require the login cookie, allowed Host, same Origin and the x-orchestrator-request header. The /healthz endpoint reports listener liveness. Use the overview to check setup, workers and Sources.

For a foreground or local background instance, use the same JSON config.

~~~sh
node lib/server/main.js --config /absolute/path/superagent.json
scripts/superagent start --config /absolute/path/superagent.json
scripts/superagent status --config /absolute/path/superagent.json
scripts/superagent stop --config /absolute/path/superagent.json
~~~

## Monitor multiple projects

- **DingTalk.** Give each instance its own bot application and Stream credentials. Connecting two readers to the same application can distribute messages between them, leaving an instance without the events it expects.
- **Paseo intake.** Assign different incoming Paseo conversation IDs to each instance. Each instance tracks its own cursor. Subscribe exactly one instance to an incoming conversation even if both use the same local daemon. Numbered answers return to the ticket in the originating conversation.
- **Repository and worktrees.** Give each instance its own base clone and configure its **Execution → Prepare command**. Use independent forge account directories and verify the account can push to the intended repository. Both templates set a separate GH_CONFIG_DIR and GLAB_CONFIG_DIR for each instance.

For example, prepare the two base repositories as the service account after creating a writable /srv/superagent-bases directory. Use the actual repository URLs and replace main in the script if a project has a different default branch.

~~~sh
git clone --no-checkout https://github.com/OWNER/PROJECT_A.git /srv/superagent-bases/project-a
git clone --no-checkout https://github.com/OWNER/PROJECT_B.git /srv/superagent-bases/project-b
~~~

Set Project A's Prepare command to `sh /opt/superagent/examples/multi-instance/prepare-worktree.sh project-a` and Project B's to `sh /opt/superagent/examples/multi-instance/prepare-worktree.sh project-b`. The script uses the ticket's DSH_SUPERAGENT_DIR and DSH_SUPERAGENT_NAME. Fetch each base clone as part of the project's regular repository update so new ticket branches start from the intended revision.

In each panel, set the repository and the dedicated gh or glab CLI under Sources. Startup checks account identity and push access, then prepares the worker Git config. Feishu uses a dedicated bot CLI in strict bot mode. Enable Sources after configuring their credentials and scope.

## Tools, state and recovery

Superagent gives each managed session the superagent-tool command and a private per-session capability file. The command reads schemas from POST /tools and invokes tools through POST /tool on the loopback gateway. The gateway applies the session's role and ticket checks. Any provider-native tools follow that provider's mode and permissions.

The first session prompt includes the active application instructions. A saved prompt, skill or policy revision travels with the next application delivery. Paseo acknowledges the message first. The runtime records the input as read once the bound timeline contains the message ID or intact delivery reference. It checks timeline replies and tool activity before continuing an interrupted input.

The exclusive state lock protects orchestrator.sqlite and paseo.sqlite. The first database stores settings, tickets and effects. The second stores bound conversation IDs, delivery receipts, notices and owned shell and child work. On reconnect the runtime verifies the original conversation identity. Prepare a new state directory when moving from the former application.

## Acceptance and cutover

Use pnpm check for typecheck, tests and both builds. With the built service, verify panel login and one harmless ticket for each project, including assessment, a worktree, an actual Paseo report, a numbered answer and recovery on restart.

Keep new Sources disabled until the old reader has stopped. Pausing the panel still allows intake. Confirm the new Paseo intake cursor starts at the current timeline end and that one new request creates one ticket. Keep the prior release and service configuration for rollback, and stop the new reader before restoring the prior one.
