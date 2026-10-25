KCD2 MOD DEPENDENCY FORMATTER 1.0.0

GET STARTED
Extract this app's ZIP into a folder, then open KCD2 Mod Dependency Formatter.exe.
Keep the portable app folder together.
1. The app finds your game and checks dependencies automatically.
2. If a dependency is missing, open its author page and download the version for your game.
3. Save the author's ZIP or 7z in Downloads. Leave plugin downloads zipped;
   the app extracts supported files for you.
4. Return to the app. If the download is not listed, open Advanced options
   under Your downloads, choose Choose ZIP or 7z, and select the archive
   from Downloads or your Desktop.
5. Review the files, close KCD2, then choose Install and format files or
   Install with Vortex. The app saves recovery records before changes.

If the plugin is already installed and Files found is shown, do not reinstall
it just to follow these steps.

Hover, focus or tap the flat ? beside a button for help. Escape closes it.
Game and Dependencies are the main sections. Backup recovery is below them.
Launch game with -devmode is in the Game section.

DEPENDENCIES
Checks all deployed mod manifests and supported shared plugins. Requirements
come from declared dependencies and known framework relationships. A possible
Lua API use is a review note, not proof that a dependency is required.
Optional plugins are not automatically required. Green means files found;
red means missing, absent or incomplete; review items need your attention.
Files found does not confirm runtime loading or compatibility in the game.
Unknown native versions remain unverified even if the filename looks right.

STEAM WORKSHOP
Workshop files are detected across recorded Steam libraries, including new
downloads after the app opens. The app shows their source and an item-page
link. Files found in Steam storage do not establish that the current player
has subscribed to or enabled that item. Check activation in the game.
Pending, missing or unreadable Workshop content needs a fresh scan after
Steam finishes. The app does not rewrite Steam-owned files or add a second
local copy of a detected dependency. Native DLLs in Workshop storage may
need the author's separate installation steps because KCSE does not scan
that storage as a plugin folder.
Existing mod-order rows are preserved. Automatic creation/reordering of a
local-only list is paused while Workshop content is present, so the app
does not silently exclude it or guess Steam's order. Review order in the
game or your mod manager. Saved-log clues are historical evidence only.

Supported dependency downloads include KCSE, its Address Library, LuaUtils,
KCDUtils, LuaDB, MCM, PTF Extender, Ultimate ASI Loader, Console RPG Param and
both Sound Framework variants. The author provides separate KCSE and ASI
Sound Framework builds; use the appropriate one, keeping companion files.
The tool is not an installer for every gameplay mod or every arbitrary DLL.
A download name is only a hint. Its contents are checked before installation.
No author download or game file is bundled or downloaded automatically.

LOAD ORDER
When a valid game is found and checked, a missing Mods/mod_order.txt is created
from the complete validated local mod inventory, with a recovery record.
An existing file is never automatically replaced. If the game is running,
manager ownership is unresolved, dependencies are missing or the inventory
is incomplete, creation is deferred with an explanation. Workshop content
outside Mods requires separate management to avoid disabling those mods.

The app has no manual load-order editor. Follow the author or mod manager
instructions for changes to an existing list. Unknown rows are retained,
including Workshop entries not found locally.

A new list starts in the publisher-documented local alphabetical order.
Provider-first placement is a recommendation based on manifest dependencies
or identified framework requirements. Each relation explains its evidence;
a required dependency is not itself proof of an author's override priority.
Unrelated order is preserved. No conflict winner is invented. Position does
not prove compatibility. Comments, BOM and line endings are retained.

Undo removes only an unchanged order file created by the app, restoring its
absence. Automatic recreation is paused for that game for the rest of the
session after creation or recovery. Reopen the app to check again.

VORTEX
Reads deployed mods and reports recorded files present, missing or sharing a
file identity with staging. Staging-only files do not count as installed.
Vortex profile enable switches remain unknown; order-file enablement is a
separate state. Old records do not prove current Vortex use. Direct order
writes are deferred when records or folder markers leave ownership unclear,
because the KCD2 extension manages mod_order.txt outside deployment ledgers.
Use Vortex's intended KCD2 profile, enable mods, Deploy and use its Load Order
page, then recheck here. The app does not modify Vortex staging or state.
Disabled and omitted mods stay disabled in manager order recommendations.
Hardlinked deployed files remain observable by automatic change monitoring.

ONE-ACTION VORTEX INSTALL
Use Export connection helper once. Install its ZIP through Vortex Extensions,
enable the helper and restart Vortex. Select the intended KCD2 profile.
After reviewing a dependency archive here, Install with Vortex imports it,
enables the imported mods and requests deployment. Vortex still handles
conflicts and permissions. Deployment can apply other pending profile changes.
The tool verifies the deployed files before reporting completion, then checks
dependencies again. A timeout or uncertain result is never retried silently;
review Vortex and the saved operation record before another attempt.
Do not use manual Undo for a Vortex transaction; manage it in Vortex.
Helper 0.2.6 or newer is required. An identical verified formatter provider
is reused for repair instead of duplicated. Different versions or ambiguous
providers stop before import and must be resolved in Vortex; the formatter
does not silently remove a version used by another profile.
The local connection uses a per-session token and a Windows named pipe. It
accepts only reviewed formatter packages for the selected KCD2 installation.
It does not edit the Vortex database or bypass Vortex conflict prompts.

For a reviewed dependency archive, Export for Vortex produces separate
marked packages plus an import helper. Install the helper ZIP through Vortex
Extensions, enable it and restart Vortex before importing dependency ZIPs
through Mods. Follow INSTALL.txt and review the mod types before Deploy.
Export writes only to your chosen empty output folder; it does not install
the helper, enable mods or deploy anything. Export manual files is separate
and is intended for manually managed files.

