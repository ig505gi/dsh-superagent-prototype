# Standalone setup

Superagent needs Node, pnpm, Git and a local Paseo daemon. In Paseo, create an Agent Profile for assessment and one for execution. Both can use any available provider that supports shell commands. The providers can differ.

## Build from GitHub

Choose the GitHub repository and revision that contain the release. Install the Node and pnpm versions listed in package.json.

~~~sh
git clone https://github.com/OWNER/dsh-superagent-prototype.git /opt/superagent
cd /opt/superagent
git switch --detach RELEASE_COMMIT
pnpm install --frozen-lockfile
pnpm check
~~~

## Start one instance per project

### System service

1. Install examples/systemd/superagent@.service as a systemd template and set its User and Group to the account running Paseo.
2. Copy each JSON and environment-file example into its own directory under /etc/superagent, such as /etc/superagent/project-a/config.json and /etc/superagent/project-a/runtime.env. Use the service group for the directories and JSON files. The deployment guide gives the install commands and ownership.
3. Run the commands below.

~~~sh
sudo install -m 0644 /opt/superagent/examples/systemd/superagent@.service /etc/systemd/system/superagent@.service
sudo systemctl daemon-reload
sudo systemctl enable --now superagent@project-a.service superagent@project-b.service
sudo systemctl status superagent@project-a.service superagent@project-b.service
sudo journalctl -u superagent@project-a.service -u superagent@project-b.service
~~~

### User service

Use the account running Paseo with lingering already enabled via `loginctl enable-linger`. This setup uses no sudo. Clone and build in `$HOME/.local/share/superagent/app`, then run these commands from that directory.

~~~sh
install -d -m 0755 "$HOME/.config/systemd/user"
install -d -m 0700 "$HOME/.config/superagent"
install -m 0644 examples/systemd/superagent-user@.service "$HOME/.config/systemd/user/"
~~~

Copy each instance's JSON and environment file to `$HOME/.config/superagent/project-a.json` and `$HOME/.config/superagent/project-a.env`, using the other instance's name for its files. Set each JSON's `stateDir` to its absolute path under `$HOME/.local/state/superagent/` and set the absolute paths to its credential files in the .env file. With a custom `XDG_STATE_HOME`, use that directory for state.

~~~sh
systemctl --user daemon-reload
systemctl --user enable --now superagent-user@project-a.service superagent-user@project-b.service
systemctl --user status superagent-user@project-a.service superagent-user@project-b.service
journalctl --user -u superagent-user@project-a.service -u superagent-user@project-b.service
~~~

Give each instance a unique ID, state directory, panel port and password file. The examples use ports 3083 and 3084. Sign in to each panel, choose Profiles under **Settings → Eval** and **Settings → Execution**, then configure the project's forge account and Sources. The panel shows any setup or main session errors. Profile choices live in that instance's SQLite database.

## Keep the projects separate

- Give each instance a different DingTalk bot application. Shared Stream credentials can cause one instance to miss events.
- Subscribe each instance to different Paseo intake conversation IDs. The daemon can be shared by both instances.
- Clone a separate base repository for each project. Set **Execution → Prepare command** to the corresponding worktree command. For the sample paths, enter `sh /opt/superagent/examples/multi-instance/prepare-worktree.sh project-a` or `sh /opt/superagent/examples/multi-instance/prepare-worktree.sh project-b`. Configure the base repository paths and default branches in the script before using it.

Test login, one harmless ticket per project, the real Paseo conversation, its report, and restart recovery. Keep replacement Sources disabled until the prior reader has stopped. Pausing processing still allows intake. The deployment guide shows the config fields, credential paths and rollback steps. [Deployment](docs/006-deployment.md)
