KCD2 Formatter Vortex Connection Helper 0.2.6

ONE-TIME SETUP
Install this ZIP through Vortex Extensions (not Mods), enable it and restart
Vortex. Keep the KCD2 game extension installed and enabled. Select the KCD2
profile and game folder matching the formatter. Update older helpers first.

NORMAL USE
Review a downloaded dependency in the formatter, then choose Install with
Vortex. The helper imports the prepared packages, installs and enables the
returned mods in the captured profile, and requests Vortex deployment.
Vortex may prompt about conflicts or permissions. Deployment may also apply
other pending changes in that profile. Keep the game closed.

Repeated installation reuses a verified formatter-managed copy instead of
adding another provider. This also restores files removed by a Vortex purge.
If the existing dependency has different contents, multiple providers, or
unverifiable ownership, installation stops before import. Resolve that update
in Vortex first; the helper does not silently remove versions used by other
profiles or choose conflict winners.

Completion requires deployment evidence and matching installed file hashes.
Vortex may omit readme, license and changelog TXT/MD documents. The helper
reports these omissions while still verifying every required runtime file.
Timeouts, profile changes and partial operations are reported for review;
requests are never silently replayed. Use Vortex to undo its own operations.
Workshop inventory is checked against the formatter's reviewed state before
each installation step. Steam updates or incomplete downloads stop further
steps and require a fresh review. A step already running inside Vortex may
finish before the change is detected; check the saved result before retrying.
Manual export/import remains available: import dependency-*.zip in Mods.

The connection is a local Windows named pipe with a per-session token stored
in your application data. It accepts bounded, hashed formatter packages only,
not arbitrary commands or game paths. It cannot protect against malicious
software already running as your Windows user. It never directly edits the
Vortex state database or automatically resolves conflicts.

Validated with real Vortex 2.9.0 and KCD2 extension 1.1.1 in an isolated test
profile: import, enable, hardlink deployment, load order, disable, purge and
redeploy. Test payloads were synthetic; gameplay and other deployment methods
remain separate checks. No third-party dependency binaries are bundled.

GPL-3.0; see LICENSE. Bundled adm-zip runtime is MIT licensed; its LICENSE
is included under node_modules/adm-zip.

Vortex one-click setup requires Hardlink Deployment, selected in Vortex Settings > Mods. Unsupported or unavailable deployment methods stop before installation; use Vortex directly for other methods.