Testing uses installed Vortex 2.9.0 / KCD2 extension 1.1.1 code and a separate
real Vortex test instance. Hardlink deployment, removal, redeployment and
change detection were verified with synthetic files. Gameplay compatibility
and other deployment methods remain untested.

BACKUPS
Undo last change reverses this app session's last change if the files still
match. Load backup version selects a saved repair record and restores its
backed-up file state after checks and confirmation. It does not change the
app executable or load a game save. Older app-created backups remain usable.
The internal storage folder keeps its former name so existing backups can
still be found. Linked or externally managed files are not edited blindly.

No gameplay-mod installation or gameplay-tweak screen is included.
Use the game yourself to confirm that your plugins work during play.

CREDITS
Elfi. GPL-3.0. Based on KCD2 Dependency Checker and attributed work from
cgize's KCD2 Inventory Preset Merger. See THIRD_PARTY_NOTICES.txt and LICENSE.

DEPENDENCY THUMBNAILS
Larger names and local author-page thumbnails identify each dependency.
Image source and creator credits: src/assets/dependencies/THUMBNAIL_SOURCES.txt
No internet connection is needed to display these bundled images.

DEPENDENCY ALERTS AND MOD CHANGES
After you choose a game and check dependencies, the app checks mod-file
metadata every five seconds while it is open, and when you return to it.
Two matching change checks trigger a fresh read-only dependency scan.
There is no background service when this app is closed.

A strong red notice names missing required dependencies and the mods that
need them. Each supported dependency has an author-page download option.
Choose downloaded ZIP or 7z reviews your file before installation. Nothing
is downloaded, installed or enabled automatically.

New mods left out of the current mod list are checked too. Their future
requirements are labelled as needed before enabling the mod, including
framework requirements such as MCM -> KCSE -> Address Library. Optional
requirements alone do not trigger a missing-required alert. Unknown targets
show manual author guidance instead of an invented download link. Existing
versions needing verification, incomplete files and excluded providers get
separate guidance. ASI loader notices explain the supported loader choice.

When mods change, old install and mod-list previews become stale. Their
text stays visible for reference, but you must review again before applying.
The app does not scroll to an alert, steal desktop focus, play a sound, open
a system notification or change game files during these checks. Checks wait
while files are incomplete, linked, unreadable or outside scan limits. Use
Check dependencies after resolving those issues or if monitoring is paused.

Vortex one-click setup requires Hardlink Deployment, selected in Vortex Settings > Mods. Unsupported or unavailable deployment methods stop before installation; use Vortex directly for other methods.

Reliability update 1.0.3: automatic monitoring detects newly registered Steam libraries and nested Workshop payload changes. If monitoring cannot finish, a visible notice marks results as potentially out of date and reviewed changes must be checked again. Recovery triggers a fresh scan. Vortex helper 0.2.6 rechecks the selected profile and deployment settings after asynchronous checks and immediately before each operation.

AUTOMATIC SETUP ASSISTANCE
The app remembers your successfully checked game and chosen downloads folder. It reconnects to Vortex in the background. One completed download clearly matching a missing required dependency is checked automatically; multiple versions stay yours to choose. The recommended install button selects Vortex for a managed setup or connected profile, otherwise manual formatting. Workshop activation remains managed by Steam and the game. Installations, existing load-order changes and gameplay tweaks still need your review.

SIMPLIFIED CONTROLS
Automatic checks need no routine button presses. Choose game appears until a game is checked. Retry check appears if a check fails or monitoring cannot finish. Manual scanning, folder selection, connection checks, exports and recovery remain under Advanced options. Launch game with -devmode stays in the Game section. Required downloads and the recommended install action stay visible.

The launch button stays disabled while scanning, checking downloads, reconnecting to Vortex or checking mod changes. It reads Checking setup until these checks finish.

Game section shows automatic scan progress, readiness, and named missing dependencies or setup issues. Readiness covers supported file checks, not gameplay verification.

Workshop downloads: one matching author archive for a declared conditional Workshop dependency or misplaced native plugin is reviewed automatically after Steam downloads finish. Install uses existing manual/Vortex guarded route. Never copies Workshop payloads or changes subscriptions/activation automatically. Steam enables subscribed mods on launch by default; custom mod_order.txt may exclude them.

LANGUAGES
Choose your language in the header. The app remembers your choice and works offline.
English, Czech, German, French, Spanish, Italian, Polish, Russian, Brazilian Portuguese, Simplified Chinese, Japanese, Korean and Turkish.
Mod names, paths, identifiers and original technical log output are preserved. Unrecognized third-party diagnostics remain in their original language.

DOWNLOAD SEARCH
Checks Downloads, Desktop and Documents first (including redirected Windows folders and ordinary home-folder locations). A manually chosen folder takes priority. Then checks one level inside folders named for mods, plugins, dependencies, archives, downloads or KCD/Kingdom Come. Search is bounded to 24 folders and 96 archive observations; it does not crawl the whole PC or follow links. Finds supported ZIP/7z downloads, not arbitrary loose DLLs. Finding an archive does not mean its plugin is installed. Duplicate versions remain a user choice.

Extracted dependencies: Supported extracted dependency folders in Downloads, Desktop or Documents can also be detected. For other locations or folder names, use Advanced options > Choose extracted folder. Select the dependency folder, review the proposed files, then confirm installation. ZIP/7z downloads do not need extraction. Original source folders are left in place.
